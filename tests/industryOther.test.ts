import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeCompany, makeRecruiter, systemRole } from './factories.js';
import { industriesRouter } from '../src/modules/admin/industries.routes.js';
import { companyRouter } from '../src/modules/company/company.routes.js';
import { registerCompany } from '../src/modules/company/registration.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * A company whose industry is not on the shared list.
 *
 * The list stays the platform's to edit - that is what makes "IT Services"
 * mean the same thing everywhere - so a company says what it does instead,
 * and operations settles it while verifying. What must never happen is a
 * company stuck at registration with nothing that fits.
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
  app.use('/admin/industries', industriesRouter);
  app.use('/company', companyRouter);
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
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

/** Platform staff: an admin with no institution of their own. */
async function platformStaff() {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@test.local`, fullName: 'Ops', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({
    data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId: null },
  });
  return { userId: user.id, role: Role.ADMIN, isPlatform: true } as Session;
}

describe('an industry that is not on the list', () => {
  it('lets a company register with what it typed', async () => {
    await systemRole('company.owner');
    const { company } = await registerCompany({
      company: { name: 'Demo Harvesters', industryOther: 'Agricultural machinery' } as never,
      contact: { fullName: 'Demo HR', email: 'hr@demo-harvesters.example', password: 'Test@Apli2026!' },
    });

    expect(company.industryOther).toBe('Agricultural machinery');
    expect(company.industryId).toBeNull();
  });

  it('adds what they typed to the shared list, and points the company at it', async () => {
    const company = await makeCompany('Demo Harvesters');
    await db.company.update({ where: { id: company.id }, data: { industryOther: 'Agricultural machinery' } });

    const call = appFor(await platformStaff());
    const res = await call('POST', '/admin/industries/resolve', { companyId: company.id });

    expect(res.status).toBe(200);
    expect(res.body.company.industry.name).toBe('Agricultural machinery');

    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.industryOther).toBeNull();
    expect(after.industryId).toBe(res.body.company.industry.id);
  });

  it('reuses an industry that is already there, whatever the case', async () => {
    const existing = await db.industry.create({ data: { name: 'Agricultural Machinery' } });
    const company = await makeCompany('Demo Harvesters');
    await db.company.update({ where: { id: company.id }, data: { industryOther: 'agricultural machinery' } });

    const call = appFor(await platformStaff());
    await call('POST', '/admin/industries/resolve', { companyId: company.id });

    expect(await db.industry.count()).toBe(1);
    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.industryId).toBe(existing.id);
  });

  it('can point the company at one we already have instead', async () => {
    const manufacturing = await db.industry.create({ data: { name: 'Manufacturing' } });
    const company = await makeCompany('Demo Harvesters');
    await db.company.update({ where: { id: company.id }, data: { industryOther: 'Tractor parts' } });

    const call = appFor(await platformStaff());
    const res = await call('POST', '/admin/industries/resolve', {
      companyId: company.id,
      industryId: manufacturing.id,
    });

    expect(res.status).toBe(200);
    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.industryId).toBe(manufacturing.id);
    expect(after.industryOther).toBeNull();
    // The suggestion was a wording, not a new industry.
    expect(await db.industry.count()).toBe(1);
  });

  it('holds one answer at a time when the company edits its own profile', async () => {
    const industry = await db.industry.create({ data: { name: 'IT Services' } });
    const company = await makeCompany('Demo Harvesters');
    await db.company.update({ where: { id: company.id }, data: { industryOther: 'Tractor parts' } });
    const recruiter = await makeRecruiter(company.id);
    const call = appFor({ userId: recruiter.id, role: Role.COMPANY });

    const picked = await call('PATCH', '/company/profile', { industryId: industry.id });
    expect(picked.status).toBe(200);
    expect((await db.company.findUniqueOrThrow({ where: { id: company.id } })).industryOther).toBeNull();

    const typed = await call('PATCH', '/company/profile', { industryOther: 'Tractor parts' });
    expect(typed.status).toBe(200);
    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.industryId).toBeNull();
    expect(after.industryOther).toBe('Tractor parts');
  });

  it('is the platform team to settle, not an institution', async () => {
    const company = await makeCompany('Demo Harvesters');
    await db.company.update({ where: { id: company.id }, data: { industryOther: 'Tractor parts' } });

    const user = await db.user.create({
      data: { email: `adm-${Math.random()}@test.local`, fullName: 'Uni Admin', passwordHash: 'x', role: Role.ADMIN },
    });
    const tenant = await db.tenant.create({ data: { name: 'Some University', slug: `u-${Math.random()}`.slice(0, 20) } });
    await db.adminMember.create({
      data: { userId: user.id, roleId: (await systemRole('admin.university')).id, tenantId: tenant.id },
    });

    const call = appFor({ userId: user.id, role: Role.ADMIN, tenantId: tenant.id, isPlatform: false });
    const res = await call('POST', '/admin/industries/resolve', { companyId: company.id });

    expect(res.status).toBe(403);
  });
});
