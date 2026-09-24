import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent, makeTenant } from './factories.js';
import { candidateRouter } from '../src/modules/candidates/candidate.routes.js';
import { catalogueRouter } from '../src/modules/admin/catalogue.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { uploadDir } from '../src/modules/tenants/assets.js';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * What a verified student may still change about themselves.
 *
 * Freezing used to stop every write, which sounded like a strong guarantee
 * and was really just a profile nobody could finish: five of the six
 * completion sections are the student's own, so a verified student was capped
 * at the one section their college fills in - and then told by every screen to
 * complete their profile.
 *
 * What a college vouches for still cannot move. That is the line these hold.
 */

const servers: Server[] = [];
const written: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  // Uploads land on disk for real; files left behind make the next run's
  // failures harder to read.
  for (const name of written.splice(0)) await rm(`${uploadDir()}/${name}`, { force: true });
});

/** The smallest thing that is really a PDF: the bytes are what is judged. */
const PDF = Buffer.from(
  ['%PDF-1.4', '1 0 obj<</Type/Catalog>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF', ''].join('\n'),
);

/**
 * The text a PDF actually draws.
 *
 * pdfkit compresses its content streams and writes the text as hex inside
 * them, so reading it back means inflating and decoding - which is the only
 * way to assert on what a layout put on the page rather than on its size.
 *
 * Words come back run together, which is fine for asking whether a heading
 * is on the page and no use at all for reading it back as prose.
 */
function textOf(pdf: Buffer): string {
  const out: string[] = [];
  const streams = new RegExp('stream\\r?\\n([\\s\\S]*?)\\nendstream', 'g');
  for (const m of pdf.toString('latin1').matchAll(streams)) {
    let body: Buffer;
    try {
      body = inflateSync(Buffer.from(m[1]!, 'latin1'));
    } catch {
      continue;
    }
    for (const hex of body.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>/g)) {
      out.push(Buffer.from(hex[1]!, 'hex').toString('latin1'));
    }
  }
  /*
   * Joined without separators on purpose. pdfkit splits a word across several
   * hex runs to apply kerning, so "CONTACT" arrives as "CONT", "A", "CT" -
   * putting spaces between them would invent gaps that are not on the page.
   */
  return out.join('');
}

type Session = Partial<SessionData>;

function appFor(candidateId: string, userId: string, tenantId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = {
      userId,
      role: Role.CANDIDATE,
      candidateId,
      tenantId,
    } as Session;
    next();
  });
  app.use('/candidate', candidateRouter);
  app.use('/catalogue', catalogueRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  // The port rides along for the one test that posts a file rather than JSON.
  return Object.assign(call, { port });
}

/** A student their college has verified, with marks on record. */
async function verifiedStudent() {
  const college = await makeCollege();
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id, frozen: true });
  await db.candidate.update({
    where: { id: candidate.id },
    data: { cgpa: 8.4, tenthPct: 88, twelfthPct: 82, graduationYear: 2026 },
  });
  const call = appFor(candidate.id, user.id);
  return { call, candidateId: candidate.id, port: call.port };
}

