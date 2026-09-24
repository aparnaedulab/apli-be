import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeCompany, makeRecruiter, systemRole } from './factories.js';
import { companyRouter } from '../src/modules/company/company.routes.js';
import { rolesRouter } from '../src/modules/roles/roles.routes.js';
import { SCOPE_PERMISSIONS } from '../src/modules/roles/permissions.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Who works at a company, and which of them may say so.
 *
 * The rule worth pinning is the one that has no screen: a company must always
 * be left with somebody who can manage its team. Every other mistake here is
 * recoverable by the person who made it; that one locks a company out of its
 * own account list with nobody able to let anyone back in.
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
  app.use('/company', companyRouter);
  app.use('/admin/roles', rolesRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

/** Somebody at this company holding the given role. */
async function memberOf(companyId: string, roleKey: string) {
  const user = await db.user.create({
    data: {
      email: `person-${Math.random().toString(36).slice(2)}@demo-company.example`,
      fullName: 'Demo Colleague',
      passwordHash: 'x',
      role: Role.COMPANY,
    },
  });
  const member = await db.companyMember.create({
    data: { userId: user.id, companyId, roleId: (await systemRole(roleKey)).id },
  });
  return { user, member, call: appFor({ userId: user.id, role: Role.COMPANY, companyId }) };
}

describe('reading the team', () => {
  it('says what the person asking may do, so the screen can hide what they cannot', async () => {
    const company = await makeCompany('Demo Tech');
    await makeRecruiter(company.id); // an owner
    const { call } = await memberOf(company.id, 'company.interviewer');

    const res = await call('GET', '/company/team');

    expect(res.status).toBe(200);
    expect(res.body.myPermissions).not.toContain('team:manage');
  });

  it('carries each role with its permissions, not just a name to guess from', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });

    const res = await call('GET', '/company/team');

    expect(res.status).toBe(200);
    expect(res.body.members[0].role.name).toBe('Owner');
    expect(res.body.members[0].role.permissions).toContain('team:manage');
  });
});

describe('changing what a colleague may do', () => {
  it('promotes somebody to a role that can manage the team', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });
    const { member } = await memberOf(company.id, 'company.recruiter');

    const res = await call('PATCH', `/company/team/${member.id}`, {
      roleId: (await systemRole('company.owner')).id,
    });

    expect(res.status).toBe(200);
    expect(res.body.member.role.permissions).toContain('team:manage');

    // And they can now actually do it, which is the point of the change.
    const theirs = appFor({ userId: (await db.companyMember.findUniqueOrThrow({ where: { id: member.id } })).userId, role: Role.COMPANY, companyId: company.id });
    const mine = await theirs('GET', '/company/team');
    expect(mine.body.myPermissions).toContain('team:manage');
  });

  it('is closed to a role that cannot manage the team', async () => {
    const company = await makeCompany('Demo Tech');
    await makeRecruiter(company.id);
    const theirs = await memberOf(company.id, 'company.recruiter');
    const target = await memberOf(company.id, 'company.interviewer');

    const res = await theirs.call('PATCH', `/company/team/${target.member.id}`, {
      roleId: (await systemRole('company.owner')).id,
    });

    expect(res.status).toBe(403);
  });

  it('refuses to demote the only person who can manage the team', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });
    const me = await db.companyMember.findFirstOrThrow({ where: { userId: owner.id } });
    await memberOf(company.id, 'company.recruiter');

    const res = await call('PATCH', `/company/team/${me.id}`, {
      roleId: (await systemRole('company.interviewer')).id,
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/only person who can manage the team/i);
  });

  it('allows the demotion once somebody else can manage the team', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });
    const me = await db.companyMember.findFirstOrThrow({ where: { userId: owner.id } });
    await memberOf(company.id, 'company.owner');

    const res = await call('PATCH', `/company/team/${me.id}`, {
      roleId: (await systemRole('company.recruiter')).id,
    });

    expect(res.status).toBe(200);
  });

  it('will not hand out a role from another part of the platform', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });
    const { member } = await memberOf(company.id, 'company.recruiter');

    const res = await call('PATCH', `/company/team/${member.id}`, {
      roleId: (await systemRole('admin.super')).id,
    });

    expect(res.status).toBe(404);
  });

  it('changes nobody at another company', async () => {
    const mine = await makeCompany('Demo Tech');
    const theirs = await makeCompany('Demo Rivals');
    const owner = await makeRecruiter(mine.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: mine.id });
    const { member } = await memberOf(theirs.id, 'company.recruiter');

    const res = await call('PATCH', `/company/team/${member.id}`, {
      roleId: (await systemRole('company.owner')).id,
    });

    expect(res.status).toBe(404);
  });
});

describe('removing a colleague', () => {
  it('removes somebody who can manage the team while another still can', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const other = await memberOf(company.id, 'company.owner');
    const theirs = appFor({ userId: other.user.id, role: Role.COMPANY, companyId: company.id });
    const ownerMember = await db.companyMember.findFirstOrThrow({ where: { userId: owner.id } });

    const res = await theirs('DELETE', `/company/team/${ownerMember.id}`);

    expect(res.status).toBe(204);
    expect(await db.companyMember.count({ where: { companyId: company.id } })).toBe(1);
  });

  /*
   * Removing cannot be what strands a company, because whoever is doing the
   * removing holds `team:manage` themselves and cannot remove themselves - so
   * one of them is always left. The guard in the route is there for the day
   * that stops being true; the way a company can actually reach zero admins
   * is by demotion, which is covered above.
   */
  it('never lets somebody remove themselves', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });
    const me = await db.companyMember.findFirstOrThrow({ where: { userId: owner.id } });

    const res = await call('DELETE', `/company/team/${me.id}`);

    expect(res.status).toBe(403);
  });
});

describe('what a role lets somebody do', () => {
  it('offers a company its own roles, and the catalogue to read them against', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });
    await systemRole('company.recruiter');
    await systemRole('admin.super');

    const res = await call('GET', '/admin/roles/assignable');

    expect(res.status).toBe(200);
    // Their own world only: an operations role is not theirs to hand out.
    expect(res.body.roles.map((r: { name: string }) => r.name)).toContain('Recruiter');
    expect(res.body.roles.map((r: { name: string }) => r.name)).not.toContain('Super admin');

    // Every capability a company account can hold, each with words a person
    // reads - so a screen can show what a role does *not* carry too.
    expect(res.body.catalogue.map((c: { key: string }) => c.key)).toEqual(
      SCOPE_PERMISSIONS.COMPANY,
    );
    expect(res.body.catalogue.find((c: { key: string }) => c.key === 'team:manage')).toEqual({
      key: 'team:manage',
      label: 'Invite and remove colleagues',
    });
  });

  it('never names a capability a company account could not hold', async () => {
    const company = await makeCompany('Demo Tech');
    const owner = await makeRecruiter(company.id);
    const call = appFor({ userId: owner.id, role: Role.COMPANY, companyId: company.id });

    const res = await call('GET', '/admin/roles/assignable');

    const keys = res.body.catalogue.map((c: { key: string }) => c.key);
    expect(keys).not.toContain('company:verify');
    expect(keys).not.toContain('student:verify');
    expect(keys.every((k: string) => Boolean(k))).toBe(true);
  });
});
