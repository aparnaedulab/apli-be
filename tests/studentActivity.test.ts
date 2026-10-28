import { afterEach, describe, expect, it } from 'vitest';
import express, { type Router } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role, RunStatus, WorkSimulationStatus } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeRecruiter, makeStudent, makeTenant, systemRole } from './factories.js';
import { adminRouter } from '../src/modules/admin/admin.routes.js';
import { platformActivityRouter } from '../src/modules/admin/platformActivity.routes.js';
import { review } from '../src/modules/studentApp/studentApp.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The student app, read from the admin side.
 *
 * An institution's admins see their own students' simulations, offers and
 * interviews and nobody else's. The platform team sees everyone - including
 * students who signed up on their own and belong to no institution, whom no
 * institution can see.
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
  const mount: [string, Router][] = [
    ['/platform/activity', platformActivityRouter],
    ['/admin', adminRouter],
  ];
  for (const [path, router] of mount) app.use(path, router);
  app.use(errorHandler);

  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return async (method: string, path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function operations(tenantId: string | null) {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@test.local`, fullName: 'Operations', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({
    data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId },
  });
  return user;
}

/** A student who signed up on their own, naming a college not on Apli.ai. */
async function loneStudent() {
  const user = await db.user.create({
    data: { email: `lone-${Math.random()}@test.local`, fullName: 'On Their Own', passwordHash: 'x', role: Role.CANDIDATE },
  });
  return db.candidate.create({ data: { userId: user.id, otherCollege: 'Not Yet On Apli College' } });
}

async function world() {
  const a = await makeTenant('University A');
  const b = await makeTenant('University B');
  const collegeA = await makeCollege('College of A', a.id);
  const collegeB = await makeCollege('College of B', b.id);
  const studentA = await makeStudent((await makeBatch(collegeA.id)).id, { collegeId: collegeA.id });
  const studentB = await makeStudent((await makeBatch(collegeB.id)).id, { collegeId: collegeB.id });
  const lone = await loneStudent();

  const company = await makeCompany('Acme Analytics');
  const recruiter = await makeRecruiter(company.id);
  const sim = await db.workSimulation.create({
    data: {
      slug: `sim-${Math.random().toString(36).slice(2)}`,
      companyId: company.id,
      title: 'Forecast demand',
      summary: 'A short piece of analytics work.',
      field: 'Data',
      status: WorkSimulationStatus.LIVE,
      publishedAt: new Date(),
    },
  });

  // A finished, certified run for A's student, and an offer on the back of it.
  const runA = await db.workSimulationRun.create({
    data: {
      simulationId: sim.id,
      candidateId: studentA.candidate.id,
      status: RunStatus.COMPLETED,
      completedAt: new Date(),
      certificateCode: `APLI-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  await db.internshipOffer.create({
    data: {
      companyId: company.id,
      candidateId: studentA.candidate.id,
      runId: runA.id,
      sentById: recruiter.id,
      role: 'Analyst intern',
      about: 'Three months on the forecasting team.',
      workMode: 'REMOTE',
      months: 3,
      respondBy: new Date(Date.now() + 7 * 864e5),
      noFeeAt: new Date(),
    },
  });

  // B's student and the lone student are part-way through.
  await db.workSimulationRun.create({ data: { simulationId: sim.id, candidateId: studentB.candidate.id } });
  const runLone = await db.workSimulationRun.create({
    data: { simulationId: sim.id, candidateId: lone.id, status: RunStatus.IN_REVIEW, submittedAt: new Date() },
  });

  return { a, b, studentA, studentB, lone, sim, runLone };
}

describe('an institution admin', () => {
  it('sees only their own students, with what they did in the student app', async () => {
    const w = await world();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    const res = await call('GET', '/admin/students');

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { id: string }) => r.id)).toEqual([w.studentA.candidate.id]);
    expect(res.body.rows[0]).toMatchObject({ started: 1, certified: 1, offers: 1, interviews: 0 });
  });

  it('gets a 404 for another institution’s student, and for one on no institution', async () => {
    const w = await world();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    expect((await call('GET', `/admin/students/${w.studentB.candidate.id}`)).status).toBe(404);
    expect((await call('GET', `/admin/students/${w.lone.id}`)).status).toBe(404);

    const own = await call('GET', `/admin/students/${w.studentA.candidate.id}`);
    expect(own.status).toBe(200);
    expect(own.body.runs).toHaveLength(1);
    expect(own.body.offers[0]).toMatchObject({ role: 'Analyst intern', status: 'SENT' });
  });

  it('counts work, offers and simulations for their own students only', async () => {
    const w = await world();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id });

    const work = await call('GET', '/admin/work');
    expect(work.body.rows.map((r: { studentId: string }) => r.studentId)).toEqual([w.studentA.candidate.id]);

    const sims = await call('GET', '/admin/simulations');
    const sim = sims.body.rows.find((s: { id: string }) => s.id === w.sim.id);
    expect(sim).toMatchObject({ started: 1, certified: 1, inReview: 0 });

    const stats = await call('GET', '/admin/stats');
    expect(stats.body.students).toBe(1);
    expect(stats.body.simulations).toMatchObject({ started: 1, certified: 1, inReview: 0 });
    expect(stats.body.offers).toMatchObject({ sent: 1, open: 1 });
  });

  it('cannot reach the platform-wide read', async () => {
    const w = await world();
    const admin = await operations(w.a.id);
    const call = appFor({ userId: admin.id, role: Role.ADMIN, tenantId: w.a.id, isPlatform: false });

    expect((await call('GET', '/platform/activity/students')).status).toBe(403);
  });
});

describe('the platform team', () => {
  it('sees every student, including those who signed up on their own', async () => {
    const w = await world();
    const team = await operations(null);
    const call = appFor({ userId: team.id, role: Role.ADMIN, isPlatform: true });

    const all = await call('GET', '/platform/activity/students?pageSize=100');
    const ids = all.body.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([w.studentA.candidate.id, w.studentB.candidate.id, w.lone.id]));

    const lone = await call('GET', '/platform/activity/students?attached=false&pageSize=100');
    const loneIds = lone.body.rows.map((r: { id: string }) => r.id);
    expect(loneIds).toContain(w.lone.id);
    expect(loneIds).not.toContain(w.studentA.candidate.id);
    expect(lone.body.rows.find((r: { id: string }) => r.id === w.lone.id).college).toBe('Not Yet On Apli College');

    const stats = await call('GET', '/platform/activity/stats');
    expect(stats.body.unattachedStudents).toBeGreaterThanOrEqual(1);
  });
});

describe('reviewing a student’s work', () => {
  it('tells the student either way', async () => {
    const w = await world();
    const team = await operations(null);

    await review(team.id, w.runLone.id, { decision: 'changes', note: 'Show your working for task 2.' });

    const lone = await db.candidate.findUniqueOrThrow({ where: { id: w.lone.id } });
    const note = await db.notification.findFirstOrThrow({ where: { userId: lone.userId } });
    expect(note.type).toBe('SIMULATION_CHANGES');
    expect(note.body).toBe('Show your working for task 2.');
    expect(note.link).toBe(`/student/simulations/${w.sim.slug}`);
  });
});
