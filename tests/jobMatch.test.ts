import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { JobStatus, PostingStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeDrive, makeRecruiter, makeStudent } from './factories.js';
import { studentJobsRouter } from '../src/modules/candidates/studentJobs.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Which of the roles a student may apply to are worth reading first.
 *
 * Everything they can see is already one they are eligible for - the
 * visibility query saw to that - so this is not eligibility again. It is the
 * ordering question a student actually has, and the reasons matter more than
 * the number: a suggestion nobody can argue with is one nobody can act on.
 */

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/candidate/jobs', studentJobsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  async function call(path: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  // The port rides along for the tests that post rather than read.
  return Object.assign(call, { port });
}

/** A verified student in an open drive, with the skills they claim. */
async function studentWith(skills: string[]) {
  const college = await makeCollege();
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id, frozen: true });

  for (const name of skills) {
    const skill = await db.skill.upsert({ where: { name }, update: {}, create: { name } });
    await db.candidateSkill.create({ data: { candidateId: candidate.id, skillId: skill.id } });
  }

  return {
    call: appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id }),
    driveId: drive.id,
    candidateId: candidate.id,
  };
}

/** A published role in that drive, asking for these skills. */
async function roleAsking(
  driveId: string,
  title: string,
  asks: { name: string; required?: boolean }[],
  deadlineDays = 30,
) {
  const company = await makeCompany();
  const owner = await makeRecruiter(company.id);

  const job = await db.job.create({
    data: {
      companyId: company.id,
      createdById: owner.id,
      title,
      description: 'A role.',
      deadline: new Date(Date.now() + deadlineDays * 86_400_000),
      status: JobStatus.PUBLISHED,
      publishedAt: new Date(),
      openToAll: true,
      skills: {
        create: await Promise.all(
          asks.map(async (a) => ({
            skillId: (await db.skill.upsert({ where: { name: a.name }, update: {}, create: { name: a.name } })).id,
            isRequired: a.required ?? false,
          })),
        ),
      },
    },
  });

  await db.jobPosting.create({
    data: { jobId: job.id, placementId: driveId, status: PostingStatus.ACCEPTED, decidedAt: new Date() },
  });

  return job;
}

