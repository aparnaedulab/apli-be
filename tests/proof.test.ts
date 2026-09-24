import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus, EnrolmentStatus, InternshipStatus, Role } from '@prisma/client';
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
import { newCertificateCode } from '../src/modules/proof/simulations.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Proof of work. The rules worth a test are the ones that give a certificate
 * and a passport their meaning: no certificate without the explain-your-work
 * call, codes that anyone can check, drafts nobody else can see, and a
 * passport that labels each claim by who actually stands behind it.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...(session ?? {}) };
    next();
  });
  app.use('/proof', proofRouter);
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
  for (const moduleKey of modules) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey, enabled: true } });
  }
  return tenant;
}

async function studentIn(tenantId: string, opts: { frozen?: boolean } = {}) {
  const college = await makeCollege('Demo College', tenantId);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id, frozen: opts.frozen ?? true });
  return {
    college,
    batch,
    candidate,
    call: appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId }),
  };
}

async function companyCaller() {
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  return { company, recruiter, call: appFor({ userId: recruiter.id, role: Role.COMPANY, companyId: company.id }) };
}

const SIM = {
  title: 'Market-entry brief',
  role: 'Business Analyst',
  summary: 'Size a market and recommend whether to enter it.',
  estimatedHours: 4,
  skills: ['Excel', 'Market research'],
  tasks: [
    { title: 'Size the market', brief: 'Estimate the market size with your working shown.', resources: [] },
    { title: 'Recommend', brief: 'Write a one-page recommendation for the leadership team.', resources: [] },
  ],
};

/** A company with a published simulation, and a student who has done every task and submitted. */
async function submittedWorld() {
  const tenant = await tenantWith('proof.simulations', 'proof.passport');
  const co = await companyCaller();
  const created = await co.call('POST', '/proof/company/simulations', SIM);
  const simId = created.body.simulation.id as string;
  await co.call('POST', `/proof/company/simulations/${simId}/status`, { status: 'PUBLISHED' });

  const st = await studentIn(tenant.id);
  const enrolled = await st.call('POST', `/proof/simulations/${simId}/enrol`);
  for (const t of enrolled.body.simulation.tasks) {
    await st.call('PUT', `/proof/simulations/${simId}/tasks/${t.id}`, { text: `My answer to ${t.title}` });
  }
  const submitted = await st.call('POST', `/proof/simulations/${simId}/submit`);
  const enrolmentId = submitted.body.simulation.enrolment.id as string;
  return { tenant, co, st, simId, enrolmentId };
}

describe('work simulations', () => {
  it('never completes without the explain-your-work call', async () => {
    const w = await submittedWorld();

    const early = await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, { action: 'COMPLETE' });
    expect(early.status).toBe(409);
    expect((await db.simulationEnrolment.findUniqueOrThrow({ where: { id: w.enrolmentId } })).certificateCode).toBeNull();

    const booked = await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, {
      action: 'BOOK_EXPLAIN',
      explainAt: new Date(Date.now() + 86400000).toISOString(),
      note: 'Join at https://meet.demo.example/abc - be ready to walk through task 1.',
    });
    expect(booked.body.enrolment.status).toBe('EXPLAIN_BOOKED');

    const done = await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, { action: 'COMPLETE' });
    expect(done.status).toBe(200);
    expect(done.body.enrolment.status).toBe('COMPLETED');
    expect(done.body.enrolment.certificateCode).toMatch(/^[A-Z2-9]{10}$/);
  });

  it('issues codes anyone can check, and nothing for a code that is not real', async () => {
    const w = await submittedWorld();
    await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, {
      action: 'BOOK_EXPLAIN',
      explainAt: new Date().toISOString(),
      note: 'Call booked.',
    });
    const done = await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, { action: 'COMPLETE' });
    const code = done.body.enrolment.certificateCode as string;

    const publicCall = appFor(null);
    const ok = await publicCall('GET', `/proof/certificates/${code.toLowerCase()}`);
    expect(ok.status).toBe(200);
    expect(ok.body.certificate).toMatchObject({ simulation: SIM.title, student: 'Test Student', company: w.co.company.name });
    expect((await publicCall('GET', '/proof/certificates/NOTACODE12')).status).toBe(404);

    const codes = new Set(Array.from({ length: 2000 }, newCertificateCode));
    expect(codes.size).toBe(2000);
  });

  it('refuses to submit until every task is answered, and locks answers once submitted', async () => {
    const tenant = await tenantWith('proof.simulations');
    const co = await companyCaller();
    const { body } = await co.call('POST', '/proof/company/simulations', SIM);
    await co.call('POST', `/proof/company/simulations/${body.simulation.id}/status`, { status: 'PUBLISHED' });
    const st = await studentIn(tenant.id);
    const enrolled = await st.call('POST', `/proof/simulations/${body.simulation.id}/enrol`);
    const [first] = enrolled.body.simulation.tasks;
    await st.call('PUT', `/proof/simulations/${body.simulation.id}/tasks/${first.id}`, { link: 'https://demo.example/work' });

    const early = await st.call('POST', `/proof/simulations/${body.simulation.id}/submit`);
    expect(early.status).toBe(400);

    // Once it is with the company, the work cannot quietly change.
    const w = await submittedWorld();
    const [task] = (await w.st.call('GET', `/proof/simulations/${w.simId}`)).body.simulation.tasks;
    const late = await w.st.call('PUT', `/proof/simulations/${w.simId}/tasks/${task.id}`, { text: 'A better answer' });
    expect(late.status).toBe(409);
  });

  it('keeps drafts invisible to students, and a draft cannot be published empty', async () => {
    const tenant = await tenantWith('proof.simulations');
    const co = await companyCaller();
    const draft = await co.call('POST', '/proof/company/simulations', SIM);
    const st = await studentIn(tenant.id);

    expect((await st.call('GET', '/proof/simulations')).body.simulations).toHaveLength(0);
    expect((await st.call('GET', `/proof/simulations/${draft.body.simulation.id}`)).status).toBe(404);
    expect((await st.call('POST', `/proof/simulations/${draft.body.simulation.id}/enrol`)).status).toBe(404);

    const empty = await co.call('POST', '/proof/company/simulations', { ...SIM, tasks: [] });
    expect((await co.call('POST', `/proof/company/simulations/${empty.body.simulation.id}/status`, { status: 'PUBLISHED' })).status).toBe(400);
  });

  it("does not let one company see or review another company's work", async () => {
    const w = await submittedWorld();
    const other = await companyCaller();

    expect((await other.call('GET', `/proof/company/enrolments/${w.enrolmentId}`)).status).toBe(404);
    expect(
      (await other.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, { action: 'NEEDS_WORK', note: 'Nope' })).status,
    ).toBe(404);
    expect((await other.call('GET', '/proof/company/enrolments')).body.enrolments).toHaveLength(0);
    expect((await other.call('GET', `/proof/company/simulations/${w.simId}`)).status).toBe(404);
  });

  it('refuses students where the institution has the module off', async () => {
    const tenant = await makeTenant();
    const st = await studentIn(tenant.id);
    expect((await st.call('GET', '/proof/simulations')).status).toBe(403);
    expect((await st.call('GET', '/proof/passport')).status).toBe(403);
  });
});