describe('a verified student and their own details', () => {
  it('saves the things a college never vouched for', async () => {
    const { call, candidateId } = await verifiedStudent();

    const res = await call('PATCH', '/candidate/profile', {
      phone: '9000000001',
      headline: 'Final-year CSE, backend and databases',
      about: 'I like building things that stay up.',
      resumeUrl: 'https://drive.google.com/demo-resume',
    });

    expect(res.status).toBe(200);
    const saved = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(saved.phone).toBe('9000000001');
    expect(saved.resumeUrl).toBe('https://drive.google.com/demo-resume');
  });

  it('takes their skills and their own projects', async () => {
    const { call, candidateId } = await verifiedStudent();

    expect((await call('PUT', '/candidate/skills', { skills: ['Python', 'React', 'SQL'] })).status).toBe(200);
    expect(
      (await call('POST', '/candidate/projects', { title: 'Timetable planner', description: 'A scheduler.' }))
        .status,
    ).toBe(201);

    expect(await db.candidateSkill.count({ where: { candidateId } })).toBe(3);
    expect(await db.project.count({ where: { candidateId } })).toBe(1);
  });

  it('lets them actually finish, which is the whole point', async () => {
    const { call } = await verifiedStudent();

    await call('PATCH', '/candidate/profile', {
      phone: '9000000001',
      resumeUrl: 'https://drive.google.com/demo-resume',
    });
    await call('PUT', '/candidate/skills', { skills: ['Python', 'React', 'SQL'] });
    await call('POST', '/candidate/projects', { title: 'Timetable planner' });

    const res = await call('GET', '/candidate/profile');
    const done = (key: string) =>
      res.body.profile.completion.sections.find((s: { key: string }) => s.key === key).done;

    expect(done('basics')).toBe(true);
    expect(done('skills')).toBe(true);
    expect(done('evidence')).toBe(true);
    expect(done('resume')).toBe(true);
    // Previously stuck at the one section the college fills in.
    expect(res.body.profile.completion.percent).toBeGreaterThan(15);
  });

  /*
   * The six weights add up to 105, so a finished profile used to report 105%.
   * It went unseen because a verified student could never finish one.
   */
  it('never reports more than a whole profile', async () => {
    const { call, candidateId } = await verifiedStudent();

    await call('PATCH', '/candidate/profile', {
      phone: '9000000001',
      resumeUrl: 'https://drive.google.com/demo-resume',
    });
    await call('PUT', '/candidate/skills', { skills: ['Python', 'React', 'SQL'] });
    await call('POST', '/candidate/projects', { title: 'Timetable planner' });
    await db.education.create({
      data: { candidateId, degree: 'B.Tech', institution: 'Demo College', startYear: 2022 },
    });

    const res = await call('GET', '/candidate/profile');

    expect(res.body.profile.completion.sections.every((s: { done: boolean }) => s.done)).toBe(true);
    expect(res.body.profile.completion.percent).toBe(100);
  });
});

describe('what a college vouched for', () => {
  it('refuses a change to the graduating year', async () => {
    const { call, candidateId } = await verifiedStudent();

    const res = await call('PATCH', '/candidate/profile', { phone: '9000000001', graduationYear: 2031 });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/locked/i);
    const after = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(after.graduationYear).toBe(2026);
    // The refusal is total: nothing in the block is written.
    expect(after.phone).not.toBe('9000000001');
  });

  it('refuses a change to the marks', async () => {
    const { call, candidateId } = await verifiedStudent();

    const res = await call('PATCH', '/candidate/profile', { cgpa: 9.9 });

    expect(res.status).toBe(409);
    expect(Number((await db.candidate.findUniqueOrThrow({ where: { id: candidateId } })).cgpa)).toBe(8.4);
  });

  it('allows a save that sends the verified values back unchanged', async () => {
    const { call } = await verifiedStudent();

    // The form posts the whole block every time, marks included. Refusing
    // that would stop a student editing their own phone number.
    const res = await call('PATCH', '/candidate/profile', {
      phone: '9000000002',
      graduationYear: 2026,
      cgpa: 8.4,
      tenthPct: 88,
      twelfthPct: 82,
    });

    expect(res.status).toBe(200);
  });

  /*
   * The bug this pins: `?? null` meant a block that left the marks out
   * cleared them, so saving a phone number wiped what a college had verified
   * and a recruiter filters on.
   */
  it('does not clear the marks when a save simply does not mention them', async () => {
    const { call, candidateId } = await verifiedStudent();

    await call('PATCH', '/candidate/profile', { phone: '9000000001' });

    const after = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(Number(after.cgpa)).toBe(8.4);
    expect(Number(after.tenthPct)).toBe(88);
    expect(after.graduationYear).toBe(2026);
  });

  it('holds for a student nobody has verified yet, who owns all of it', async () => {
    const college = await makeCollege();
    const batch = await makeBatch(college.id);
    const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id, frozen: false });
    const call = appFor(candidate.id, user.id);

    const res = await call('PATCH', '/candidate/profile', { phone: '9000000003', graduationYear: 2027 });

    expect(res.status).toBe(200);
    const after = await db.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(after.graduationYear).toBe(2027);
  });
});

/**
 * Skills are the one list both sides of the platform share. A student's
 * "Node.js" and a role asking for "Node.js" meet only because they are the
 * same row, so a second spelling is a skill that quietly matches nobody.
 */