describe('how well a role matches a student', () => {
  it('scores on the skills they already have, and says so', async () => {
    const { call, driveId } = await studentWith(['Python', 'SQL']);
    await roleAsking(driveId, 'Data role', [{ name: 'Python' }, { name: 'SQL' }, { name: 'Spark' }]);

    const res = await call('/candidate/jobs');
    const [job] = res.body.jobs;

    expect(job.match.have.sort()).toEqual(['Python', 'SQL']);
    expect(job.match.missing).toEqual(['Spark']);
    // The reason is the point: a number nobody can interrogate is no help.
    expect(job.match.reasons.join(' ')).toContain('2 of the 3 skills');
  });

  it('puts the closer match first', async () => {
    const { call, driveId } = await studentWith(['Python', 'SQL']);
    await roleAsking(driveId, 'Far', [{ name: 'Rust' }, { name: 'Go' }]);
    await roleAsking(driveId, 'Near', [{ name: 'Python' }, { name: 'SQL' }]);

    const res = await call('/candidate/jobs');
    const byScore = [...res.body.jobs].sort((a: { match: { score: number } }, b: { match: { score: number } }) => b.match.score - a.match.score);

    expect(byScore[0].title).toBe('Near');
    expect(byScore[0].match.score).toBeGreaterThan(byScore[1].match.score);
  });

  it('credits having everything the role will not bend on', async () => {
    const { call, driveId } = await studentWith(['Python']);
    await roleAsking(driveId, 'Strict', [{ name: 'Python', required: true }, { name: 'Spark' }]);

    const res = await call('/candidate/jobs');

    expect(res.body.jobs[0].match.reasons.join(' ')).toContain('every skill it marks as required');
  });

  /*
   * Nothing to compare is not the same as a bad match, and scoring it as one
   * gave a zero on every role to the students who most need the suggestions.
   */
  it('does not score a student who has listed no skills at all', async () => {
    const { call, driveId } = await studentWith([]);
    await roleAsking(driveId, 'Role', [{ name: 'Rust' }, { name: 'Go' }]);

    const res = await call('/candidate/jobs');

    expect(res.body.jobs[0].match.score).toBeGreaterThan(0);
    expect(res.body.jobs[0].match.reasons.join(' ')).toContain('Add your skills');
  });

  it('does not bury a role that asks for nothing in particular', async () => {
    const { call, driveId } = await studentWith(['Python']);
    await roleAsking(driveId, 'Open', []);

    const res = await call('/candidate/jobs');

    expect(res.body.jobs[0].match.score).toBeGreaterThan(0);
    expect(res.body.jobs[0].match.reasons.join(' ')).toContain('does not ask for particular skills');
  });

  it('says when one is about to close', async () => {
    const { call, driveId } = await studentWith(['Python']);
    await roleAsking(driveId, 'Closing', [{ name: 'Python' }], 3);

    const res = await call('/candidate/jobs');

    // Not an exact number: a deadline three days out is two-and-a-bit days
    // away by the time it is counted, and that is not what this is about.
    expect(res.body.jobs[0].match.reasons.join(' ')).toMatch(/Closes in \d+ days?/);
  });

  it('matches a skill however it was typed', async () => {
    const { call, driveId } = await studentWith(['node.js']);
    await roleAsking(driveId, 'Backend', [{ name: 'Node.js' }]);

    const res = await call('/candidate/jobs');

    /*
     * One row on both sides, so casing is not what decides a match. Which
     * spelling comes back is whichever reached the catalogue first - the
     * point is that it counted, not how it is capitalised.
     */
    expect(res.body.jobs[0].match.have).toHaveLength(1);
    expect(res.body.jobs[0].match.have[0].toLowerCase()).toBe('node.js');
    expect(res.body.jobs[0].match.missing).toEqual([]);
  });

  it('sends the skills a role asks for, so the gap can be shown', async () => {
    const { call, driveId } = await studentWith(['Python']);
    await roleAsking(driveId, 'Data role', [{ name: 'Python' }, { name: 'Spark' }]);

    const res = await call('/candidate/jobs');

    expect(res.body.jobs[0].skills.sort()).toEqual(['Python', 'Spark']);
  });
});

/**
 * What a round says before anybody has applied.
 *
 * When and where is arranged per student after they are shortlisted, so a
 * date and a hall shown on the advertisement is a slot most readers will
 * never be given - and wrong the moment the company moves it.
 */
describe('how much of the process a student is shown', () => {
  it('gives the shape of it, and none of the logistics', async () => {
    const { call, driveId } = await studentWith([]);
    const job = await roleAsking(driveId, 'Role', []);
    await db.round.create({
      data: {
        jobId: job.id,
        order: 1,
        name: 'Technical interview',
        type: 'LIVE_INTERVIEW',
        isOnline: false,
        scheduledAt: new Date(),
        venue: 'Seminar hall 2',
        addressLine: 'Level 4, Demo Tech Park',
        meetingLink: 'https://meet.google.com/demo',
        durationMin: 45,
      },
    });

    const res = await call(`/candidate/jobs/${job.id}`);
    const [round] = res.body.job.rounds;

    // How many, what kind, and whether they travel or open a link.
    expect(round.name).toBe('Technical interview');
    expect(round.isOnline).toBe(false);
    expect(res.body.job.roundCount).toBe(1);

    // Not where, not when, not the link.
    expect(round.scheduledAt).toBeUndefined();
    expect(round.venue).toBeUndefined();
    expect(round.addressLine).toBeUndefined();
    expect(round.meetingLink).toBeUndefined();
  });

  it('hands them over once the student is in the process', async () => {
    const { call, driveId, candidateId } = await studentWith([]);
    const job = await roleAsking(driveId, 'Role', []);
    await db.round.create({
      data: { jobId: job.id, order: 1, name: 'Interview', type: 'LIVE_INTERVIEW', venue: 'Seminar hall 2' },
    });
    const placement = await db.jobPosting.findFirstOrThrow({ where: { jobId: job.id } });
    await db.application.create({
      data: { candidateId, jobId: job.id, placementId: placement.placementId, status: 'APPLIED' },
    });

    const res = await call(`/candidate/jobs/${job.id}`);

    expect(res.body.job.rounds[0].venue).toBe('Seminar hall 2');
  });
});

