import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import {
  makeApplication,
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makePosting,
  makeRecruiter,
  makeStudent,
  makeTenant,
} from './factories.js';
import { companyPageRouter } from '../src/modules/showcase/companyPage.routes.js';
import { companyFacts, median } from '../src/modules/showcase/companyFacts.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The company page. What matters is invisible in a demo: that the measured
 * layer is honest (and says "not enough data" rather than inventing a
 * figure), that a company cannot write to it, and that a student sees only
 * verified companies and only the roles already open to them.
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
  app.use('/showcase', companyPageRouter);
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

const DAY = 24 * 60 * 60 * 1000;

/** A student in a college of a tenant that has (or lacks) the company page. */
async function world(moduleOn = true) {
  const tenant = await makeTenant();
  if (moduleOn) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'showcase.company', enabled: true } });
  }
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  const student = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id });
  return { tenant, college, batch, drive, company, recruiter, candidate, student };
}

/** An application answered `afterDays` after it was made, `ageDays` ago. */
async function answered(candidateId: string, jobId: string, placementId: string, ageDays: number, afterDays: number | null) {
  const appliedAt = new Date(Date.now() - ageDays * DAY);
  const app = await db.application.create({
    data: { candidateId, jobId, placementId, status: afterDays === null ? ApplicationStatus.APPLIED : ApplicationStatus.UNDER_REVIEW, appliedAt },
  });
  if (afterDays !== null) {
    await db.statusEvent.create({
      data: {
        applicationId: app.id,
        fromStatus: ApplicationStatus.APPLIED,
        toStatus: ApplicationStatus.UNDER_REVIEW,
        createdAt: new Date(appliedAt.getTime() + afterDays * DAY),
      },
    });
  }
  return app;
}

describe('measured facts', () => {
  it('takes the middle of an odd list and the mean of the middle two of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('says "not enough data" rather than a number below the threshold', async () => {
    const w = await world();
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);
    await answered(w.candidate.id, job.id, w.drive.id, 10, 1);

    const facts = await companyFacts(w.company.id);
    const reply = facts.find((f) => f.key === 'medianResponse')!;
    expect(reply.enough).toBe(false);
    expect(reply.display).toBeNull();
    expect(reply.sentence).toMatch(/not enough data/i);
    expect(facts.find((f) => f.key === 'payTransparency')!.enough).toBe(false);
  });

  it('reports the median reply time and the share answered within seven days', async () => {
    const w = await world();
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);

    // Five students so each application is a separate row (one per candidate per job).
    const replies = [1, 2, 3, 10, 12];
    for (const after of replies) {
      const { candidate } = await makeStudent(w.batch.id, { collegeId: w.college.id });
      await answered(candidate.id, job.id, w.drive.id, 20, after);
    }

    const facts = await companyFacts(w.company.id);
    const reply = facts.find((f) => f.key === 'medianResponse')!;
    expect(reply.enough).toBe(true);
    expect(reply.value).toBe(3);
    const onTime = facts.find((f) => f.key === 'answeredOnTime')!;
    expect(onTime.value).toBe(60); // 3 of 5 within 7 days
  });

  it('counts pay transparency and bonds once there are enough roles', async () => {
    const w = await world();
    for (let i = 0; i < 4; i++) {
      const job = await makeJob(w.company.id, w.recruiter.id);
      await db.job.update({
        where: { id: job.id },
        data: { ctcFixed: i < 3 ? 600000 : null, bondMonths: i === 0 ? 12 : null },
      });
    }
    const facts = await companyFacts(w.company.id);
    expect(facts.find((f) => f.key === 'payTransparency')!.value).toBe(75);
    expect(facts.find((f) => f.key === 'bondUsage')!.value).toBe(25);
  });
});

describe('the student view', () => {
  it('shows a verified company with only the roles open to this student', async () => {
    const w = await world();
    const open = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(open.id, w.drive.id);
    // A role at another college's drive: not the student's to see.
    const other = await makeCollege('Elsewhere', w.tenant.id);
    const otherBatch = await makeBatch(other.id);
    const otherDrive = await makeDrive(other.id, otherBatch.id);
    const elsewhere = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(elsewhere.id, otherDrive.id);

    const res = await w.student('GET', `/showcase/companies/${w.company.id}`);
    expect(res.status).toBe(200);
    expect(res.body.says.name).toBe(w.company.name);
    expect(res.body.roles.map((r: { id: string }) => r.id)).toEqual([open.id]);
    expect(res.body.measured.length).toBeGreaterThan(0);
    expect(res.body.seniors.stories).toEqual([]);
  });

  it('answers 404 for a company that is not verified', async () => {
    const w = await world();
    const pending = await makeCompany('Pending Co', false);
    expect((await w.student('GET', `/showcase/companies/${pending.id}`)).status).toBe(404);
  });

  it('is refused where the institution does not have the company page', async () => {
    const w = await world(false);
    expect((await w.student('GET', `/showcase/companies/${w.company.id}`)).status).toBe(403);
  });
});

describe('the company editor', () => {
  it('saves the company’s own words and ignores anything else in the body', async () => {
    const w = await world();
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);
    await makeApplication(w.candidate.id, job.id, w.drive.id);
    const company = appFor({ userId: w.recruiter.id, role: Role.COMPANY, companyId: w.company.id });

    const before = await company('GET', '/showcase/mine');
    const res = await company('PUT', '/showcase/mine', {
      whyJoin: 'Real projects from week one.',
      howWeHire: 'An online test, then two interviews.',
      measured: [{ key: 'answeredOnTime', value: 100 }],
      status: 'VERIFIED',
      name: 'Renamed',
    });
    expect(res.status).toBe(200);
    expect(res.body.says).toMatchObject({ whyJoin: 'Real projects from week one.', howWeHire: 'An online test, then two interviews.', name: w.company.name });
    expect(res.body.measured).toEqual(before.body.measured);

    const stored = await db.company.findUniqueOrThrow({ where: { id: w.company.id } });
    expect(stored.whyJoin).toBe('Real projects from week one.');
  });

  it('is closed to students', async () => {
    const w = await world();
    expect((await w.student('PUT', '/showcase/mine', { whyJoin: 'x' })).status).toBe(403);
  });
});
