import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus, JobStatus, Role, SimulationStatus } from '@prisma/client';
import { db } from './setup.js';
import {
  makeApplication,
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makeRecruiter,
  makeStudent,
  makeTenant,
} from './factories.js';
import { proofRouter } from '../src/modules/proof/proof.routes.js';
import { jobRouter } from '../src/modules/jobs/job.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * A work simulation used as a hiring round. What matters: a job can only
 * point at a simulation that is real, published and its own; a student can
 * start it only from the round they are actually in, and without their
 * institution having the simulations catalogue switched on; and a company
 * sees progress only for its own applicants.
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
  app.use('/proof', proofRouter);
  app.use('/company/jobs', jobRouter);
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

async function companyWorld() {
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const call = appFor({ userId: recruiter.id, role: Role.COMPANY, companyId: company.id });
  return { company, recruiter, call };
}

async function simulationOf(companyId: string, status: SimulationStatus = SimulationStatus.PUBLISHED) {
  return db.simulation.create({
    data: {
      companyId,
      title: 'Support ticket triage',
      role: 'Customer Success Associate',
      summary: 'Sort a morning of support tickets and draft the replies.',
      estimatedHours: 3,
      skills: ['Writing'],
      status,
      tasks: { create: [{ order: 1, title: 'Triage', brief: 'Sort the tickets by urgency and say why.' }] },
    },
  });
}

const ROUND = (config: Record<string, unknown>) => ({
  rounds: [
    { name: 'Screening', type: 'RESUME_SCREEN' },
    { name: 'Work simulation', type: 'WORK_SIMULATION', config },
  ],
});

/** A company, a simulation round in a job, and a student applied to it - in a tenant WITHOUT proof.simulations. */
async function roundWorld() {
  const co = await companyWorld();
  const sim = await simulationOf(co.company.id);
  const job = await makeJob(co.company.id, co.recruiter.id, { rounds: 0 });
  const screen = await db.round.create({ data: { jobId: job.id, order: 1, name: 'Screening', type: 'RESUME_SCREEN' } });
  const simRound = await db.round.create({
    data: { jobId: job.id, order: 2, name: 'Work simulation', type: 'WORK_SIMULATION', config: { simulationId: sim.id } },
  });

  const tenant = await makeTenant();
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id, frozen: true });
  const app = await makeApplication(candidate.id, job.id, drive.id, ApplicationStatus.IN_ROUND);
  await db.application.update({ where: { id: app.id }, data: { currentRoundId: screen.id } });
  const st = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id });
  return { co, sim, job, screen, simRound, candidate, app, st };
}

