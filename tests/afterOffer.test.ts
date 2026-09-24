import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus as S, JoiningStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import {
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makePosting,
  makeRecruiter,
  makeStudent,
  makeTenant,
  systemRole,
} from './factories.js';
import { afterOfferRouter } from '../src/modules/afterOffer/afterOffer.routes.js';
import { companyFacts } from '../src/modules/showcase/companyFacts.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * After the offer: a joining date the student can see move, a withdrawal that
 * cannot happen silently, and ratings that only ever surface as totals.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function appFor(session: Partial<SessionData>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Partial<SessionData> }).session = { ...session };
    next();
  });
  app.use('/after-offer', afterOfferRouter);
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

async function world(modules = ['trust.offerProtection', 'trust.reputation']) {
  const tenant = await makeTenant();
  for (const moduleKey of modules) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey, enabled: true } });
  }
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  return { tenant, college, batch, drive };
}

async function offerFor(w: Awaited<ReturnType<typeof world>>, status: S = S.ACCEPTED) {
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const job = await makeJob(company.id, recruiter.id);
  await makePosting(job.id, w.drive.id);
  const { user, candidate } = await makeStudent(w.batch.id, { collegeId: w.college.id });
  const application = await db.application.create({
    data: { candidateId: candidate.id, jobId: job.id, placementId: w.drive.id, status },
  });
  const student = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: w.tenant.id });
  const companyCall = appFor({ userId: recruiter.id, role: Role.COMPANY, companyId: company.id });
  return { company, recruiter, job, user, candidate, application, student, companyCall };
}

async function officer(w: Awaited<ReturnType<typeof world>>) {
  const u = await db.user.create({
    data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: u.id, collegeId: w.college.id, roleId: (await systemRole('campus.officer')).id } });
  return appFor({ userId: u.id, role: Role.CAMPUS, collegeId: w.college.id, tenantId: w.tenant.id });
}

describe('offer protection', () => {
  it('records every joining change, tells the student, and needs reasons for bad news', async () => {
    const w = await world();
    const o = await offerFor(w);
    const url = `/after-offer/company/applications/${o.application.id}/joining`;

    const set = await o.companyCall('POST', url, { action: 'SET_DATE', date: '2027-07-01' });
    expect(set.status).toBe(200);
    expect(set.body.tracker).toMatchObject({ status: 'AWAITING', expectedJoiningDate: '2027-07-01' });

    // Moving it later without saying why is refused.
    expect((await o.companyCall('POST', url, { action: 'SET_DATE', date: '2027-10-01' })).status).toBe(400);
    const moved = await o.companyCall('POST', url, { action: 'SET_DATE', date: '2027-10-01', reason: 'Project start moved' });
    expect(moved.body.tracker.status).toBe('DELAYED');

    const confirmed = await o.student('POST', `/after-offer/student/offers/${o.application.id}`, { action: 'CONFIRM' });
    expect(confirmed.body.tracker.status).toBe('CONFIRMED');

    // Withdrawing without a reason is refused; with one, it closes the offer.
    expect((await o.companyCall('POST', url, { action: 'REVOKE' })).status).toBe(400);
    const revoked = await o.companyCall('POST', url, { action: 'REVOKE', reason: 'Hiring freeze' });
    expect(revoked.body.tracker.status).toBe('REVOKED');
    expect(revoked.body.tracker.history.map((h: { by: string }) => h.by)).toEqual(['COMPANY', 'COMPANY', 'STUDENT', 'COMPANY']);

    // Nothing more can happen to a withdrawn offer.
    expect((await o.companyCall('POST', url, { action: 'JOINED' })).status).toBe(409);

    const notes = await db.notification.findMany({ where: { userId: o.user.id }, orderBy: { createdAt: 'asc' } });
    expect(notes).toHaveLength(3);
    expect(notes[2]!.title).toMatch(/withdrew/);
  });

  it('lets the student report what they were told off the platform', async () => {
    const w = await world();
    const o = await offerFor(w);
    const url = `/after-offer/student/offers/${o.application.id}`;

    const offers = await o.student('GET', '/after-offer/student/offers');
    expect(offers.body.offers).toHaveLength(1);

    expect((await o.student('POST', url, { action: 'NO_NEWS' })).status).toBe(200);
    expect((await o.student('POST', url, { action: 'REPORT_REVOKED' })).status).toBe(400);
    const reported = await o.student('POST', url, { action: 'REPORT_REVOKED', note: 'HR called and said the role closed' });
    expect(reported.body.tracker.status).toBe('REVOKED');
    expect(reported.body.tracker.reason).toMatch(/Reported by the student/);
  });

  it('keeps a company to its own applicants', async () => {
    const w = await world();
    const mine = await offerFor(w);
    const theirs = await offerFor(w);
    const url = `/after-offer/company/applications/${theirs.application.id}`;
    expect((await mine.companyCall('GET', url)).status).toBe(404);
    expect((await mine.companyCall('POST', `${url}/joining`, { action: 'JOINED' })).status).toBe(404);
    expect((await mine.companyCall('POST', `${url}/reliability`, { kind: 'NO_SHOW' })).status).toBe(404);
  });

  it('shows the college its own offers only, overdue ones flagged, and lets it add a note', async () => {
    const w = await world();
    const o = await offerFor(w);
    await o.companyCall('POST', `/after-offer/company/applications/${o.application.id}/joining`, {
      action: 'SET_DATE',
      date: '2020-01-01',
    });
    const other = await world();
    await offerFor(other);

    const call = await officer(w);
    const res = await call('GET', '/after-offer/college/offers');
    expect(res.status).toBe(200);
    expect(res.body.offers).toHaveLength(1);
    expect(res.body.summary).toMatchObject({ total: 1, overdue: 1 });

    const noted = await call('POST', `/after-offer/college/offers/${o.application.id}/note`, { note: 'Called HR' });
    expect(noted.body.tracker.history.at(-1)).toMatchObject({ by: 'COLLEGE', note: 'Called HR' });
  });

  it('is closed to students and colleges where the institution has it off', async () => {
    const w = await world([]);
    const o = await offerFor(w);
    expect((await o.student('GET', '/after-offer/student/offers')).status).toBe(403);
    expect((await o.student('GET', '/after-offer/student/ratings')).status).toBe(403);
    expect((await (await officer(w))('GET', '/after-offer/college/offers')).status).toBe(403);
    // The company side is never gated: companies have no institution.
    expect((await o.companyCall('GET', `/after-offer/company/applications/${o.application.id}`)).status).toBe(200);
  });
});