/**
 * Which resume an application carried.
 *
 * A student may keep several and change which is current. Reading their
 * current one meant an application quietly changed what it carried whenever
 * they switched - so a recruiter could open a different document from the one
 * they were actually sent.
 */
describe('the resume an application carries', () => {
  async function applicant() {
    const made = await studentWith([]);
    const job = await roleAsking(made.driveId, 'Role', []);
    const mk = async (name: string) =>
      db.resume.create({
        data: {
          candidateId: made.candidateId,
          name,
          url: `/api/files/resume-${name.length}${'a'.repeat(23)}.pdf`,
          source: 'BUILT',
        },
      });
    return { ...made, job, mk };
  }

  it('sends the one they picked, and freezes it', async () => {
    const { call, candidateId, job, mk } = await applicant();
    const backend = await mk('Backend');
    const analytics = await mk('Analytics');
    await db.candidate.update({ where: { id: candidateId }, data: { resumeUrl: backend.url } });

    const res = await fetch(`http://127.0.0.1:${call.port}/candidate/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, resumeId: analytics.id }),
    });
    expect(res.status).toBe(201);

    const app = await db.application.findFirstOrThrow({ where: { candidateId, jobId: job.id } });
    expect(app.resumeUrl).toBe(analytics.url);

    // Their current one is untouched, because they did not ask for that.
    const me = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(me.resumeUrl).toBe(backend.url);
  });

  it('keeps the choice as their default when they ask it to', async () => {
    const { call, candidateId, job, mk } = await applicant();
    const backend = await mk('Backend');
    const analytics = await mk('Analytics');
    await db.candidate.update({ where: { id: candidateId }, data: { resumeUrl: backend.url } });

    await fetch(`http://127.0.0.1:${call.port}/candidate/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, resumeId: analytics.id, makeDefault: true }),
    });

    const me = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(me.resumeUrl).toBe(analytics.url);
  });

  it('falls back to their current one when they pick nothing', async () => {
    const { call, candidateId, job, mk } = await applicant();
    const backend = await mk('Backend');
    await db.candidate.update({ where: { id: candidateId }, data: { resumeUrl: backend.url } });

    await fetch(`http://127.0.0.1:${call.port}/candidate/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true }),
    });

    const app = await db.application.findFirstOrThrow({ where: { candidateId, jobId: job.id } });
    expect(app.resumeUrl).toBe(backend.url);
  });

  it('does not change what was sent when they later switch resumes', async () => {
    const { call, candidateId, job, mk } = await applicant();
    const sent = await mk('Sent');
    const other = await mk('Other');
    await db.candidate.update({ where: { id: candidateId }, data: { resumeUrl: sent.url } });
    await fetch(`http://127.0.0.1:${call.port}/candidate/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true }),
    });

    await db.candidate.update({ where: { id: candidateId }, data: { resumeUrl: other.url } });

    const app = await db.application.findFirstOrThrow({ where: { candidateId, jobId: job.id } });
    expect(app.resumeUrl).toBe(sent.url);
  });

  it('will not send another student resume', async () => {
    const { call, job } = await applicant();
    const theirs = await studentWith([]);
    const notMine = await db.resume.create({
      data: { candidateId: theirs.candidateId, name: 'Theirs', url: '/api/files/resume-x.pdf', source: 'BUILT' },
    });

    const res = await fetch(`http://127.0.0.1:${call.port}/candidate/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, resumeId: notMine.id }),
    });

    expect(res.status).toBe(404);
  });
});
