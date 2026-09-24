import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus as S, Role, RoundOutcome } from '@prisma/client';
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
import { trackerRouter } from '../src/modules/tracker/tracker.routes.js';
import { roundStates, waiting } from '../src/modules/tracker/tracker.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The tracker's promises: every round shows an honest state, "overdue" means
 * past the college's own response time, and each reader sees only their own.
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
  app.use('/tracker', trackerRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY - 60_000);

/** A tenant with the tracker switched on and a 3-day response time, and a college in it. */
async function world(responseDays = 3) {
  const tenant = await makeTenant();
  await db.tenant.update({ where: { id: tenant.id }, data: { responseDays } });
  await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'trust.tracker', enabled: true } });
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  return { tenant, college, batch, drive };
}

async function companyWithJob(driveId: string) {
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const job = await makeJob(company.id, recruiter.id, { rounds: 3 });
  await makePosting(job.id, driveId);
  return { company, recruiter, job };
}

describe('round states', () => {
  const rounds = [
    { id: 'r1', order: 1, name: 'Aptitude' },
    { id: 'r2', order: 2, name: 'Technical' },
    { id: 'r3', order: 3, name: 'HR' },
  ];

  it('ticks rounds before the current one, even without a written result', () => {
    const states = roundStates(rounds, [], 'r2', S.IN_ROUND).map((r) => r.state);
    expect(states).toEqual(['passed', 'current', 'upcoming']);
  });

  it('lets a recorded outcome win, and fails the round a rejection happened in', () => {
    const states = roundStates(
      rounds,
      [
        { roundId: 'r1', outcome: RoundOutcome.PASSED, evaluatedAt: new Date() },
        { roundId: 'r2', outcome: RoundOutcome.PENDING, evaluatedAt: null },
      ],
      'r2',
      S.REJECTED,
    ).map((r) => r.state);
    expect(states).toEqual(['passed', 'failed', 'upcoming']);
  });

  it('treats every round as cleared once there is an offer', () => {
    expect(roundStates(rounds, [], 'r3', S.OFFERED).every((r) => r.state === 'passed')).toBe(true);
  });

  it('shows everything upcoming for a fresh application', () => {
    expect(roundStates(rounds, [], null, S.APPLIED).map((r) => r.state)).toEqual(['upcoming', 'upcoming', 'upcoming']);
  });
});

describe('overdue', () => {
  it('is past the response time, and only while the company owes a move', () => {
    const base = { currentRoundId: null, results: [], responseDays: 3 };
    expect(waiting({ ...base, status: S.APPLIED, lastActivityAt: daysAgo(4) })).toMatchObject({ daysWaiting: 4, overdue: true });
    expect(waiting({ ...base, status: S.APPLIED, lastActivityAt: daysAgo(3) })).toMatchObject({ daysWaiting: 3, overdue: false });
    expect(waiting({ ...base, status: S.WAITLISTED, lastActivityAt: daysAgo(30) })).toBeNull();
    expect(waiting({ ...base, status: S.OFFERED, lastActivityAt: daysAgo(30) })).toBeNull();
  });

  it('does not count a round whose result is already in', () => {
    expect(
      waiting({
        status: S.IN_ROUND,
        currentRoundId: 'r1',
        results: [{ roundId: 'r1', outcome: RoundOutcome.PASSED, evaluatedAt: new Date() }],
        lastActivityAt: daysAgo(10),
        responseDays: 3,
      }),
    ).toBeNull();
  });
});

describe('the student tracker', () => {
  it('shows stages, a timeline and the wait against the college’s 3 days', async () => {
    const w = await world(3);
    const { job } = await companyWithJob(w.drive.id);
    const { user, candidate } = await makeStudent(w.batch.id, { collegeId: w.college.id });
    const app = await db.application.create({
      data: { candidateId: candidate.id, jobId: job.id, placementId: w.drive.id, status: S.APPLIED, appliedAt: daysAgo(5) },
    });

    const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: w.tenant.id });
    const res = await call('/tracker/applications');
    expect(res.status).toBe(200);
    const a = res.body.applications.find((x: { id: string }) => x.id === app.id);
    expect(a.rounds).toHaveLength(3);
    expect(a.timeline[0].text).toBe('Applied');
    expect(a.waiting).toMatchObject({ daysWaiting: 5, overdue: true, responseDays: 3 });
  });

  it('is refused where the institution has not switched the tracker on', async () => {
    const tenant = await makeTenant();
    const college = await makeCollege('Other College', tenant.id);
    const batch = await makeBatch(college.id);
    const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
    const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id });
    expect((await call('/tracker/applications')).status).toBe(403);
  });
});

describe('who sees whose overdue applications', () => {
  it('gives a company only its own roles', async () => {
    const w = await world(3);
    const mine = await companyWithJob(w.drive.id);
    const theirs = await companyWithJob(w.drive.id);
    const { candidate } = await makeStudent(w.batch.id, { collegeId: w.college.id });
    const { candidate: other } = await makeStudent(w.batch.id, { collegeId: w.college.id });
    await db.application.create({ data: { candidateId: candidate.id, jobId: mine.job.id, placementId: w.drive.id, appliedAt: daysAgo(6) } });
    await db.application.create({ data: { candidateId: other.id, jobId: theirs.job.id, placementId: w.drive.id, appliedAt: daysAgo(6) } });

    const call = appFor({ userId: mine.recruiter.id, role: Role.COMPANY, companyId: mine.company.id });
    const res = await call('/tracker/company');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([mine.job.id]);
  });

  it('gives a college only its own drives, grouped by company', async () => {
    const a = await world(3);
    const b = await world(3);
    const { company, job } = await companyWithJob(a.drive.id);
    await makePosting(job.id, b.drive.id);
    const { candidate: sa } = await makeStudent(a.batch.id, { collegeId: a.college.id });
    const { candidate: sb } = await makeStudent(b.batch.id, { collegeId: b.college.id });
    await db.application.create({ data: { candidateId: sa.id, jobId: job.id, placementId: a.drive.id, appliedAt: daysAgo(9) } });
    await db.application.create({ data: { candidateId: sb.id, jobId: job.id, placementId: b.drive.id, appliedAt: daysAgo(9) } });

    const officer = await db.user.create({
      data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
    });
    await db.campusMember.create({ data: { userId: officer.id, collegeId: a.college.id, roleId: (await systemRole('campus.officer')).id } });

    const call = appFor({ userId: officer.id, role: Role.CAMPUS, collegeId: a.college.id, tenantId: a.tenant.id });
    const res = await call('/tracker/college');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.companies[0]).toMatchObject({ companyId: company.id, overdue: 1, oldestDays: 9 });
  });
});
