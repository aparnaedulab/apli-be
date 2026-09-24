import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeJob, makeRecruiter, makeStudent, makeTenant, systemRole } from './factories.js';
import { communityRouter } from '../src/modules/community/community.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Campus stories and the student showcase. The rules that matter cannot be
 * seen in a demo: that stories stay inside their college, that "anonymous"
 * really hides the author from other students, and that a student is found by
 * recruiters only with both the switch and the consent - and even then never
 * hands over a phone number or an email.
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
  app.use('/community', communityRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function tenantWith(...modules: string[]) {
  const tenant = await makeTenant();
  for (const m of modules) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: m, enabled: true } });
  }
  return tenant;
}

async function student(tenantId: string, collegeId: string) {
  const batch = await makeBatch(collegeId);
  const { user, candidate } = await makeStudent(batch.id, { collegeId });
  const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId });
  return { user, candidate, call };
}

async function officer(tenantId: string, collegeId: string, roleKey = 'campus.officer') {
  const user = await db.user.create({
    data: { email: `po-${Math.random()}@test.local`, fullName: 'Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: user.id, collegeId, roleId: (await systemRole(roleKey)).id } });
  return appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId });
}

const story = (over: Record<string, unknown> = {}) => ({
  kind: 'INTERVIEW',
  companyName: 'Demo Systems',
  role: 'Graduate Engineer',
  year: 2026,
  rounds: [{ name: 'Aptitude', what: 'Quant and reasoning, 60 minutes.' }],
  body: 'Three rounds in one day. Prepare puzzles and revise your final-year project in depth.',
  difficulty: 3,
  anonymous: false,
  ...over,
});

describe('campus stories', () => {
  it('reach only the author’s own college, and only once published', async () => {
    const tenant = await tenantWith('showcase.stories');
    const a = await makeCollege('College A', tenant.id);
    const b = await makeCollege('College B', tenant.id);
    const author = await student(tenant.id, a.id);
    const junior = await student(tenant.id, a.id);
    const elsewhere = await student(tenant.id, b.id);

    const created = await author.call('POST', '/community/stories', story());
    expect(created.status).toBe(201);
    expect(created.body.story.status).toBe('PENDING');

    // Pending: nobody else sees it yet.
    expect((await junior.call('GET', '/community/stories')).body.stories).toHaveLength(0);

    const po = await officer(tenant.id, a.id);
    const decided = await po('POST', `/community/college/stories/${created.body.story.id}/decision`, { status: 'PUBLISHED' });
    expect(decided.status).toBe(200);

    expect((await junior.call('GET', '/community/stories')).body.stories).toHaveLength(1);
    expect((await elsewhere.call('GET', '/community/stories')).body.stories).toHaveLength(0);

    // The author was told.
    expect(await db.notification.count({ where: { userId: author.user.id, type: 'STORY_DECISION' } })).toBe(1);
  });

  it('hides an anonymous author from other students but not from the college', async () => {
    const tenant = await tenantWith('showcase.stories');
    const college = await makeCollege('College A', tenant.id);
    const author = await student(tenant.id, college.id);
    const junior = await student(tenant.id, college.id);
    const po = await officer(tenant.id, college.id);

    const { body } = await author.call('POST', '/community/stories', story({ anonymous: true }));
    await po('POST', `/community/college/stories/${body.story.id}/decision`, { status: 'PUBLISHED' });

    const seen = (await junior.call('GET', '/community/stories')).body.stories[0];
    expect(seen.author).toBeNull();
    expect((await author.call('GET', '/community/stories/mine')).body.stories[0].author).toBe('Test Student');
    expect((await po('GET', '/community/college/stories')).body.stories[0].author).toBe('Test Student');
  });

  it('lets only a role that decides postings publish or hide, and a hide needs a reason', async () => {
    const tenant = await tenantWith('showcase.stories');
    const college = await makeCollege('College A', tenant.id);
    const author = await student(tenant.id, college.id);
    const { body } = await author.call('POST', '/community/stories', story());

    const verifier = await officer(tenant.id, college.id, 'campus.verifier');
    expect((await verifier('POST', `/community/college/stories/${body.story.id}/decision`, { status: 'PUBLISHED' })).status).toBe(403);

    const po = await officer(tenant.id, college.id);
    expect((await po('POST', `/community/college/stories/${body.story.id}/decision`, { status: 'HIDDEN' })).status).toBe(400);
    expect((await po('POST', `/community/college/stories/${body.story.id}/decision`, { status: 'HIDDEN', reason: 'Names a person.' })).status).toBe(200);
  });

  it('is closed where the institution has not switched it on', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('College A', tenant.id);
    const s = await student(tenant.id, college.id);
    expect((await s.call('GET', '/community/stories')).status).toBe(403);
  });
});

