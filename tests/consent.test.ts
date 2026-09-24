import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent, makeTenant, systemRole } from './factories.js';
import { consentRouter } from '../src/modules/consent/consent.routes.js';
import { assertApplyConsent } from '../src/modules/consent/consent.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The consent centre. What matters is invisible in a demo: that answers are
 * never overwritten, that the latest one is the one that counts, and that a
 * college sees numbers, never names - and only its own students' numbers.
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
  app.use('/consent', consentRouter);
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

async function tenantWithConsent(on = true) {
  const tenant = await makeTenant();
  if (on) await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'compliance.consent', enabled: true } });
  return tenant;
}

async function studentIn(tenantId: string, collegeId?: string) {
  const college = collegeId ? { id: collegeId } : await makeCollege('Consent College', tenantId);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId });
  return { call, candidate, collegeId: college.id };
}

const find = (purposes: { key: string }[], key: string) => purposes.find((p) => p.key === key) as never as {
  granted: boolean | null;
  history: { granted: boolean }[];
};

describe('a student’s consent', () => {
  it('keeps every answer, and the latest one counts', async () => {
    const tenant = await tenantWithConsent();
    const { call, candidate } = await studentIn(tenant.id);

    const first = await call('GET', '/consent');
    expect(first.status).toBe(200);
    expect(find(first.body.purposes, 'placement_statistics').granted).toBeNull();

    await call('PUT', '/consent', { purpose: 'placement_statistics', granted: true });
    const after = await call('PUT', '/consent', { purpose: 'placement_statistics', granted: false });
    const p = find(after.body.purposes, 'placement_statistics');
    expect(p.granted).toBe(false);
    expect(p.history.map((h) => h.granted)).toEqual([false, true]);
    expect(await db.consentRecord.count({ where: { candidateId: candidate.id } })).toBe(2);
  });

  it('refuses a purpose that does not exist', async () => {
    const tenant = await tenantWithConsent();
    const { call } = await studentIn(tenant.id);
    expect((await call('PUT', '/consent', { purpose: 'sell_my_data', granted: true })).status).toBe(400);
    expect((await call('PUT', '/consent/bulk', { grants: { sell_my_data: true } })).status).toBe(400);
  });

  it('lets applying through once what it needs is allowed in one go', async () => {
    const tenant = await tenantWithConsent();
    const { call, candidate } = await studentIn(tenant.id);

    await expect(assertApplyConsent(candidate.id, tenant.id)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });

    const res = await call('PUT', '/consent/bulk', {
      grants: { share_profile_with_recruiters: true, share_marks_with_recruiters: true },
    });
    expect(res.status).toBe(200);
    await expect(assertApplyConsent(candidate.id, tenant.id)).resolves.toBeUndefined();
  });

  it('is closed where the institution has not switched the consent centre on', async () => {
    const tenant = await tenantWithConsent(false);
    const { call, candidate } = await studentIn(tenant.id);
    expect((await call('GET', '/consent')).status).toBe(403);
    // ...and applying is not held up by a centre the student cannot reach.
    await expect(assertApplyConsent(candidate.id, tenant.id)).resolves.toBeUndefined();
  });
});

describe('the college’s view', () => {
  it('counts only its own students, and names none of them', async () => {
    const tenant = await tenantWithConsent();
    const a = await studentIn(tenant.id);
    const b = await studentIn(tenant.id, a.collegeId);
    const elsewhere = await studentIn(tenant.id);

    await a.call('PUT', '/consent', { purpose: 'placement_statistics', granted: true });
    await b.call('PUT', '/consent', { purpose: 'placement_statistics', granted: true });
    await b.call('PUT', '/consent', { purpose: 'placement_statistics', granted: false });
    await elsewhere.call('PUT', '/consent', { purpose: 'placement_statistics', granted: true });

    const officer = await db.user.create({
      data: { email: `tpo-${Math.random()}@test.local`, fullName: 'Officer', passwordHash: 'x', role: Role.CAMPUS },
    });
    await db.campusMember.create({
      data: { userId: officer.id, collegeId: a.collegeId, roleId: (await systemRole('campus.officer')).id },
    });
    const college = appFor({ userId: officer.id, role: Role.CAMPUS, collegeId: a.collegeId, tenantId: tenant.id });

    const res = await college('GET', '/consent/college');
    expect(res.status).toBe(200);
    const stats = res.body.purposes.find((p: { key: string }) => p.key === 'placement_statistics');
    expect(stats).toMatchObject({ students: 2, granted: 1, withdrew: 1, declined: 0, neverAnswered: 0 });
    expect(JSON.stringify(res.body)).not.toContain(a.candidate.id);
  });
});
