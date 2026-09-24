import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import ExcelJS from 'exceljs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus as S, PlacementType, Role } from '@prisma/client';
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
  systemRole,
} from './factories.js';
import { reportsRouter } from '../src/modules/reports/reports.routes.js';
import { median } from '../src/modules/reports/reports.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Placement reports. The numbers go into accreditation filings, so every rule
 * that shapes one is pinned: who is in the pool, who counts as placed, how
 * the median is taken, that internships stay out of placement figures, and
 * that nothing from another college - let alone another institution - leaks in.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/reports', reportsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const type = res.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: body as any };
  };
}

async function officerOf(collegeId: string, tenantId: string) {
  const user = await db.user.create({
    data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: user.id, collegeId, roleId: (await systemRole('campus.officer')).id } });
  return appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId });
}

async function adminOf(tenantId: string) {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@demo-university.example`, fullName: 'Demo Admin', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({ data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId } });
  return appFor({ userId: user.id, role: Role.ADMIN, tenantId });
}

async function reportsOn(tenantId: string) {
  await db.tenantModule.create({ data: { tenantId, moduleKey: 'compliance.reports', enabled: true } });
}

async function jobAt(companyId: string, pay: { fixed?: number; min?: number; stipend?: number }) {
  const recruiter = await makeRecruiter(companyId);
  const job = await makeJob(companyId, recruiter.id);
  return db.job.update({
    where: { id: job.id },
    data: { ctcFixed: pay.fixed ?? null, ctcMin: pay.min ?? null, stipendPerMonth: pay.stipend ?? null },
  });
}

/**
 * College A: 4 students passing in 2026.
 *   s1 accepted 6,00,000 fixed · s2 hired, range only from 8,00,000 ·
 *   s3 declined an offer, then accepted an internship · s4 did nothing.
 * College B (same institution): 1 student hired at 9,00,000.
 * College X (another institution): 1 student hired - must never appear.
 */
async function world() {
  const tenant = await makeTenant('Demo University');
  const other = await makeTenant('Other University');
  await reportsOn(tenant.id);
  await reportsOn(other.id);

  const a = await makeCollege('Demo College A', tenant.id);
  const b = await makeCollege('Demo College B', tenant.id);
  const x = await makeCollege('Elsewhere College', other.id);

  const batchA = await makeBatch(a.id, { course: 'B.Tech' });
  const batchB = await makeBatch(b.id, { course: 'B.Tech' });
  const batchX = await makeBatch(x.id, { course: 'B.Tech' });

  const finalA = await makeDrive(a.id, batchA.id);
  const internA = await db.placement.create({
    data: { collegeId: a.id, name: 'Demo internships', year: 2026, type: PlacementType.INTERNSHIP, batches: { connect: { id: batchA.id } } },
  });
  const finalB = await makeDrive(b.id, batchB.id);
  const finalX = await makeDrive(x.id, batchX.id);

  const c1 = await makeCompany('Demo Analytics');
  const c2 = await makeCompany('Demo Systems');
  const c3 = await makeCompany('Demo Interns');
  const j1 = await jobAt(c1.id, { fixed: 600000 });
  const j2 = await jobAt(c2.id, { min: 800000 });
  const j3 = await jobAt(c3.id, { stipend: 20000 });
  const jB = await jobAt(c1.id, { fixed: 900000 });
  const jX = await jobAt(c2.id, { fixed: 5000000 });

  await makePosting(j1.id, finalA.id);
  await makePosting(j2.id, finalA.id);
  await makePosting(j3.id, internA.id);
  await makePosting(jB.id, finalB.id);
  await makePosting(jX.id, finalX.id);

  const s = [];
  for (let i = 0; i < 4; i++) {
    s.push((await makeStudent(batchA.id, { collegeId: a.id, specialisation: i < 2 ? 'Computer' : 'Mechanical' })).candidate);
  }
  await makeApplication(s[0]!.id, j1.id, finalA.id, S.ACCEPTED);
  await makeApplication(s[1]!.id, j2.id, finalA.id, S.HIRED);
  await makeApplication(s[2]!.id, j1.id, finalA.id, S.DECLINED);
  await makeApplication(s[2]!.id, j3.id, internA.id, S.ACCEPTED);

  const sb = (await makeStudent(batchB.id, { collegeId: b.id })).candidate;
  await makeApplication(sb.id, jB.id, finalB.id, S.HIRED);

  const sx = (await makeStudent(batchX.id, { collegeId: x.id })).candidate;
  await makeApplication(sx.id, jX.id, finalX.id, S.HIRED);

  return { tenant, other, a, b, x, finalA };
}

describe('the median', () => {
  it('takes the middle of an odd count and the mean of the two middles of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([600000, 800000])).toBe(700000);
    expect(median([])).toBeNull();
  });
});

describe('a college report', () => {
  it('counts the pool, the placed and their pay, and keeps internships apart', async () => {
    const w = await world();
    const call = await officerOf(w.a.id, w.tenant.id);
    const { status, body } = await call('/reports/college?year=2026');

    expect(status).toBe(200);
    expect(body.pool).toBe(4);
    expect(body.final).toMatchObject({ applied: 3, placed: 2, placedPct: 50, offersMade: 3, offersAccepted: 2, recruiters: 2 });
    expect(body.final.pay).toMatchObject({ highest: 800000, median: 700000, average: 700000 });
    expect(body.final.payBasis).toEqual({ fromFixed: 1, fromRangeMin: 1, missing: 0 });

    // The internship is its own outcome and moves none of the placement figures.
    expect(body.internship).toMatchObject({ placed: 1, placedPct: 25, recruiters: 1, payUnit: 'monthly stipend' });
    expect(body.internship.pay.median).toBe(20000);

    const branches = Object.fromEntries(body.byBranch.map((r: { branch: string; placed: number; pool: number }) => [r.branch, [r.placed, r.pool]]));
    expect(branches).toEqual({ Computer: [2, 2], Mechanical: [0, 2] });
    expect(body.byCompany.map((c: { company: string }) => c.company)).toEqual(['Demo Analytics', 'Demo Systems']);
    expect(body.byCompany[0]).toMatchObject({ offers: 2, accepted: 1 });
    expect(body.notTracked.length).toBeGreaterThan(0);
  });

  it('never includes another college, and refuses a drive that is not its own', async () => {
    const w = await world();
    const callB = await officerOf(w.b.id, w.tenant.id);
    const { body } = await callB('/reports/college?year=2026');
    expect(body.pool).toBe(1);
    expect(body.final.pay.highest).toBe(900000);

    expect((await callB(`/reports/college?placementId=${w.finalA.id}`)).status).toBe(404);
  });

  it('reads a single drive when one is chosen', async () => {
    const w = await world();
    const call = await officerOf(w.a.id, w.tenant.id);
    const { body } = await call(`/reports/college?placementId=${w.finalA.id}`);
    expect(body.filter.placement.id).toBe(w.finalA.id);
    expect(body.final.placed).toBe(2);
    expect(body.internship.placed).toBe(0);
  });

  it('is closed where the institution does not have reports switched on', async () => {
    const w = await world();
    await db.tenantModule.update({
      where: { tenantId_moduleKey: { tenantId: w.tenant.id, moduleKey: 'compliance.reports' } },
      data: { enabled: false },
    });
    const call = await officerOf(w.a.id, w.tenant.id);
    expect((await call('/reports/college?year=2026')).status).toBe(403);
  });
});

describe('an institution report', () => {
  it('adds up its colleges, row by row, and nobody else', async () => {
    const w = await world();
    const call = await adminOf(w.tenant.id);
    const { status, body } = await call('/reports/tenant?year=2026');

    expect(status).toBe(200);
    expect(body.pool).toBe(5);
    expect(body.final.placed).toBe(3);
    // Odd count: 6,00,000 · 8,00,000 · 9,00,000.
    expect(body.final.pay.median).toBe(800000);
    expect(body.final.pay.highest).toBe(900000);

    const rows = Object.fromEntries(body.byCollege.map((r: { college: string; placed: number; pool: number }) => [r.college, [r.placed, r.pool]]));
    expect(rows).toEqual({ 'Demo College A': [2, 4], 'Demo College B': [1, 1] });
    expect(body.byCollege.reduce((n: number, r: { pool: number }) => n + r.pool, 0)).toBe(body.pool);
  });
});

describe('the workbook', () => {
  it('has a sheet for each form, and says "Not tracked" rather than inventing a number', async () => {
    const w = await world();
    const call = await officerOf(w.a.id, w.tenant.id);
    const { status, body } = await call('/reports/college.xlsx?year=2026');
    expect(status).toBe(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['NIRF Placement', 'NAAC 5.2.1', 'NBA by programme', 'By company', 'By branch', 'Notes']);

    const nirf = wb.getWorksheet('NIRF Placement')!.getRow(5);
    expect(nirf.getCell(2).value).toBe(4);
    expect(nirf.getCell(3).value).toBe(2);
    expect(nirf.getCell(4).value).toBe(700000);
    expect(nirf.getCell(5).value).toBe('Not tracked');
  });

  it('adds a sheet per college for an institution', async () => {
    const w = await world();
    const call = await adminOf(w.tenant.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await call('/reports/tenant.xlsx?year=2026')).body);
    expect(wb.worksheets.map((s) => s.name)).toContain('By college');
  });
});