describe('a student picking their skills', () => {
  it('reuses a skill the portal already knows, whatever they typed', async () => {
    const { call, candidateId } = await verifiedStudent();
    await db.skill.create({ data: { name: 'Node.js' } });

    await call('PUT', '/candidate/skills', { skills: ['  nOdE.js  '] });

    // One row, still spelt the way the catalogue spells it.
    expect(await db.skill.count()).toBe(1);
    const mine = await db.candidateSkill.findMany({
      where: { candidateId },
      include: { skill: true },
    });
    expect(mine.map((m) => m.skill.name)).toEqual(['Node.js']);
  });

  it('lets them add something the portal has never heard of', async () => {
    const { call } = await verifiedStudent();

    await call('PUT', '/candidate/skills', { skills: ['Rust  Lang'] });

    // Created, with its spacing tidied the way operations tidies its own.
    expect((await db.skill.findMany()).map((s) => s.name)).toEqual(['Rust Lang']);
  });

  it('does not add one skill twice because it was typed two ways', async () => {
    const { call, candidateId } = await verifiedStudent();

    await call('PUT', '/candidate/skills', { skills: ['Python', 'python', 'PYTHON'] });

    expect(await db.skill.count()).toBe(1);
    expect(await db.candidateSkill.count({ where: { candidateId } })).toBe(1);
  });

  it('offers the shared list to whoever is signed in', async () => {
    await db.skill.createMany({ data: [{ name: 'Python' }, { name: 'React' }] });
    const { call } = await verifiedStudent();

    const res = await call('GET', '/catalogue');

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual(['Python', 'React']);
  });
});

describe('the lists a profile form offers', () => {
  it('offers this student their own university colleges and no other institution’s', async () => {
    const mine = await makeTenant('Demo University');
    const theirs = await makeTenant('Another University');
    const home = await makeCollege('Demo College of Engineering', mine.id);
    await makeCollege('Demo Institute of Technology', mine.id);
    await makeCollege('Rival College', theirs.id);

    const batch = await makeBatch(home.id);
    const { user, candidate } = await makeStudent(batch.id, { collegeId: home.id });
    const call = appFor(candidate.id, user.id, mine.id);

    const res = await call('GET', '/catalogue');

    expect(res.status).toBe(200);
    expect(res.body.colleges).toEqual([
      'Demo College of Engineering',
      'Demo Institute of Technology',
    ]);
    // A college is the institution's, unlike courses or skills, which are
    // the platform's and the same everywhere.
    expect(res.body.colleges).not.toContain('Rival College');
  });

  it('carries the names only, not what runs the college', async () => {
    const tenant = await makeTenant('Demo University');
    const home = await makeCollege('Demo College of Engineering', tenant.id);
    const batch = await makeBatch(home.id);
    const { user, candidate } = await makeStudent(batch.id, { collegeId: home.id });

    const res = await appFor(candidate.id, user.id, tenant.id)('GET', '/catalogue');

    expect(res.body.colleges).toEqual(['Demo College of Engineering']);
    expect(typeof res.body.colleges[0]).toBe('string');
  });
});

/**
 * A project is routinely in several places at once - the repository, a live
 * demo, a write-up. One column made a student choose which of those a
 * recruiter got to follow.
 */