describe('reputation', () => {
  it('lets a student rate once, and only after the application closes', async () => {
    const w = await world();
    const open = await offerFor(w, S.IN_ROUND);
    const scores = { communication: 4, clarity: 3, fairness: 5 };
    expect((await open.student('POST', `/after-offer/student/ratings/${open.application.id}`, scores)).status).toBe(409);

    const closed = await offerFor(w, S.REJECTED);
    const url = `/after-offer/student/ratings/${closed.application.id}`;
    expect((await closed.student('POST', url, { ...scores, communication: 7 })).status).toBe(400);
    expect((await closed.student('POST', url, scores)).status).toBe(201);
    expect((await closed.student('POST', url, scores)).status).toBe(409);

    const list = await closed.student('GET', '/after-offer/student/ratings');
    expect(list.body.applications[0].rating).toMatchObject(scores);
  });

  it('shows averages only from five ratings, and the offer-honour rate on the company page', async () => {
    const w = await world();
    const company = await makeCompany();
    const recruiter = await makeRecruiter(company.id);
    const job = await makeJob(company.id, recruiter.id);
    await makePosting(job.id, w.drive.id);

    const apps = [];
    for (let i = 0; i < 5; i++) {
      const { candidate } = await makeStudent(w.batch.id, { collegeId: w.college.id });
      apps.push(
        await db.application.create({
          data: { candidateId: candidate.id, jobId: job.id, placementId: w.drive.id, status: S.ACCEPTED },
        }),
      );
    }

    // Four ratings: nothing shown yet.
    for (const a of apps.slice(0, 4)) {
      await db.processRating.create({
        data: { applicationId: a.id, candidateId: a.candidateId, companyId: company.id, communication: 4, clarity: 4, fairness: 4 },
      });
    }
    let facts = await companyFacts(company.id);
    expect(facts.find((f) => f.key === 'processRating')).toMatchObject({ enough: false, display: null });

    await db.processRating.create({
      data: { applicationId: apps[4]!.id, candidateId: apps[4]!.candidateId, companyId: company.id, communication: 2, clarity: 2, fairness: 2 },
    });

    // Four joined, one withdrawn.
    for (const [i, a] of apps.entries()) {
      await db.joiningTracker.create({
        data: {
          applicationId: a.id,
          candidateId: a.candidateId,
          companyId: company.id,
          collegeId: w.college.id,
          status: i === 4 ? JoiningStatus.REVOKED : JoiningStatus.JOINED,
          history: [],
        },
      });
    }

    facts = await companyFacts(company.id);
    expect(facts.find((f) => f.key === 'processRating')).toMatchObject({ enough: true, value: 3.6 });
    expect(facts.find((f) => f.key === 'offerHonour')).toMatchObject({ enough: true, value: 80 });

    const call = await officer(w);
    const res = await call('GET', '/after-offer/college/companies');
    const row = res.body.companies.find((c: { id: string }) => c.id === company.id);
    expect(row.honour).toMatchObject({ joined: 4, revoked: 1, rate: 80 });
    expect(row.rating).toMatchObject({ count: 5, overall: 3.6 });
  });

  it('shows the college reliability marks for its own students only', async () => {
    const w = await world();
    const o = await offerFor(w);
    const marked = await o.companyCall('POST', `/after-offer/company/applications/${o.application.id}/reliability`, {
      kind: 'RENEGED',
      note: 'Accepted, then joined elsewhere',
    });
    expect(marked.status).toBe(200);

    const other = await world();
    const x = await offerFor(other);
    await x.companyCall('POST', `/after-offer/company/applications/${x.application.id}/reliability`, { kind: 'NO_SHOW' });

    const res = await (await officer(w))('GET', '/after-offer/college/reliability');
    expect(res.body.marks).toHaveLength(1);
    expect(res.body.marks[0]).toMatchObject({ kind: 'RENEGED', company: o.company.name });
  });
});
