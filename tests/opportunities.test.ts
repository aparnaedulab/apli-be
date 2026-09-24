import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeRecruiter, makeStudent, makeTenant, systemRole } from './factories.js';
import { opportunitiesRouter } from '../src/modules/opportunities/opportunities.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Micro-internships and campus weeks. The rules worth testing are the ones a
 * demo hides: no unpaid work, never more students chosen than places, only a
 * chosen student hands in work, companies never see each other's projects,
 * and a campus week stays inside its college - with the company told how many
 * came, never who.
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
  app.use('/o', opportunitiesRouter);
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

async function tenantWith(...modules: string[]) {
  const tenant = await makeTenant();
  for (const m of modules) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: m, enabled: true } });
  }
  return tenant;
}

async function student(tenantId: string, collegeId: string) {
  const batch = await makeBatch(collegeId);
  const { user, candidate } = await makeStudent(batch.id, { collegeId });
  const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId });
  return { user, candidate, call };
}

async function recruiter(verified = true) {
  const company = await makeCompany(undefined, verified);
  const user = await makeRecruiter(company.id);
  return { company, user, call: appFor({ userId: user.id, role: Role.COMPANY, companyId: company.id }) };
}

async function officer(tenantId: string, collegeId: string, roleKey = 'campus.officer') {
  const user = await db.user.create({
    data: { email: `po-${Math.random()}@test.local`, fullName: 'Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: user.id, collegeId, roleId: (await systemRole(roleKey)).id } });
  return appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId });
}

const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const project = (over: Record<string, unknown> = {}) => ({
  title: 'Clean up a demo sales dashboard',
  brief: 'Rebuild three charts in the demo dashboard so a manager can read weekly sales at a glance, and write a short note on what changed.',
  hours: 20,
  stipend: 6000,
  skills: ['Excel', 'Data visualisation'],
  slots: 1,
  deadline: inDays(10).toISOString(),
  ...over,
});

const PITCH = 'I have built two dashboards for my college fest and enjoy making numbers easy to read for people in a hurry.';

async function openProject(call: Awaited<ReturnType<typeof recruiter>>['call'], over: Record<string, unknown> = {}) {
  const created = await call('POST', '/o/company/micro', project(over));
  expect(created.status).toBe(201);
  const opened = await call('POST', `/o/company/micro/${created.body.project.id}/status`, { status: 'OPEN' });
  expect(opened.status).toBe(200);
  return created.body.project.id as string;
}

describe('micro-internships', () => {
  it('refuses unpaid work and projects outside 10-40 hours', async () => {
    const r = await recruiter();
    expect((await r.call('POST', '/o/company/micro', project({ stipend: 0 }))).status).toBe(400);
    expect((await r.call('POST', '/o/company/micro', project({ hours: 5 }))).status).toBe(400);
    expect((await r.call('POST', '/o/company/micro', project({ hours: 60 }))).status).toBe(400);
    expect((await r.call('POST', '/o/company/micro', project())).status).toBe(201);
  });

  it('is closed to a company that is not verified', async () => {
    const r = await recruiter(false);
    expect((await r.call('POST', '/o/company/micro', project())).status).toBe(403);
  });

  it('shows students only open projects from verified companies, and never more chosen than places', async () => {
    const tenant = await tenantWith('proof.microInternships');
    const college = await makeCollege('College A', tenant.id);
    const a = await student(tenant.id, college.id);
    const b = await student(tenant.id, college.id);
    const r = await recruiter();

    const draft = await r.call('POST', '/o/company/micro', project({ title: 'A draft nobody should see' }));
    const id = await openProject(r.call);

    // A project from a company that is later suspended disappears at once.
    const other = await recruiter();
    await openProject(other.call, { title: 'From a company about to be suspended' });
    await db.company.update({ where: { id: other.company.id }, data: { status: 'SUSPENDED' } });

    const seen = (await a.call('GET', '/o/micro')).body.open;
    expect(seen.map((p: { id: string }) => p.id)).toEqual([id]);
    expect(seen.some((p: { id: string }) => p.id === draft.body.project.id)).toBe(false);

    const appA = await a.call('POST', `/o/micro/${id}/apply`, { pitch: PITCH });
    const appB = await b.call('POST', `/o/micro/${id}/apply`, { pitch: PITCH });
    expect(appA.status).toBe(201);
    expect((await a.call('POST', `/o/micro/${id}/apply`, { pitch: PITCH })).status).toBe(409);

    expect((await r.call('POST', `/o/company/micro/applications/${appA.body.application.id}/decision`, { action: 'SELECT' })).status).toBe(200);
    // One place, already taken.
    expect((await r.call('POST', `/o/company/micro/applications/${appB.body.application.id}/decision`, { action: 'SELECT' })).status).toBe(409);

    // Fewer places than already chosen is refused.
    expect((await r.call('PUT', `/o/company/micro/${id}`, project({ slots: 0 }))).status).toBe(400);
  });

  it('lets only the chosen student hand in work, then rates, records payment and exposes it as proof', async () => {
    const tenant = await tenantWith('proof.microInternships');
    const college = await makeCollege('College A', tenant.id);
    const chosen = await student(tenant.id, college.id);
    const other = await student(tenant.id, college.id);
    const r = await recruiter();
    const id = await openProject(r.call, { slots: 1 });

    const c = await chosen.call('POST', `/o/micro/${id}/apply`, { pitch: PITCH });
    const o = await other.call('POST', `/o/micro/${id}/apply`, { pitch: PITCH });
    const cId = c.body.application.id;
    const oId = o.body.application.id;
    await r.call('POST', `/o/company/micro/applications/${cId}/decision`, { action: 'SELECT' });

    expect((await other.call('POST', `/o/micro/applications/${oId}/deliver`, { deliverable: 'https://example.com/my-work' })).status).toBe(403);
    // Another student's application answers like one that does not exist.
    expect((await other.call('POST', `/o/micro/applications/${cId}/deliver`, { deliverable: 'https://example.com/my-work' })).status).toBe(404);

    // Nothing to rate until the work arrives.
    expect((await r.call('POST', `/o/company/micro/applications/${cId}/complete`, { rating: 5, review: 'Clear, careful work.' })).status).toBe(409);
    expect((await chosen.call('POST', `/o/micro/applications/${cId}/deliver`, { deliverable: 'https://example.com/dashboard' })).status).toBe(204);
    expect((await r.call('POST', `/o/company/micro/applications/${cId}/complete`, { rating: 5, review: 'Clear, careful work.' })).status).toBe(204);

    // Payment is recorded, never processed: the student can confirm only after the company says it paid.
    expect((await chosen.call('POST', `/o/micro/applications/${cId}/confirm-paid`)).status).toBe(409);
    expect((await r.call('POST', `/o/company/micro/applications/${cId}/paid`)).status).toBe(204);
    expect((await chosen.call('POST', `/o/micro/applications/${cId}/confirm-paid`)).status).toBe(204);
    const mine = (await chosen.call('GET', '/o/micro')).body.mine[0];
    expect(mine.paidAt).not.toBeNull();
    expect(mine.paymentConfirmedAt).not.toBeNull();

    const proof = (await chosen.call('GET', '/o/micro/completed')).body.completed;
    expect(proof).toHaveLength(1);
    expect(proof[0]).toMatchObject({ rating: 5, hours: 20, skills: ['Excel', 'Data visualisation'] });
  });

  it('keeps companies out of each other’s projects and never hands over contact details', async () => {
    const tenant = await tenantWith('proof.microInternships');
    const college = await makeCollege('College A', tenant.id);
    const s = await student(tenant.id, college.id);
    const mine = await recruiter();
    const theirs = await recruiter();
    const id = await openProject(mine.call);
    const app = await s.call('POST', `/o/micro/${id}/apply`, { pitch: PITCH });

    expect((await theirs.call('GET', `/o/company/micro/${id}`)).status).toBe(404);
    expect((await theirs.call('POST', `/o/company/micro/applications/${app.body.application.id}/decision`, { action: 'SELECT' })).status).toBe(404);

    const detail = await mine.call('GET', `/o/company/micro/${id}`);
    expect(detail.status).toBe(200);
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain('@test.local');
    expect(text).not.toContain('"phone"');
    expect(detail.body.applications[0].student.name).toBe('Test Student');
  });

  it('is closed to students when the institution has it off', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('College A', tenant.id);
    const s = await student(tenant.id, college.id);
    expect((await s.call('GET', '/o/micro')).status).toBe(403);
  });
});