describe('a work simulation as a round', () => {
  it('refuses a round with no simulation, another company’s, or a draft', async () => {
    const co = await companyWorld();
    const other = await companyWorld();
    const job = await makeJob(co.company.id, co.recruiter.id, { rounds: 0 });
    await db.job.update({ where: { id: job.id }, data: { status: JobStatus.DRAFT } });

    const missing = await co.call('PUT', `/company/jobs/${job.id}/rounds`, ROUND({}));
    expect(missing.status).toBe(400);
    expect(missing.body.error.message ?? JSON.stringify(missing.body)).toMatch(/Pick the work simulation/);

    const theirs = await simulationOf(other.company.id);
    const foreign = await co.call('PUT', `/company/jobs/${job.id}/rounds`, ROUND({ simulationId: theirs.id }));
    expect(foreign.status).toBe(400);
    expect(JSON.stringify(foreign.body)).toMatch(/not one of your company/);

    const draft = await simulationOf(co.company.id, SimulationStatus.DRAFT);
    const drafted = await co.call('PUT', `/company/jobs/${job.id}/rounds`, ROUND({ simulationId: draft.id }));
    expect(drafted.status).toBe(400);
    expect(JSON.stringify(drafted.body)).toMatch(/Publish that work simulation/);

    expect(await db.round.count({ where: { jobId: job.id } })).toBe(0);

    const mine = await simulationOf(co.company.id);
    const ok = await co.call('PUT', `/company/jobs/${job.id}/rounds`, ROUND({ simulationId: mine.id }));
    expect(ok.status).toBe(200);
    const saved = await db.round.findFirstOrThrow({ where: { jobId: job.id, type: 'WORK_SIMULATION' } });
    expect(saved.config).toEqual({ simulationId: mine.id });
  });

  it('lets a student start it only while in that round, without the simulations module', async () => {
    const w = await roundWorld();

    // Still at screening: nothing to start, and the simulation itself is closed to them.
    expect((await w.st('GET', '/proof/rounds/mine')).body.rounds).toEqual([]);
    expect((await w.st('POST', `/proof/rounds/${w.app.id}/start`)).status).toBe(409);
    expect((await w.st('GET', `/proof/simulations`)).status).toBe(403);

    await db.application.update({ where: { id: w.app.id }, data: { currentRoundId: w.simRound.id } });
    const mine = await w.st('GET', '/proof/rounds/mine');
    expect(mine.body.rounds).toHaveLength(1);
    expect(mine.body.rounds[0]).toMatchObject({
      applicationId: w.app.id,
      simulation: { id: w.sim.id, estimatedHours: 3 },
      canStart: true,
      enrolment: null,
    });

    const started = await w.st('POST', `/proof/rounds/${w.app.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ simulationId: w.sim.id, enrolment: { status: 'IN_PROGRESS' } });

    // The workspace opens and the work can be handed in - the round grants access.
    const opened = await w.st('GET', `/proof/simulations/${w.sim.id}`);
    expect(opened.status).toBe(200);
    const task = opened.body.simulation.tasks[0];
    expect((await w.st('PUT', `/proof/simulations/${w.sim.id}/tasks/${task.id}`, { text: 'Urgent first: outages.' })).status).toBe(200);
    expect((await w.st('POST', `/proof/simulations/${w.sim.id}/submit`)).status).toBe(200);

    // Rejected: the round is over for them.
    await db.application.update({ where: { id: w.app.id }, data: { status: ApplicationStatus.REJECTED } });
    expect((await w.st('POST', `/proof/rounds/${w.app.id}/start`)).status).toBe(409);
  });

  it('is idempotent: starting twice gives the one enrolment', async () => {
    const w = await roundWorld();
    await db.application.update({ where: { id: w.app.id }, data: { currentRoundId: w.simRound.id } });
    const a = await w.st('POST', `/proof/rounds/${w.app.id}/start`);
    const b = await w.st('POST', `/proof/rounds/${w.app.id}/start`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await db.simulationEnrolment.count({ where: { candidateId: w.candidate.id, simulationId: w.sim.id } })).toBe(1);
  });

  it('will not start a simulation the company has since unpublished', async () => {
    const w = await roundWorld();
    await db.application.update({ where: { id: w.app.id }, data: { currentRoundId: w.simRound.id } });
    await db.simulation.update({ where: { id: w.sim.id }, data: { status: SimulationStatus.ARCHIVED } });
    expect((await w.st('POST', `/proof/rounds/${w.app.id}/start`)).status).toBe(409);
    expect((await w.st('GET', '/proof/rounds/mine')).body.rounds[0].canStart).toBe(false);
  });

  it('shows a company progress only for its own applicants', async () => {
    const w = await roundWorld();
    await db.application.update({ where: { id: w.app.id }, data: { currentRoundId: w.simRound.id } });
    await w.st('POST', `/proof/rounds/${w.app.id}/start`);

    const own = await w.co.call('GET', `/proof/company/applications/${w.app.id}/simulations`);
    expect(own.status).toBe(200);
    expect(own.body.rounds).toHaveLength(1);
    expect(own.body.rounds[0]).toMatchObject({
      isCurrent: true,
      simulation: { id: w.sim.id },
      enrolment: { status: 'IN_PROGRESS', certificateCode: null },
    });

    const stranger = await companyWorld();
    const peek = await stranger.call('GET', `/proof/company/applications/${w.app.id}/simulations`);
    expect(peek.status).toBe(404);
  });
});
