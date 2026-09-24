import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
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
import { trustRouter } from '../src/modules/trust/trust.routes.js';
import { studentJobsRouter } from '../src/modules/candidates/studentJobs.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The trust checks, through the real routers with a planted session.
 *
 * What matters here is what a demo would not show: a student is only ever told
 * about roles in their own drives, the reasons match the rules that hid the
 * role, a report lands at the student's own college, and a module that is
 * switched off is really off.
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
  app.use('/trust', trustRouter);
  app.use('/candidate/jobs', studentJobsRouter);
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

async function modulesOn(tenantId: string, keys: string[]) {
  for (const moduleKey of keys) {
    await db.tenantModule.create({ data: { tenantId, moduleKey, enabled: true } });
  }
}

/** A college with one drive, one student in it, and a company. */
async function world(opts: { cgpa?: number; frozen?: boolean } = {}) {
  const tenant = await makeTenant();
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const { user, candidate } = await makeStudent(batch.id, {
    collegeId: college.id,
    cgpa: opts.cgpa ?? 6.8,
    frozen: opts.frozen ?? true,
  });
  const student = appFor({
    userId: user.id,
    role: Role.CANDIDATE,
    candidateId: candidate.id,
    tenantId: tenant.id,
  });
  return { tenant, college, batch, drive, company, recruiter, candidate, student };
}

describe('why a student cannot apply', () => {
  it('lists a role in their own drive that they miss, with the reason in plain words', async () => {
    const w = await world({ cgpa: 6.8 });
    await modulesOn(w.tenant.id, ['trust.whyNot']);
    const job = await makeJob(w.company.id, w.recruiter.id, { minCgpa: 7 });
    await makePosting(job.id, w.drive.id);

    const res = await w.student('GET', '/trust/not-eligible');
    expect(res.status).toBe(200);
    expect(res.body.roles).toHaveLength(1);
    const [reason] = res.body.roles[0].reasons;
    expect(reason.code).toBe('AGGREGATE');
    expect(reason.text).toContain('7 CGPA');
    expect(reason.yours).toBe('6.8 CGPA');
  });

  it('says nothing of roles the student can already apply to', async () => {
    const w = await world({ cgpa: 8.5 });
    await modulesOn(w.tenant.id, ['trust.whyNot']);
    const job = await makeJob(w.company.id, w.recruiter.id, { minCgpa: 7 });
    await makePosting(job.id, w.drive.id);
    expect((await w.student('GET', '/trust/not-eligible')).body.roles).toHaveLength(0);
  });

  it('never mentions a role at another college', async () => {
    const w = await world({ cgpa: 6 });
    await modulesOn(w.tenant.id, ['trust.whyNot']);
    const other = await makeCollege('Other College', w.tenant.id);
    const otherBatch = await makeBatch(other.id);
    const otherDrive = await makeDrive(other.id, otherBatch.id);
    const job = await makeJob(w.company.id, w.recruiter.id, { minCgpa: 9 });
    await makePosting(job.id, otherDrive.id);
    expect((await w.student('GET', '/trust/not-eligible')).body.roles).toHaveLength(0);
  });

  it('also tells an unverified student to ask their college', async () => {
    // Being unverified alone does not hide a role - the student sees it, with
    // "your college has not verified you" beside the Apply button. It is
    // listed here with the rest of what stands in the way of a hidden role.
    const w = await world({ frozen: false, cgpa: 6 });
    await modulesOn(w.tenant.id, ['trust.whyNot']);
    const job = await makeJob(w.company.id, w.recruiter.id, { minCgpa: 7 });
    await makePosting(job.id, w.drive.id);
    const res = await w.student('GET', '/trust/not-eligible');
    const codes = res.body.roles[0].reasons.map((r: { code: string }) => r.code);
    expect(codes).toEqual(['NOT_VERIFIED', 'AGGREGATE']);
    expect(res.body.roles[0].reasons[0].fix).toMatch(/placement cell/);
  });

  it('is refused where the institution has not switched it on', async () => {
    const w = await world();
    expect((await w.student('GET', '/trust/not-eligible')).status).toBe(403);
  });
});