describe('the student showcase and talent', () => {
  async function world() {
    const tenant = await tenantWith('showcase.student');
    const college = await makeCollege('Demo College', tenant.id);
    const s = await student(tenant.id, college.id);
    await db.candidate.update({ where: { id: s.candidate.id }, data: { phone: '+91 90000 00000', course: 'B.Tech' } });
    const company = await makeCompany();
    const recruiter = await makeRecruiter(company.id);
    const companyCall = appFor({ userId: recruiter.id, role: Role.COMPANY, companyId: company.id });
    return { tenant, college, s, company, recruiter, companyCall };
  }

  it('refuses RECRUITERS visibility until the student consents, and hides them if consent is withdrawn', async () => {
    const w = await world();
    const refused = await w.s.call('PUT', '/community/showcase', { visibility: 'RECRUITERS', pitch: 'Hello' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONSENT_REQUIRED');

    await db.consentRecord.create({ data: { candidateId: w.s.candidate.id, purpose: 'showcase_to_recruiters', granted: true } });
    expect((await w.s.call('PUT', '/community/showcase', { visibility: 'RECRUITERS', pitch: 'Hello' })).status).toBe(200);
    expect((await w.companyCall('GET', '/community/talent')).body.students).toHaveLength(1);

    // Withdrawn later: gone at once, without touching the showcase switch.
    await db.consentRecord.create({ data: { candidateId: w.s.candidate.id, purpose: 'showcase_to_recruiters', granted: false } });
    expect((await w.companyCall('GET', '/community/talent')).body.students).toHaveLength(0);
  });

  it('never gives a company contact details, and an invitation notifies the student', async () => {
    const w = await world();
    await db.consentRecord.create({ data: { candidateId: w.s.candidate.id, purpose: 'showcase_to_recruiters', granted: true } });
    await w.s.call('PUT', '/community/showcase', { visibility: 'RECRUITERS', pitch: 'I build things.' });

    const { body } = await w.companyCall('GET', '/community/talent');
    const text = JSON.stringify(body);
    expect(text).not.toContain('@test.local');
    expect(text).not.toContain('90000');

    const job = await makeJob(w.company.id, w.recruiter.id);
    const sent = await w.companyCall('POST', `/community/talent/${w.s.candidate.id}/invite`, {
      jobId: job.id,
      message: 'Your project fits our team well.',
    });
    expect(sent.status).toBe(201);
    expect(await db.notification.count({ where: { userId: w.s.user.id, type: 'SHOWCASE_INVITE' } })).toBe(1);

    // The same invitation twice within a month is refused.
    expect(
      (await w.companyCall('POST', `/community/talent/${w.s.candidate.id}/invite`, { jobId: job.id, message: 'Again, please apply.' })).status,
    ).toBe(409);

    const mine = (await w.s.call('GET', '/community/showcase')).body;
    expect(mine.invites[0]).toMatchObject({ jobId: job.id, status: 'SENT' });
  });

  it('cannot invite a student who has not chosen to be found', async () => {
    const w = await world();
    const res = await w.companyCall('POST', `/community/talent/${w.s.candidate.id}/invite`, { message: 'Please apply to us.' });
    expect(res.status).toBe(404);
  });

  it('is closed to a company the platform has not verified', async () => {
    const pending = await makeCompany(undefined, false);
    const recruiter = await makeRecruiter(pending.id);
    const call = appFor({ userId: recruiter.id, role: Role.COMPANY, companyId: pending.id });
    expect((await call('GET', '/community/talent')).status).toBe(403);
  });

  it('is closed to students where the showcase is off', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('College A', tenant.id);
    const s = await student(tenant.id, college.id);
    expect((await s.call('GET', '/community/showcase')).status).toBe(403);
  });
});
