import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { MicroApplicationStatus, MicroProjectStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeStudent, makeTenant, systemRole } from './factories.js';
import { institutionRulesRouter } from '../src/modules/admin/institutionRules.routes.js';
import { passportFor } from '../src/modules/proof/passport.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Small gaps closed after the phases: an institution changing its own rules
 * after onboarding, and micro-internships reaching the passport.
 *
 * The rules are worth a test for who may change them and whose they change -
 * a tenant admin must only ever move their own institution's settings.
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
  app.use('/admin/institution-rules', institutionRulesRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (method: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/institution-rules`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function adminOf(tenantId: string | null, roleKey = 'admin.super') {
  const user = await db.user.create({
    data: { email: `adm-${Math.random()}@demo-college.example`, fullName: 'Demo Admin', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({ data: { userId: user.id, roleId: (await systemRole(roleKey)).id, tenantId } });
  return appFor({ userId: user.id, role: Role.ADMIN, tenantId: tenantId ?? undefined, isPlatform: tenantId === null });
}

describe('institution rules', () => {
  it('reads the rules and changes only the ones sent', async () => {
    const tenant = await makeTenant();
    const call = await adminOf(tenant.id);

    const before = await call('GET');
    expect(before.status).toBe(200);
    expect(before.body.rules).toEqual({
      oneOfferDefault: tenant.oneOfferDefault,
      allowSelfJoin: tenant.allowSelfJoin,
      responseDays: 7,
      companyApprovalRequired: false,
      unverifiedCompanyAccess: false,
    });

    const put = await call('PUT', { responseDays: 14, companyApprovalRequired: true });
    expect(put.status).toBe(200);
    expect(put.body.rules).toMatchObject({ responseDays: 14, companyApprovalRequired: true, allowSelfJoin: tenant.allowSelfJoin });
  });

  it('refuses a response time outside 1-30 days, and unknown or empty input', async () => {
    const tenant = await makeTenant();
    const call = await adminOf(tenant.id);
    expect((await call('PUT', { responseDays: 0 })).status).toBe(400);
    expect((await call('PUT', { responseDays: 31 })).status).toBe(400);
    expect((await call('PUT', { responseDays: 2.5 })).status).toBe(400);
    expect((await call('PUT', { name: 'Renamed' })).status).toBe(400);
    expect((await call('PUT', {})).status).toBe(400);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).responseDays).toBe(7);
  });

  it('lets an admin without settings:write read but not change them', async () => {
    const tenant = await makeTenant();
    const call = await adminOf(tenant.id, 'admin.university');
    expect((await call('GET')).status).toBe(200);
    expect((await call('PUT', { responseDays: 10 })).status).toBe(403);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).responseDays).toBe(7);
  });

  it("changes the caller's own institution and never another's", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const call = await adminOf(a.id);
    await call('PUT', { responseDays: 21, allowSelfJoin: !a.allowSelfJoin });

    const rowA = await db.tenant.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await db.tenant.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowA.responseDays).toBe(21);
    expect(rowB.responseDays).toBe(7);
    expect(rowB.allowSelfJoin).toBe(b.allowSelfJoin);
  });

  it('asks the platform team to choose an institution first', async () => {
    const call = await adminOf(null);
    expect((await call('GET')).status).toBe(403);
    expect((await call('PUT', { responseDays: 10 })).status).toBe(403);
  });

  it('is closed to anyone who is not an admin', async () => {
    const tenant = await makeTenant();
    const call = appFor({ userId: 'nobody', role: Role.CAMPUS, tenantId: tenant.id });
    expect((await call('GET')).status).toBe(403);
  });
});

describe('micro-internships on the passport', () => {
  it('lists completed, rated work as employer-verified, and nothing else', async () => {
    const college = await makeCollege();
    const batch = await makeBatch(college.id);
    const { candidate } = await makeStudent(batch.id, { collegeId: college.id });
    const company = await makeCompany('Demo Analytics');

    const project = (title: string) =>
      db.microProject.create({
        data: {
          companyId: company.id,
          title,
          brief: 'A short piece of real work.',
          hours: 20,
          stipend: 5000,
          deadline: new Date(Date.now() + 7 * 86400000),
          status: MicroProjectStatus.COMPLETED,
        },
      });
    const rated = await project('Sales dashboard');
    const unrated = await project('Data cleanup');
    const ongoing = await project('Survey analysis');

    await db.microApplication.createMany({
      data: [
        { projectId: rated.id, candidateId: candidate.id, pitch: 'x', status: MicroApplicationStatus.COMPLETED, rating: 4 },
        { projectId: unrated.id, candidateId: candidate.id, pitch: 'x', status: MicroApplicationStatus.COMPLETED },
        { projectId: ongoing.id, candidateId: candidate.id, pitch: 'x', status: MicroApplicationStatus.SELECTED, rating: 5 },
      ],
    });

    const passport = await passportFor(candidate.id);
    const micro = passport.claims.filter((c) => c.label.startsWith('Micro-internship'));
    expect(micro).toEqual([
      expect.objectContaining({
        label: 'Micro-internship: Sales dashboard for Demo Analytics',
        detail: 'rated 4/5',
        evidence: 'EMPLOYER_VERIFIED',
      }),
    ]);
  });
});