describe('the honest offer card and the fee warning', () => {
  it('shows the pay split and a monthly estimate only where the module is on', async () => {
    const w = await world({ cgpa: 8.5 });
    const job = await makeJob(w.company.id, w.recruiter.id);
    await db.job.update({
      where: { id: job.id },
      data: { ctcFixed: 1_000_000, ctcVariable: 200_000, bondMonths: 24, bondAmount: 200_000, description: 'A registration fee of ₹1,000 applies.' },
    });
    await makePosting(job.id, w.drive.id);

    const off = await w.student('GET', `/candidate/jobs/${job.id}`);
    expect(off.body.offerCard).toBeNull();
    expect(off.body.feeWarning).toBeNull();

    await modulesOn(w.tenant.id, ['trust.offerCard', 'trust.scamShield']);
    const on = await w.student('GET', `/candidate/jobs/${job.id}`);
    expect(on.body.offerCard).toMatchObject({ fixed: 1_000_000, variable: 200_000, bond: { months: 24, amount: 200_000 } });
    expect(on.body.offerCard.inHand.monthly).toBeGreaterThan(70_000);
    expect(on.body.feeWarning).toHaveLength(1);
    expect(on.body.job.companyId).toBe(w.company.id);

    const list = await w.student('GET', '/candidate/jobs');
    expect(list.body.jobs[0].inHandMonthly).toBe(on.body.offerCard.inHand.monthly);
  });
});

describe('reports from students', () => {
  it('lands at the student’s college, once per student, and the college reviews it', async () => {
    const w = await world({ cgpa: 8.5 });
    await modulesOn(w.tenant.id, ['trust.scamShield']);
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);

    const first = await w.student('POST', `/trust/jobs/${job.id}/report`, { reason: 'FEE_DEMANDED', note: 'They asked for money on the call.' });
    expect(first.status).toBe(201);
    const again = await w.student('POST', `/trust/jobs/${job.id}/report`, { reason: 'FAKE_COMPANY' });
    expect(again.body.report.id).toBe(first.body.report.id);
    expect(await db.jobReport.count()).toBe(1);

    const officer = await db.user.create({
      data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
    });
    await db.campusMember.create({
      data: { userId: officer.id, collegeId: w.college.id, roleId: (await systemRole('campus.officer')).id },
    });
    const campus = appFor({ userId: officer.id, role: Role.CAMPUS, collegeId: w.college.id, tenantId: w.tenant.id });

    const signals = await campus('GET', `/trust/jobs/${job.id}/signals`);
    expect(signals.status).toBe(200);
    expect(signals.body.reports[0]).toMatchObject({ reason: 'FAKE_COMPANY', status: 'OPEN', studentName: 'Test Student' });

    const reviewed = await campus('POST', `/trust/reports/${first.body.report.id}/review`, { status: 'REVIEWED' });
    expect(reviewed.body.report.status).toBe('REVIEWED');
  });

  it('refuses a report on a role outside the student’s drives', async () => {
    const w = await world();
    await modulesOn(w.tenant.id, ['trust.scamShield']);
    const job = await makeJob(w.company.id, w.recruiter.id);
    expect((await w.student('POST', `/trust/jobs/${job.id}/report`, { reason: 'OTHER' })).status).toBe(404);
  });

  it('keeps another college out of this college’s reports', async () => {
    const w = await world({ cgpa: 8.5 });
    await modulesOn(w.tenant.id, ['trust.scamShield']);
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);
    const { body } = await w.student('POST', `/trust/jobs/${job.id}/report`, { reason: 'OTHER' });

    const other = await makeCollege('Other College', w.tenant.id);
    const officer = await db.user.create({
      data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Other Officer', passwordHash: 'x', role: Role.CAMPUS },
    });
    await db.campusMember.create({
      data: { userId: officer.id, collegeId: other.id, roleId: (await systemRole('campus.officer')).id },
    });
    const campus = appFor({ userId: officer.id, role: Role.CAMPUS, collegeId: other.id, tenantId: w.tenant.id });
    expect((await campus('GET', '/trust/reports')).body.reports).toHaveLength(0);
    expect((await campus('POST', `/trust/reports/${body.report.id}/review`, { status: 'DISMISSED' })).status).toBe(404);
  });
});

describe('applying and consent', () => {
  it('asks for consent first where the consent centre is on', async () => {
    const w = await world({ cgpa: 8.5 });
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);
    await modulesOn(w.tenant.id, ['compliance.consent']);

    const res = await w.student('POST', `/candidate/jobs/${job.id}/apply`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('applies as before where it is off', async () => {
    const w = await world({ cgpa: 8.5 });
    const job = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(job.id, w.drive.id);
    expect((await w.student('POST', `/candidate/jobs/${job.id}/apply`, {})).status).toBe(201);
  });
});

describe('the scanner endpoint', () => {
  it('is open to a company writing a role', async () => {
    const company = await makeCompany();
    const recruiter = await makeRecruiter(company.id);
    const app = appFor({ userId: recruiter.id, role: Role.COMPANY, companyId: company.id });
    const res = await app('POST', '/trust/scan', { text: 'Candidates must pay a processing fee.' });
    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
  });
});