describe('the links on a project', () => {
  it('keeps every one of them, in the order they were given', async () => {
    const { call, candidateId } = await verifiedStudent();

    const res = await call('POST', '/candidate/projects', {
      title: 'Campus bus tracker',
      links: [
        { url: 'https://github.com/example/bus-tracker', label: 'Repository' },
        { url: 'https://example.com/demo', label: 'Live demo' },
        { url: 'https://example.com/writeup' },
      ],
    });

    expect(res.status).toBe(201);
    const [project] = await db.project.findMany({ where: { candidateId } });
    expect(project!.links).toEqual([
      { url: 'https://github.com/example/bus-tracker', label: 'Repository' },
      { url: 'https://example.com/demo', label: 'Live demo' },
      // A label nobody typed is dropped rather than stored empty.
      { url: 'https://example.com/writeup' },
    ]);
  });

  it('takes a project with nowhere to look at it yet', async () => {
    const { call, candidateId } = await verifiedStudent();

    const res = await call('POST', '/candidate/projects', { title: 'Not published yet' });

    expect(res.status).toBe(201);
    const [project] = await db.project.findMany({ where: { candidateId } });
    expect(project!.links).toEqual([]);
  });

  it('refuses something that is not a link, and says which one', async () => {
    const { call } = await verifiedStudent();

    const res = await call('POST', '/candidate/projects', {
      title: 'Bad',
      links: [{ url: 'https://fine.example' }, { url: 'notaurl' }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.fields[0].path).toBe('links.1.url');
  });

  it('refuses more links than a project shows', async () => {
    const { call } = await verifiedStudent();

    const res = await call('POST', '/candidate/projects', {
      title: 'Many',
      links: Array.from({ length: 7 }, (_, i) => ({ url: `https://${i}.example` })),
    });

    expect(res.status).toBe(400);
  });

  it('reads back rubbish in the column as no links, not as a broken one', async () => {
    const { call, candidateId } = await verifiedStudent();
    await call('POST', '/candidate/projects', { title: 'Odd' });
    // Whatever a past write may have left there.
    await db.$executeRawUnsafe(
      `UPDATE \`Project\` SET \`links\` = JSON_ARRAY(JSON_OBJECT('nope', 1)) WHERE candidateId = ?`,
      candidateId,
    );

    const res = await call('GET', '/candidate/profile');

    expect(res.body.profile.projects[0].links).toEqual([]);
  });
});

describe('a resume', () => {
  async function upload(port: number, file: Buffer, filename = 'resume.pdf') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)]), filename);
    const res = await fetch(`http://127.0.0.1:${port}/candidate/resume`, { method: 'POST', body: form });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json().catch(() => null)) as any;
    if (json?.url) written.push(String(json.url).split('/').pop()!);
    return { status: res.status, body: json };
  }

  it('stores a PDF and hands back an address we minted', async () => {
    const { call, port } = await verifiedStudent();

    const res = await upload(port, PDF);

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/api\/files\/resume-[a-f0-9]{24}\.pdf$/);

    // And the profile takes it, which a plain url() check would refuse.
    const saved = await call('PATCH', '/candidate/profile', { resumeUrl: res.body.url });
    expect(saved.status).toBe(200);
    expect(saved.body.profile.resumeUrl).toBe(res.body.url);
  });

  it('refuses a file that is not a PDF, whatever it is called', async () => {
    const { port } = await verifiedStudent();

    const res = await upload(port, Buffer.from('MZ not a pdf at all'), 'resume.pdf');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/PDF/i);
  });

  it('still takes a link they host themselves', async () => {
    const { call } = await verifiedStudent();

    const res = await call('PATCH', '/candidate/profile', {
      resumeUrl: 'https://drive.google.com/demo-resume',
    });

    expect(res.status).toBe(200);
  });

  it('refuses an address we did not mint, and anything not https', async () => {
    const { call } = await verifiedStudent();

    for (const resumeUrl of [
      '/api/files/../../etc/passwd',
      'http://demo.example/resume.pdf',
      'javascript:alert(1)',
    ]) {
      const res = await call('PATCH', '/candidate/profile', { resumeUrl });
      expect(res.status, resumeUrl).toBe(400);
    }
  });
});

/**
 * The builder makes a resume out of what is already on the profile, which is
 * the whole point: a campus student's marks, education, projects and skills
 * are on here because a recruiter filters on them, so none of it is typed a
 * second time.
 */