describe('the skills passport', () => {
  it('labels each claim by who stands behind it', async () => {
    const w = await submittedWorld();
    await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, {
      action: 'BOOK_EXPLAIN',
      explainAt: new Date().toISOString(),
      note: 'Booked.',
    });
    await w.co.call('POST', `/proof/company/enrolments/${w.enrolmentId}/decision`, { action: 'COMPLETE' });

    // A listed skill the simulation proved, one it did not, and a project.
    const excel = await db.skill.create({ data: { name: 'excel' } });
    const guitar = await db.skill.create({ data: { name: 'Public speaking' } });
    await db.candidateSkill.createMany({
      data: [
        { candidateId: w.st.candidate.id, skillId: excel.id },
        { candidateId: w.st.candidate.id, skillId: guitar.id },
      ],
    });
    await db.project.create({ data: { candidateId: w.st.candidate.id, title: 'Demo project' } });
    await db.internship.create({
      data: {
        candidateId: w.st.candidate.id,
        organisation: 'Demo Labs',
        role: 'Intern',
        startDate: new Date('2026-05-01'),
        endDate: new Date('2026-06-30'),
        status: InternshipStatus.COMPLETED,
        evaluationScore: 4,
        mentorName: 'Demo Mentor',
      },
    });

    const { body } = await w.st.call('GET', '/proof/passport');
    const by = (label: string) => body.passport.claims.find((c: { label: string }) => c.label === label);

    expect(by('CGPA').evidence).toBe('COLLEGE_VERIFIED');
    expect(by('excel').evidence).toBe('EMPLOYER_VERIFIED');
    expect(by('Public speaking').evidence).toBe('SELF_REPORTED');
    expect(by('Market research').evidence).toBe('EMPLOYER_VERIFIED'); // proved, never listed
    expect(by('Demo project').evidence).toBe('SELF_REPORTED');
    expect(by('Intern at Demo Labs').evidence).toBe('EMPLOYER_VERIFIED');
    expect(body.passport.claims.find((c: { kind: string }) => c.kind === 'SIMULATION').certificateCode).toMatch(/^[A-Z2-9]{10}$/);
  });

  it('shows unlocked marks as not yet verified', async () => {
    const tenant = await tenantWith('proof.passport');
    const st = await studentIn(tenant.id, { frozen: false });
    const { body } = await st.call('GET', '/proof/passport');
    const cgpa = body.passport.claims.find((c: { label: string }) => c.label === 'CGPA');
    expect(cgpa.evidence).toBe('SELF_REPORTED');
    expect(cgpa.source).toMatch(/not yet verified/);
  });

  it('is readable by a company only for its own applicants', async () => {
    const tenant = await tenantWith('proof.passport');
    const st = await studentIn(tenant.id);
    const co = await companyCaller();

    expect((await co.call('GET', `/proof/company/passport/${st.candidate.id}`)).status).toBe(404);

    const drive = await makeDrive(st.college.id, st.batch.id);
    const job = await makeJob(co.company.id, co.recruiter.id);
    await makeApplication(st.candidate.id, job.id, drive.id, ApplicationStatus.APPLIED);

    const ok = await co.call('GET', `/proof/company/passport/${st.candidate.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.passport.summary.collegeVerified).toBeGreaterThan(0);
  });
});

// Keeps the enum import honest if statuses are renamed.
void EnrolmentStatus;