describe('campus weeks', () => {
  const week = (collegeId: string, over: Record<string, unknown> = {}) => ({
    collegeId,
    title: 'Demo Systems week',
    message: 'A talk, a short challenge and time with our engineers.',
    startDate: inDays(3).toISOString(),
    endDate: inDays(5).toISOString(),
    events: [
      { kind: 'TALK', title: 'How we build things', startsAt: inDays(3).toISOString(), durationMin: 60, where: 'Main hall' },
      { kind: 'CHALLENGE', title: 'Two-hour build', startsAt: inDays(4).toISOString(), durationMin: 120 },
    ],
    ...over,
  });

  it('needs the college’s approval, from a role that runs drives, with a reason to decline', async () => {
    const tenant = await tenantWith('showcase.campusWeeks');
    const college = await makeCollege('College A', tenant.id);
    const r = await recruiter();

    const proposed = await r.call('POST', '/o/company/weeks', week(college.id));
    expect(proposed.status).toBe(201);
    expect(proposed.body.week.status).toBe('PROPOSED');

    const verifier = await officer(tenant.id, college.id, 'campus.verifier');
    expect((await verifier('POST', `/o/college/weeks/${proposed.body.week.id}/decision`, { status: 'APPROVED' })).status).toBe(403);

    const po = await officer(tenant.id, college.id);
    expect((await po('POST', `/o/college/weeks/${proposed.body.week.id}/decision`, { status: 'DECLINED' })).status).toBe(400);
    expect((await po('POST', `/o/college/weeks/${proposed.body.week.id}/decision`, { status: 'APPROVED' })).status).toBe(200);
  });

  it('is refused at a college whose institution does not host campus weeks', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('College A', tenant.id);
    const r = await recruiter();
    expect((await r.call('POST', '/o/company/weeks', week(college.id))).status).toBe(400);
  });

  it('shows students only their own college’s approved weeks; registering twice is once', async () => {
    const tenant = await tenantWith('showcase.campusWeeks');
    const a = await makeCollege('College A', tenant.id);
    const b = await makeCollege('College B', tenant.id);
    const here = await student(tenant.id, a.id);
    const elsewhere = await student(tenant.id, b.id);
    const r = await recruiter();
    const po = await officer(tenant.id, a.id);

    const { body } = await r.call('POST', '/o/company/weeks', week(a.id));
    // Proposed: not announced yet.
    expect((await here.call('GET', '/o/weeks')).body.weeks).toHaveLength(0);

    await po('POST', `/o/college/weeks/${body.week.id}/decision`, { status: 'APPROVED' });
    expect(await db.notification.count({ where: { userId: here.user.id, type: 'CAMPUS_WEEK_ANNOUNCED' } })).toBe(1);

    const listed = (await here.call('GET', '/o/weeks')).body.weeks;
    expect(listed).toHaveLength(1);
    expect((await elsewhere.call('GET', '/o/weeks')).body.weeks).toHaveLength(0);

    const eventId = listed[0].events[0].id;
    expect((await here.call('POST', `/o/weeks/events/${eventId}/register`)).status).toBe(200);
    expect((await here.call('POST', `/o/weeks/events/${eventId}/register`)).status).toBe(200);
    expect(await db.campusWeekRegistration.count({ where: { eventId } })).toBe(1);
    // Another college's session answers like one that does not exist.
    expect((await elsewhere.call('POST', `/o/weeks/events/${eventId}/register`)).status).toBe(404);
  });

  it('tells the company how many came, never who', async () => {
    const tenant = await tenantWith('showcase.campusWeeks');
    const college = await makeCollege('College A', tenant.id);
    const s1 = await student(tenant.id, college.id);
    const s2 = await student(tenant.id, college.id);
    const r = await recruiter();
    const po = await officer(tenant.id, college.id);

    const { body } = await r.call('POST', '/o/company/weeks', week(college.id));
    await po('POST', `/o/college/weeks/${body.week.id}/decision`, { status: 'APPROVED' });
    const eventId = (await s1.call('GET', '/o/weeks')).body.weeks[0].events[0].id;
    await s1.call('POST', `/o/weeks/events/${eventId}/register`);
    await s2.call('POST', `/o/weeks/events/${eventId}/register`);

    expect((await po('POST', `/o/college/weeks/${body.week.id}/events/${eventId}/attendance`, { candidateId: s1.candidate.id, attended: true })).status).toBe(204);

    // The college sees its own students by name.
    const collegeView = (await po('GET', '/o/college/weeks')).body.weeks[0].events[0];
    expect(collegeView.people).toHaveLength(2);

    const companyView = (await r.call('GET', '/o/company/weeks')).body.weeks[0].events[0];
    expect(companyView).toMatchObject({ registered: 2, attended: 1 });
    const text = JSON.stringify((await r.call('GET', '/o/company/weeks')).body.weeks);
    expect(text).not.toContain(s1.candidate.id);
    expect(text).not.toContain('Test Student');
  });

  it('is closed to students and colleges when the institution has it off', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('College A', tenant.id);
    const s = await student(tenant.id, college.id);
    const po = await officer(tenant.id, college.id);
    expect((await s.call('GET', '/o/weeks')).status).toBe(403);
    expect((await po('GET', '/o/college/weeks')).status).toBe(403);
  });
});