describe('building a resume from the profile', () => {
  async function filled() {
    const made = await verifiedStudent();
    await made.call('PATCH', '/candidate/profile', {
      phone: '9000000001',
      headline: 'Final-year CSE student',
      about: 'A paragraph about me.',
    });
    await made.call('PUT', '/candidate/skills', { skills: ['Python', 'SQL'] });
    await made.call('POST', '/candidate/projects', {
      title: 'Campus bus tracker',
      links: [{ url: 'https://github.com/example/bus', label: 'Repository' }],
    });
    await db.education.create({
      data: {
        candidateId: made.candidateId,
        degree: 'B.Tech',
        institution: 'Demo College',
        startYear: 2022,
        endYear: 2026,
      },
    });
    return made;
  }

  it('produces a PDF and makes it their resume in one step', async () => {
    const { call, candidateId } = await filled();

    const res = await call('POST', '/candidate/resume/build', {});

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/api\/files\/resume-[a-f0-9]{24}\.pdf$/);
    written.push(res.body.url.split('/').pop()!);

    // Built and used: a student who pressed Build has said what they want.
    const saved = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(saved.resumeUrl).toBe(res.body.url);
    expect(res.body.profile.resumeUrl).toBe(res.body.url);
  });

  it('remembers what they chose, so coming back is not starting again', async () => {
    const { call, candidateId } = await filled();

    const res = await call('POST', '/candidate/resume/build', {
      summary: 'Two lines in my own words.',
      sections: ['summary', 'projects'],
      showMarks: false,
    });
    written.push(res.body.url.split('/').pop()!);

    const saved = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(saved.resumeBuild).toEqual({
      summary: 'Two lines in my own words.',
      sections: ['summary', 'projects'],
      showMarks: false,
    });
  });

  it('previews the same PDF without storing anything', async () => {
    const { call, candidateId } = await filled();
    const before = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });

    const res = await fetch(`http://127.0.0.1:${call.port}/candidate/resume/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: 'sidebar' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // A student trying layouts is not making a decision yet.
    const after = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(after.resumeUrl).toBe(before.resumeUrl);
    expect(after.resumeBuild).toEqual(before.resumeBuild);
  });

  it('draws each layout differently, and remembers which was chosen', async () => {
    const { call, candidateId } = await filled();

    const drawn = new Map<string, string>();
    for (const layout of ['classic', 'compact', 'sidebar']) {
      const res = await fetch(`http://127.0.0.1:${call.port}/candidate/resume/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout }),
      });
      drawn.set(layout, textOf(Buffer.from(await res.arrayBuffer())));
    }

    /*
     * What is drawn, not how many bytes it took.
     *
     * Comparing lengths made this flaky: two layouts of a short profile can
     * come to the same size by coincidence, which says nothing about whether
     * they are the same layout.
     */
    expect(drawn.get('sidebar')).toContain('CONTACT');
    expect(drawn.get('classic')).not.toContain('CONTACT');
    // The sidebar lists skills down the left instead of as a section.
    expect(drawn.get('classic')).toContain('SKILLS');
    expect(new Set(drawn.values()).size).toBeGreaterThan(1);

    const built = await call('POST', '/candidate/resume/build', { layout: 'sidebar' });
    written.push(built.body.url.split('/').pop()!);
    const saved = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect((saved.resumeBuild as { layout?: string }).layout).toBe('sidebar');
  });

  it('refuses a layout it cannot draw', async () => {
    const { call } = await filled();

    const res = await call('POST', '/candidate/resume/build', { layout: 'neon' });

    expect(res.status).toBe(400);
  });

  it('refuses a section it cannot draw', async () => {
    const { call } = await filled();

    const res = await call('POST', '/candidate/resume/build', { sections: ['astrology'] });

    expect(res.status).toBe(400);
  });
});

/*
 * The bug this pins: every field in the basics block was written on every
 * save, so a block that mentioned only one of them cleared the rest. Saving
 * a resume link wiped the phone number, the headline and the marks with it.
 */
describe('saving one field', () => {
  it('leaves the fields the save did not mention alone', async () => {
    const { call, candidateId } = await verifiedStudent();
    await call('PATCH', '/candidate/profile', {
      phone: '9000000001',
      headline: 'Final-year CSE student',
      about: 'A paragraph about me.',
      gender: 'Female',
    });

    await call('PATCH', '/candidate/profile', { resumeUrl: 'https://drive.google.com/demo' });

    const after = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(after.phone).toBe('9000000001');
    expect(after.headline).toBe('Final-year CSE student');
    expect(after.about).toBe('A paragraph about me.');
    expect(after.gender).toBe('Female');
    expect(after.resumeUrl).toBe('https://drive.google.com/demo');
  });

  it('still clears a field that was sent empty', async () => {
    const { call, candidateId } = await verifiedStudent();
    await call('PATCH', '/candidate/profile', { phone: '9000000001' });

    await call('PATCH', '/candidate/profile', { phone: '' });

    expect((await db.candidate.findUniqueOrThrow({ where: { id: candidateId } })).phone).toBeNull();
  });
});

