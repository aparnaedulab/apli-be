import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { PostingStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import {
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makeRecruiter,
  makeStudent,
  makeTenant,
  systemRole,
} from './factories.js';
import { companyAccessRouter } from '../src/modules/companyAccess/companyAccess.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import {
  annotateForCompany,
  companyMayReach,
} from '../src/modules/companyAccess/companyAccess.service.js';
import { setTargets } from '../src/modules/jobs/job.service.js';
import { sendRoleToPool } from '../src/modules/network/network.service.js';
import { proposeWeek } from '../src/modules/opportunities/opportunities.service.js';
import { SHOWCASE_PURPOSE, discoverable } from '../src/modules/community/community.service.js';

/**
 * Per-institution company approval.
 *
 * The setting is off by default, and off must mean nothing changes. On, a
 * company reaches an institution's colleges only after that institution says
 * yes - through every door: postings, pools, campus weeks and talent.
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
  app.use('/company-access', companyAccessRouter);
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

async function tenantAdmin(tenantId: string | null, roleKey = 'admin.university') {
  const user = await db.user.create({
    data: { email: `adm-${Math.random()}@test.local`, fullName: 'Tenant Admin', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({ data: { userId: user.id, roleId: (await systemRole(roleKey)).id, tenantId } });
  return user;
}

/** An institution with the setting on, one college and an open drive; and a verified company. */
async function world(approvalRequired = true) {
  const tenant = await makeTenant('Gated University');
  await db.tenant.update({ where: { id: tenant.id }, data: { companyApprovalRequired: approvalRequired } });
  const college = await makeCollege('Gated College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const company = await makeCompany('Acme');
  const recruiter = await makeRecruiter(company.id);
  const job = await makeJob(company.id, recruiter.id);
  return { tenant, college, batch, drive, company, recruiter, job };
}

async function setAccess(tenantId: string, companyId: string, status: 'PENDING' | 'APPROVED' | 'BLOCKED') {
  await db.tenantCompany.upsert({
    where: { tenantId_companyId: { tenantId, companyId } },
    create: { tenantId, companyId, status },
    update: { status },
  });
}

describe('companyMayReach', () => {
  it('is always yes while the setting is off, even with a block on record', async () => {
    const w = await world(false);
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(true);
    await setAccess(w.tenant.id, w.company.id, 'BLOCKED');
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(true);
  });

  it('with the setting on, needs an APPROVED row - pending and blocked are both no', async () => {
    const w = await world();
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(false);
    await setAccess(w.tenant.id, w.company.id, 'PENDING');
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(false);
    await setAccess(w.tenant.id, w.company.id, 'APPROVED');
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(true);
    await setAccess(w.tenant.id, w.company.id, 'BLOCKED');
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(false);
  });
});

describe('postings', () => {
  it('changes nothing when the setting is off', async () => {
    const w = await world(false);
    const job = await db.job.findUniqueOrThrow({ where: { id: w.job.id } });
    expect(await setTargets(job, [{ placementId: w.drive.id }])).toEqual({ targets: 1 });
  });

  it('refuses a drive at an institution that has not approved the company, naming it', async () => {
    const w = await world();
    const job = await db.job.findUniqueOrThrow({ where: { id: w.job.id } });
    await expect(setTargets(job, [{ placementId: w.drive.id }])).rejects.toMatchObject({
      status: 409,
      details: { needsApproval: [{ tenantId: w.tenant.id, name: 'Gated University' }] },
    });
    expect(await db.jobPosting.count({ where: { jobId: job.id } })).toBe(0);

    await setAccess(w.tenant.id, w.company.id, 'APPROVED');
    expect(await setTargets(job, [{ placementId: w.drive.id }])).toEqual({ targets: 1 });
  });

  it('leaves postings that already exist alone after a later block', async () => {
    const w = await world();
    await setAccess(w.tenant.id, w.company.id, 'APPROVED');
    const job = await db.job.findUniqueOrThrow({ where: { id: w.job.id } });
    await setTargets(job, [{ placementId: w.drive.id }]);
    await setAccess(w.tenant.id, w.company.id, 'BLOCKED');
    expect(await setTargets(job, [{ placementId: w.drive.id }])).toEqual({ targets: 1 });
  });

  it('marks drives on the targeting list that need approval', async () => {
    const w = await world();
    const open = await makeTenant('Open University');
    const openCollege = await makeCollege('Open College', open.id);
    const drives = [
      { id: 'a', college: { tenantId: w.tenant.id } },
      { id: 'b', college: { tenantId: openCollege.tenantId } },
    ];
    const marked = await annotateForCompany(w.company.id, drives);
    expect(marked.map((d) => d.needsApproval)).toEqual([true, false]);
  });
});

describe('pooled drives', () => {
  it('skips members at institutions that have not approved the company, and says which', async () => {
    const w = await world();
    const openTenant = await makeTenant('Open University');
    await db.tenantModule.createMany({
      data: [
        { tenantId: w.tenant.id, moduleKey: 'ops.pooledDrives', enabled: true },
        { tenantId: openTenant.id, moduleKey: 'ops.pooledDrives', enabled: true },
      ],
    });
    const openCollege = await makeCollege('Open College', openTenant.id);
    const openDrive = await makeDrive(openCollege.id, (await makeBatch(openCollege.id)).id);
    const pool = await db.pooledDrive.create({
      data: {
        tenantId: openTenant.id,
        hostCollegeId: openCollege.id,
        name: 'Pune pool',
        year: 2026,
        members: {
          create: [
            { collegeId: openCollege.id, placementId: openDrive.id, status: 'JOINED' },
            { collegeId: w.college.id, placementId: w.drive.id, status: 'JOINED' },
          ],
        },
      },
    });

    const result = await sendRoleToPool(pool.id, w.company.id, w.job.id);
    expect(result).toMatchObject({ created: 1, skippedNeedsApproval: 1, needsApproval: ['Gated University'] });
    const postings = await db.jobPosting.findMany({ where: { jobId: w.job.id } });
    expect(postings.map((p) => p.placementId)).toEqual([openDrive.id]);
    expect(postings[0]!.status).toBe(PostingStatus.PENDING);
  });
});

describe('campus weeks', () => {
  it('refuses a proposal to a college whose institution has not approved the company', async () => {
    const w = await world();
    await db.tenantModule.create({ data: { tenantId: w.tenant.id, moduleKey: 'showcase.campusWeeks', enabled: true } });
    const start = new Date(Date.now() + 3 * 86400000);
    const input = {
      collegeId: w.college.id,
      title: 'Acme week',
      startDate: start,
      endDate: new Date(start.getTime() + 2 * 86400000),
      events: [{ kind: 'TALK' as const, title: 'Hello', startsAt: new Date(start.getTime() + 3600000), durationMin: 60 }],
    };
    await expect(proposeWeek(w.company.id, 'Acme', input)).rejects.toMatchObject({ status: 409 });
    expect(await db.campusWeek.count()).toBe(0);

    await setAccess(w.tenant.id, w.company.id, 'APPROVED');
    await proposeWeek(w.company.id, 'Acme', input);
    expect(await db.campusWeek.count()).toBe(1);
  });
});

describe('talent', () => {
  it('hides students of institutions that have not approved the looking company', async () => {
    const w = await world();
    await db.tenantModule.create({ data: { tenantId: w.tenant.id, moduleKey: 'showcase.student', enabled: true } });
    const s = await makeStudent(w.batch.id, { collegeId: w.college.id });
    await db.showcaseProfile.create({ data: { candidateId: s.candidate.id, visibility: 'RECRUITERS' } });
    await db.consentRecord.create({ data: { candidateId: s.candidate.id, purpose: SHOWCASE_PURPOSE, granted: true } });

    expect(await discoverable({})).toHaveLength(1); // no company given: unchanged
    expect(await discoverable({}, undefined, w.company.id)).toHaveLength(0);
    await setAccess(w.tenant.id, w.company.id, 'APPROVED');
    expect(await discoverable({}, undefined, w.company.id)).toHaveLength(1);
  });
});

describe('routes', () => {
  it('a company asks, the institution admin hears it and approves, the company hears back', async () => {
    const w = await world();
    const admin = await tenantAdmin(w.tenant.id);
    const asCompany = appFor({ userId: w.recruiter.id, role: Role.COMPANY, companyId: w.company.id });
    const asAdmin = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.tenant.id });

    const list = await asCompany('GET', '/company-access/company');
    expect(list.status).toBe(200);
    expect(list.body.institutions).toMatchObject([{ tenantId: w.tenant.id, status: 'NONE' }]);

    const asked = await asCompany('POST', `/company-access/company/${w.tenant.id}/request`, { note: 'We hire freshers.' });
    expect(asked.body).toEqual({ status: 'PENDING', notified: 1 });
    expect(await db.notification.count({ where: { userId: admin.id, type: 'COMPANY_ACCESS_REQUESTED' } })).toBe(1);

    const queue = await asAdmin('GET', '/company-access/tenant');
    expect(queue.body).toMatchObject({ approvalRequired: true, requests: [{ companyId: w.company.id, status: 'PENDING', note: 'We hire freshers.' }] });

    const decided = await asAdmin('POST', `/company-access/tenant/${w.company.id}/decision`, { status: 'APPROVED' });
    expect(decided.status).toBe(200);
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(true);
    expect(await db.notification.count({ where: { userId: w.recruiter.id, type: 'COMPANY_ACCESS_DECIDED' } })).toBe(1);
  });

  it('a blocked company cannot ask again', async () => {
    const w = await world();
    await setAccess(w.tenant.id, w.company.id, 'BLOCKED');
    const asCompany = appFor({ userId: w.recruiter.id, role: Role.COMPANY, companyId: w.company.id });
    const res = await asCompany('POST', `/company-access/company/${w.tenant.id}/request`, {});
    expect(res.status).toBe(403);
  });

  it("an admin decides only for their own institution - the tenant comes from the session", async () => {
    const w = await world();
    const other = await makeTenant('Other University');
    const otherAdmin = await tenantAdmin(other.id);
    const asOther = appFor({ userId: otherAdmin.id, role: Role.ADMIN, tenantId: other.id });

    await asOther('POST', `/company-access/tenant/${w.company.id}/decision`, { status: 'APPROVED' });
    // Recorded against the other institution, never against the gated one.
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(false);
    const queue = await asOther('GET', '/company-access/tenant');
    expect(queue.body.requests).toHaveLength(1);
    expect(await db.tenantCompany.count({ where: { tenantId: w.tenant.id } })).toBe(0);
  });

  it('refuses admins without company:verify, and platform staff until they step into a tenant', async () => {
    const w = await world();
    const auditor = await tenantAdmin(w.tenant.id, 'admin.auditor');
    const asAuditor = appFor({ userId: auditor.id, role: Role.ADMIN, tenantId: w.tenant.id });
    expect((await asAuditor('POST', `/company-access/tenant/${w.company.id}/decision`, { status: 'APPROVED' })).status).toBe(403);

    const staff = await tenantAdmin(null, 'admin.super');
    const outside = appFor({ userId: staff.id, role: Role.ADMIN, isPlatform: true });
    expect((await outside('GET', '/company-access/tenant')).status).toBe(403);

    const inside = appFor({ userId: staff.id, role: Role.ADMIN, isPlatform: true, tenantId: w.tenant.id });
    expect((await inside('POST', `/company-access/tenant/${w.company.id}/decision`, { status: 'APPROVED' })).status).toBe(200);
    expect(await companyMayReach(w.company.id, w.tenant.id)).toBe(true);
  });
});
