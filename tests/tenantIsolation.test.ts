import { afterEach, describe, expect, it } from 'vitest';
import express, { type Router } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role, RoleScope } from '@prisma/client';
import { db } from './setup.js';
import { makeCollege, makeCompany, makeTenant, systemRole } from './factories.js';
import { collegesRouter } from '../src/modules/admin/colleges.routes.js';
import { companiesRouter } from '../src/modules/admin/companies.routes.js';
import { rolesRouter } from '../src/modules/roles/roles.routes.js';
import { adminRouter } from '../src/modules/admin/admin.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The fence between institutions.
 *
 * These go through the real routers, with a session planted the way sign-in
 * would plant it, because the promise being tested lives in the handlers: a
 * tenant admin who guesses another institution's id must get what a wrong id
 * gets, and the things every institution shares must not be changeable from
 * inside any one of them.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

/** An app with the admin routers mounted and one caller signed in. */
function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Only the fields the handlers read; express-session is not under test.
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  const mount: [string, Router][] = [
    ['/admin/colleges', collegesRouter],
    ['/admin/companies', companiesRouter],
    ['/admin/roles', rolesRouter],
    ['/admin', adminRouter],
  ];
  for (const [path, router] of mount) app.use(path, router);
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

/** An operations account holding the full admin role, in a tenant or on the platform. */
async function operations(tenantId: string | null) {
  const user = await db.user.create({
    data: {
      email: `ops-${Math.random()}@test.local`,
      fullName: 'Operations',
      passwordHash: 'x',
      role: Role.ADMIN,
    },
  });
  await db.adminMember.create({
    data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId },
  });
  return user;
}

async function twoInstitutions() {
  const a = await makeTenant('University A');
  const b = await makeTenant('University B');
  const collegeA = await makeCollege('College of A', a.id);
  const collegeB = await makeCollege('College of B', b.id);
  return { a, b, collegeA, collegeB };
}

describe('a tenant admin', () => {
  it('lists only their own colleges', async () => {
    const w = await twoInstitutions();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    const res = await call('GET', '/admin/colleges');

    expect(res.status).toBe(200);
    expect(res.body.colleges.map((c: { name: string }) => c.name)).toEqual(['College of A']);
  });

  it('gets a 404 for another institution’s college, exactly like a wrong id', async () => {
    const w = await twoInstitutions();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    expect((await call('GET', `/admin/colleges/${w.collegeB.id}`)).status).toBe(404);
    expect((await call('GET', '/admin/colleges/no-such-id')).status).toBe(404);
    expect(
      (
        await call('PATCH', `/admin/colleges/${w.collegeB.id}/verify`, { isVerified: true })
      ).status,
    ).toBe(404);

    // And nothing changed behind the refusal.
    const untouched = await db.college.findUniqueOrThrow({ where: { id: w.collegeB.id } });
    expect(untouched.isVerified).toBe(false);
  });

  it('creates colleges inside their own institution, whatever the body says', async () => {
    const w = await twoInstitutions();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    const res = await call('POST', '/admin/colleges', {
      name: 'New College',
      code: 'NEWC',
      city: 'Pune',
      state: 'Maharashtra',
      tenantId: w.b.id,
    });

    expect(res.status).toBe(201);
    const made = await db.college.findUniqueOrThrow({ where: { code: 'NEWC' } });
    expect(made.tenantId).toBe(w.a.id);
  });

  it('counts only their own institution on the overview', async () => {
    const w = await twoInstitutions();
    await makeCollege('Second of B', w.b.id);
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    const res = await call('GET', '/admin/stats');

    expect(res.status).toBe(200);
    expect(res.body.stats.colleges).toBe(1);
  });

  it('cannot create or edit a role, because roles are shared by every institution', async () => {
    const w = await twoInstitutions();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });
    const coordinator = await systemRole('campus.coordinator');

    const created = await call('POST', '/admin/roles', {
      name: 'Sneaky',
      scope: RoleScope.CAMPUS,
      permissions: ['batch:read'],
    });
    const edited = await call('PATCH', `/admin/roles/${coordinator.id}`, { name: 'Renamed' });

    expect(created.status).toBe(403);
    expect(edited.status).toBe(403);
    expect(await db.platformRole.count({ where: { name: 'Sneaky' } })).toBe(0);

    // Reading them is still ordinary work.
    expect((await call('GET', '/admin/roles')).status).toBe(200);
  });

  it('cannot verify a company, because companies hire at every institution', async () => {
    const w = await twoInstitutions();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });
    const company = await makeCompany('Pending Co', false);

    const res = await call('POST', `/admin/companies/${company.id}/decision`, {
      decision: 'VERIFY',
    });

    expect(res.status).toBe(403);
    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.status).toBe('PENDING');
  });
});

describe('the platform team', () => {
  it('sees only the institution it has stepped into', async () => {
    const w = await twoInstitutions();
    const staff = await operations(null);
    const inA = appFor({ userId: staff.id, role: Role.ADMIN, isPlatform: true, tenantId: w.a.id });
    const inB = appFor({ userId: staff.id, role: Role.ADMIN, isPlatform: true, tenantId: w.b.id });

    const a = await inA('GET', '/admin/colleges');
    const b = await inB('GET', '/admin/colleges');

    expect(a.body.colleges.map((c: { name: string }) => c.name)).toEqual(['College of A']);
    expect(b.body.colleges.map((c: { name: string }) => c.name)).toEqual(['College of B']);
    expect((await inA('GET', `/admin/colleges/${w.collegeB.id}`)).status).toBe(404);
  });

  it('is asked to choose an institution before the tenant screens will answer', async () => {
    const staff = await operations(null);
    const call = appFor({ userId: staff.id, role: Role.ADMIN, isPlatform: true });

    expect((await call('GET', '/admin/colleges')).status).toBe(403);
  });

  it('may edit the shared roles that a tenant admin may not', async () => {
    const w = await twoInstitutions();
    const staff = await operations(null);
    const call = appFor({ userId: staff.id, role: Role.ADMIN, isPlatform: true, tenantId: w.a.id });
    await systemRole('campus.officer');

    const res = await call('POST', '/admin/roles', {
      name: 'Placement intern',
      scope: RoleScope.CAMPUS,
      permissions: ['batch:read'],
    });

    expect(res.status).toBe(201);
  });
});