/**
 * A student applying for two kinds of role writes two kinds of resume. The
 * portal used to overwrite the first with the second and leave the first on
 * disk with nothing pointing at it.
 */
describe('the resumes a student keeps', () => {
  it('keeps each one built, rather than replacing the last', async () => {
    const { call, candidateId } = await verifiedStudent();

    const a = await call('POST', '/candidate/resume/build', { layout: 'classic', name: 'For backend' });
    const b = await call('POST', '/candidate/resume/build', { layout: 'compact', name: 'For analytics' });
    written.push(a.body.url.split('/').pop()!, b.body.url.split('/').pop()!);

    const list = await call('GET', '/candidate/resumes');
    expect(list.body.resumes.map((r: { name: string }) => r.name)).toEqual(['For analytics', 'For backend']);

    // The newest is the one in use, which is what pressing Build meant.
    const saved = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(saved.resumeUrl).toBe(b.body.url);
  });

  it('switches which one an application would carry', async () => {
    const { call, candidateId } = await verifiedStudent();
    const a = await call('POST', '/candidate/resume/build', { name: 'For backend' });
    const b = await call('POST', '/candidate/resume/build', { name: 'For analytics' });
    written.push(a.body.url.split('/').pop()!, b.body.url.split('/').pop()!);

    const res = await call('PATCH', `/candidate/resumes/${a.body.resume.id}`, { use: true });

    expect(res.status).toBe(200);
    expect((await db.candidate.findUniqueOrThrow({ where: { id: candidateId } })).resumeUrl).toBe(a.body.url);
  });

  it('takes the file with it when one is deleted', async () => {
    const { call } = await verifiedStudent();
    const a = await call('POST', '/candidate/resume/build', { name: 'Spare' });
    const name = a.body.url.split('/').pop()!;

    expect(existsSync(`${uploadDir()}/${name}`)).toBe(true);
    await call('DELETE', `/candidate/resumes/${a.body.resume.id}`);

    // Nothing points at it any more, so it does not sit on disk for ever.
    expect(existsSync(`${uploadDir()}/${name}`)).toBe(false);
  });

  it('falls back to what is left when the one in use is deleted', async () => {
    const { call, candidateId } = await verifiedStudent();
    const a = await call('POST', '/candidate/resume/build', { name: 'Older' });
    const b = await call('POST', '/candidate/resume/build', { name: 'Newer' });
    written.push(a.body.url.split('/').pop()!);

    await call('DELETE', `/candidate/resumes/${b.body.resume.id}`);

    // A profile with resumes on it should not end up pointing at none.
    expect((await db.candidate.findUniqueOrThrow({ where: { id: candidateId } })).resumeUrl).toBe(a.body.url);
  });

  it('leaves another student resumes alone', async () => {
    const mine = await verifiedStudent();
    const theirs = await verifiedStudent();
    const a = await theirs.call('POST', '/candidate/resume/build', { name: 'Theirs' });
    written.push(a.body.url.split('/').pop()!);

    const res = await mine.call('DELETE', `/candidate/resumes/${a.body.resume.id}`);

    expect(res.status).toBe(404);
    expect(await db.resume.count({ where: { candidateId: theirs.candidateId } })).toBe(1);
  });

  it('adds an uploaded PDF to the same list', async () => {
    const { call, port } = await verifiedStudent();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(PDF)]), 'My CV.pdf');
    const res = await fetch(`http://127.0.0.1:${port}/candidate/resume`, { method: 'POST', body: form });
    const body = (await res.json()) as { url: string; resume: { name: string; source: string } };
    written.push(body.url.split('/').pop()!);

    expect(body.resume.source).toBe('UPLOADED');
    // Named after the file they chose, which is what they will recognise.
    expect(body.resume.name).toBe('My CV');

    const list = await call('GET', '/candidate/resumes');
    expect(list.body.resumes).toHaveLength(1);
  });
});
