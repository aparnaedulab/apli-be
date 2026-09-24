import { randomBytes } from 'node:crypto';
import { EnrolmentStatus, Prisma, SimulationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/**
 * Work simulations: a short project a company builds, a student works through,
 * and the company reviews.
 *
 * The one rule that gives a certificate its worth: nothing is completed on the
 * written work alone. After reading the submission the company books a short
 * "explain your work" call, and only after that call can it mark the work
 * complete. Copied or AI-made answers pass a reading; they rarely survive five
 * minutes of "walk me through why you did this".
 */

export interface SimulationInput {
  title: string;
  role: string;
  summary: string;
  estimatedHours: number;
  skills: string[];
  tasks: { title: string; brief: string; resources: { label: string; url: string }[] }[];
}

/* -------------------------------------------------------------------------- */
/* Company: authoring                                                          */
/* -------------------------------------------------------------------------- */

export async function listCompanySimulations(companyId: string) {
  const sims = await prisma.simulation.findMany({
    where: { companyId },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    include: {
      _count: { select: { tasks: true } },
      enrolments: { select: { status: true } },
    },
  });
  return sims.map(({ enrolments, _count, ...s }) => ({
    ...s,
    taskCount: _count.tasks,
    enrolled: enrolments.length,
    waitingForReview: enrolments.filter((e) => e.status === EnrolmentStatus.SUBMITTED).length,
    completed: enrolments.filter((e) => e.status === EnrolmentStatus.COMPLETED).length,
  }));
}

/** A company's own simulation, or a 404 that looks like any missing one. */
async function ownSimulation(companyId: string, id: string) {
  const sim = await prisma.simulation.findFirst({ where: { id, companyId } });
  if (!sim) throw notFound('No such simulation.');
  return sim;
}

export async function getCompanySimulation(companyId: string, id: string) {
  await ownSimulation(companyId, id);
  return prisma.simulation.findUniqueOrThrow({
    where: { id },
    include: {
      tasks: { orderBy: { order: 'asc' } },
      _count: { select: { enrolments: true } },
    },
  });
}

function taskRows(simulationId: string, tasks: SimulationInput['tasks']) {
  return tasks.map((t, i) => ({
    simulationId,
    order: i + 1,
    title: t.title,
    brief: t.brief,
    resources: t.resources as unknown as Prisma.InputJsonValue,
  }));
}

export async function createSimulation(companyId: string, input: SimulationInput) {
  return prisma.$transaction(async (tx) => {
    const sim = await tx.simulation.create({
      data: {
        companyId,
        title: input.title,
        role: input.role,
        summary: input.summary,
        estimatedHours: input.estimatedHours,
        skills: input.skills,
      },
    });
    if (input.tasks.length) await tx.simulationTask.createMany({ data: taskRows(sim.id, input.tasks) });
    return sim;
  });
}

/**
 * Editing. The words can always change; the tasks only while nobody has
 * started - a student halfway through must not find the questions they
 * answered have become different questions.
 */
export async function updateSimulation(companyId: string, id: string, input: SimulationInput) {
  await ownSimulation(companyId, id);
  const started = await prisma.simulationEnrolment.count({ where: { simulationId: id } });

  return prisma.$transaction(async (tx) => {
    await tx.simulation.update({
      where: { id },
      data: {
        title: input.title,
        role: input.role,
        summary: input.summary,
        estimatedHours: input.estimatedHours,
        skills: input.skills,
      },
    });

    if (started > 0) {
      const current = await tx.simulationTask.findMany({ where: { simulationId: id }, orderBy: { order: 'asc' } });
      const same =
        current.length === input.tasks.length &&
        current.every((t, i) => t.title === input.tasks[i]!.title && t.brief === input.tasks[i]!.brief);
      if (!same) {
        // Wording of resources may still be fixed; the tasks themselves may not.
        throw conflict(
          `${started} student${started === 1 ? ' has' : 's have'} already started, so the tasks can no longer change. Archive this one and make a new version instead.`,
        );
      }
      for (const [i, t] of current.entries()) {
        await tx.simulationTask.update({
          where: { id: t.id },
          data: { resources: input.tasks[i]!.resources as unknown as Prisma.InputJsonValue },
        });
      }
    } else {
      await tx.simulationTask.deleteMany({ where: { simulationId: id } });
      if (input.tasks.length) await tx.simulationTask.createMany({ data: taskRows(id, input.tasks) });
    }
  });
}

export async function setSimulationStatus(companyId: string, id: string, status: SimulationStatus) {
  await ownSimulation(companyId, id);
  if (status === SimulationStatus.PUBLISHED) {
    const tasks = await prisma.simulationTask.count({ where: { simulationId: id } });
    if (tasks === 0) throw badRequest('Add at least one task before publishing.');
  }
  return prisma.simulation.update({ where: { id }, data: { status } });
}

/* -------------------------------------------------------------------------- */
/* Company: reviewing                                                          */
/* -------------------------------------------------------------------------- */

const STUDENT = {
  select: {
    id: true,
    user: { select: { fullName: true } },
    college: { select: { name: true } },
  },
} as const;

export async function reviewQueue(companyId: string, status?: EnrolmentStatus) {
  const rows = await prisma.simulationEnrolment.findMany({
    where: {
      simulation: { companyId },
      // By default, everything waiting on the company - never a student's
      // unfinished draft, which is theirs until they submit it.
      status: status ?? { in: [EnrolmentStatus.SUBMITTED, EnrolmentStatus.EXPLAIN_BOOKED] },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      simulation: { select: { id: true, title: true, role: true } },
      candidate: STUDENT,
    },
  });
  return rows.map((e) => ({
    id: e.id,
    status: e.status,
    explainAt: e.explainAt,
    completedAt: e.completedAt,
    createdAt: e.createdAt,
    simulation: e.simulation,
    student: { name: e.candidate.user.fullName, college: e.candidate.college?.name ?? null },
  }));
}

/** An enrolment in one of the company's simulations, or a plain 404. */
async function ownEnrolment(companyId: string, id: string) {
  const e = await prisma.simulationEnrolment.findFirst({
    where: { id, simulation: { companyId } },
  });
  if (!e) throw notFound('No such submission.');
  return e;
}

export async function getEnrolmentForReview(companyId: string, id: string) {
  await ownEnrolment(companyId, id);
  const e = await prisma.simulationEnrolment.findUniqueOrThrow({
    where: { id },
    include: {
      simulation: { include: { tasks: { orderBy: { order: 'asc' } } } },
      submissions: true,
      candidate: STUDENT,
    },
  });
  return {
    id: e.id,
    status: e.status,
    explainAt: e.explainAt,
    explainNote: e.explainNote,
    completedAt: e.completedAt,
    certificateCode: e.certificateCode,
    student: { id: e.candidate.id, name: e.candidate.user.fullName, college: e.candidate.college?.name ?? null },
    simulation: { id: e.simulation.id, title: e.simulation.title, role: e.simulation.role },
    tasks: e.simulation.tasks.map((t) => {
      const s = e.submissions.find((x) => x.taskId === t.id);
      return { id: t.id, order: t.order, title: t.title, brief: t.brief, answer: s ? { text: s.text, link: s.link, at: s.submittedAt } : null };
    }),
  };
}

/** No 0/O or 1/I, so a certificate code read aloud or retyped cannot be misread. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newCertificateCode(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export type Decision =
  | { action: 'NEEDS_WORK'; note: string }
  | { action: 'BOOK_EXPLAIN'; explainAt: Date; note: string }
  | { action: 'COMPLETE'; note?: string };

/**
 * The review, as a small state machine.
 *
 *   SUBMITTED       -> NEEDS_WORK | EXPLAIN_BOOKED
 *   EXPLAIN_BOOKED  -> EXPLAIN_BOOKED (rebooked) | NEEDS_WORK | COMPLETED
 *
 * COMPLETED is reachable only through EXPLAIN_BOOKED. There is no path from a
 * submission straight to a certificate - that is the whole point.
 */
export async function decide(companyId: string, id: string, reviewerId: string, d: Decision) {
  const e = await ownEnrolment(companyId, id);

  if (d.action === 'NEEDS_WORK') {
    if (e.status !== EnrolmentStatus.SUBMITTED && e.status !== EnrolmentStatus.EXPLAIN_BOOKED) {
      throw conflict('Only submitted work can be sent back.');
    }
    return prisma.simulationEnrolment.update({
      where: { id },
      data: { status: EnrolmentStatus.NEEDS_WORK, explainNote: d.note, reviewedById: reviewerId },
    });
  }

  if (d.action === 'BOOK_EXPLAIN') {
    if (e.status !== EnrolmentStatus.SUBMITTED && e.status !== EnrolmentStatus.EXPLAIN_BOOKED) {
      throw conflict('Book the call once the student has submitted their work.');
    }
    return prisma.simulationEnrolment.update({
      where: { id },
      data: { status: EnrolmentStatus.EXPLAIN_BOOKED, explainAt: d.explainAt, explainNote: d.note, reviewedById: reviewerId },
    });
  }

  if (e.status !== EnrolmentStatus.EXPLAIN_BOOKED) {
    throw conflict('Hold the explain-your-work call before marking this complete. A certificate is never issued on the written work alone.');
  }

  // Codes are unique; a clash on ten characters from 32 is vanishingly rare,
  // but a retry costs nothing and a duplicate certificate would cost trust.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.simulationEnrolment.update({
        where: { id },
        data: {
          status: EnrolmentStatus.COMPLETED,
          completedAt: new Date(),
          certificateCode: newCertificateCode(),
          reviewedById: reviewerId,
          ...(d.note ? { explainNote: d.note } : {}),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw conflict('Could not issue a certificate code. Try again.');
}

/* -------------------------------------------------------------------------- */
/* Student                                                                     */
/* -------------------------------------------------------------------------- */

export async function listForStudent(candidateId: string) {
  const sims = await prisma.simulation.findMany({
    where: { status: SimulationStatus.PUBLISHED, company: { status: 'VERIFIED' } },
    orderBy: { updatedAt: 'desc' },
    include: {
      company: { select: { id: true, name: true, logoUrl: true } },
      _count: { select: { tasks: true } },
      enrolments: { where: { candidateId }, select: { status: true, certificateCode: true } },
    },
  });
  return sims.map(({ enrolments, _count, ...s }) => ({
    id: s.id,
    title: s.title,
    role: s.role,
    summary: s.summary,
    estimatedHours: s.estimatedHours,
    skills: s.skills,
    company: s.company,
    taskCount: _count.tasks,
    mine: enrolments[0] ?? null,
  }));
}

/**
 * One simulation as a student sees it. A draft or archived one is invisible -
 * unless they already enrolled, in which case they keep access to finish or
 * to see their certificate.
 */
export async function getForStudent(candidateId: string, id: string) {
  const sim = await prisma.simulation.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true, logoUrl: true } },
      tasks: { orderBy: { order: 'asc' } },
      enrolments: { where: { candidateId }, include: { submissions: true } },
    },
  });
  const mine = sim?.enrolments[0] ?? null;
  if (!sim || (sim.status !== SimulationStatus.PUBLISHED && !mine)) throw notFound('No such simulation.');

  return {
    id: sim.id,
    title: sim.title,
    role: sim.role,
    summary: sim.summary,
    estimatedHours: sim.estimatedHours,
    skills: sim.skills,
    status: sim.status,
    company: sim.company,
    enrolment: mine
      ? {
          id: mine.id,
          status: mine.status,
          explainAt: mine.explainAt,
          explainNote: mine.explainNote,
          completedAt: mine.completedAt,
          certificateCode: mine.certificateCode,
        }
      : null,
    tasks: sim.tasks.map((t) => {
      const s = mine?.submissions.find((x) => x.taskId === t.id);
      return {
        id: t.id,
        order: t.order,
        title: t.title,
        brief: t.brief,
        resources: t.resources,
        answer: s ? { text: s.text, link: s.link } : null,
      };
    }),
  };
}

export async function enrol(candidateId: string, simulationId: string) {
  const sim = await prisma.simulation.findFirst({
    where: { id: simulationId, status: SimulationStatus.PUBLISHED, company: { status: 'VERIFIED' } },
  });
  if (!sim) throw notFound('No such simulation.');
  return prisma.simulationEnrolment.upsert({
    where: { simulationId_candidateId: { simulationId, candidateId } },
    update: {},
    create: { simulationId, candidateId },
  });
}

async function myEnrolment(candidateId: string, simulationId: string) {
  const e = await prisma.simulationEnrolment.findUnique({
    where: { simulationId_candidateId: { simulationId, candidateId } },
  });
  if (!e) throw notFound('Start this simulation first.');
  return e;
}

/** Answers can change while the work is the student's - before submitting, or when sent back. */
const EDITABLE: EnrolmentStatus[] = [EnrolmentStatus.IN_PROGRESS, EnrolmentStatus.NEEDS_WORK];

export async function saveAnswer(
  candidateId: string,
  simulationId: string,
  taskId: string,
  answer: { text?: string; link?: string },
) {
  const e = await myEnrolment(candidateId, simulationId);
  if (!EDITABLE.includes(e.status)) throw conflict('This work is with the company now and cannot change.');

  const task = await prisma.simulationTask.findFirst({ where: { id: taskId, simulationId } });
  if (!task) throw notFound('No such task.');

  const text = answer.text?.trim() || null;
  const link = answer.link?.trim() || null;
  return prisma.simulationSubmission.upsert({
    where: { enrolmentId_taskId: { enrolmentId: e.id, taskId } },
    update: { text, link, submittedAt: new Date() },
    create: { enrolmentId: e.id, taskId, text, link },
  });
}

export async function submit(candidateId: string, simulationId: string) {
  const e = await myEnrolment(candidateId, simulationId);
  if (!EDITABLE.includes(e.status)) throw conflict('This work has already been submitted.');

  const [tasks, answered] = await Promise.all([
    prisma.simulationTask.findMany({ where: { simulationId }, select: { id: true, title: true } }),
    prisma.simulationSubmission.findMany({ where: { enrolmentId: e.id }, select: { taskId: true, text: true, link: true } }),
  ]);
  const done = new Set(answered.filter((a) => a.text || a.link).map((a) => a.taskId));
  const missing = tasks.filter((t) => !done.has(t.id));
  if (missing.length > 0) {
    throw badRequest(`Answer every task first. Still to do: ${missing.map((t) => t.title).join(', ')}.`, {
      missing: missing.map((t) => t.id),
    });
  }
  return prisma.simulationEnrolment.update({ where: { id: e.id }, data: { status: EnrolmentStatus.SUBMITTED } });
}

/* -------------------------------------------------------------------------- */
/* Public                                                                      */
/* -------------------------------------------------------------------------- */

/** What a certificate check shows anyone holding the code - and nothing more. */
export async function checkCertificate(code: string) {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(clean)) return null;
  const e = await prisma.simulationEnrolment.findUnique({
    where: { certificateCode: clean },
    include: {
      candidate: { select: { user: { select: { fullName: true } } } },
      simulation: { select: { title: true, role: true, estimatedHours: true, company: { select: { name: true } } } },
    },
  });
  if (!e || e.status !== EnrolmentStatus.COMPLETED || !e.completedAt) return null;
  return {
    code: clean,
    student: e.candidate.user.fullName,
    simulation: e.simulation.title,
    role: e.simulation.role,
    hours: e.simulation.estimatedHours,
    company: e.simulation.company.name,
    completedAt: e.completedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* A simulation as a hiring round                                              */
/* -------------------------------------------------------------------------- */

/*
 * A job's round may be a work simulation (Round.type WORK_SIMULATION, with
 * config { simulationId }). The student does it from their application, not
 * from the simulations catalogue - so this path must work even where the
 * institution has not switched proof.simulations on. The company chose to
 * hire this way; the student's college has no say in whether a round exists.
 */

export const SIMULATION_ROUND = 'WORK_SIMULATION';

/** Applications still being decided; a closed one has no round left to do. */
const LIVE_APPLICATION = [
  'APPLIED',
  'UNDER_REVIEW',
  'SHORTLISTED',
  'IN_ROUND',
  'WAITLISTED',
] as const;

function roundSimulationId(config: unknown): string | null {
  const id = (config as { simulationId?: unknown } | null)?.simulationId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * The check a job's rounds go through when saved. A round pointing at a
 * draft, or at another company's work, would strand every student who
 * reached it - so it is refused at the door with a message the recruiter
 * can act on.
 */
export async function assertSimulationRound(companyId: string, config: unknown) {
  const simulationId = roundSimulationId(config);
  if (!simulationId) throw badRequest('Pick the work simulation this round uses.');
  const sim = await prisma.simulation.findFirst({ where: { id: simulationId, companyId }, select: { status: true } });
  if (!sim) throw badRequest('That work simulation is not one of your company’s.');
  if (sim.status !== SimulationStatus.PUBLISHED) {
    throw badRequest('Publish that work simulation before using it as a round - students cannot open a draft.');
  }
}

/**
 * Whether a student may open a simulation because a job put it in their way.
 * Any application of theirs whose job has it as a round counts, not only the
 * current one: a student who moved on still needs to read their certificate.
 */
export async function hasRoundAccess(candidateId: string, simulationId: string): Promise<boolean> {
  const rounds = await prisma.round.findMany({
    where: { type: SIMULATION_ROUND, job: { applications: { some: { candidateId } } } },
    select: { config: true },
  });
  return rounds.some((r) => roundSimulationId(r.config) === simulationId);
}

function enrolmentView(e: { status: EnrolmentStatus; certificateCode: string | null; explainAt: Date | null } | null) {
  return e ? { status: e.status, certificateCode: e.certificateCode, explainAt: e.explainAt } : null;
}

/** For the student's applications page: each application sitting in a simulation round. */
export async function roundSimulationsForStudent(candidateId: string) {
  const apps = await prisma.application.findMany({
    where: {
      candidateId,
      status: { in: [...LIVE_APPLICATION] },
      currentRound: { type: SIMULATION_ROUND },
    },
    select: { id: true, currentRound: { select: { id: true, name: true, config: true } } },
  });
  const ids = [...new Set(apps.map((a) => roundSimulationId(a.currentRound?.config)).filter((x): x is string => !!x))];
  const [sims, mine] = await Promise.all([
    prisma.simulation.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, estimatedHours: true, status: true } }),
    prisma.simulationEnrolment.findMany({ where: { candidateId, simulationId: { in: ids } } }),
  ]);
  return apps.flatMap((a) => {
    const sim = sims.find((s) => s.id === roundSimulationId(a.currentRound?.config));
    if (!sim || !a.currentRound) return [];
    const e = mine.find((m) => m.simulationId === sim.id) ?? null;
    return [
      {
        applicationId: a.id,
        roundId: a.currentRound.id,
        roundName: a.currentRound.name,
        simulation: { id: sim.id, title: sim.title, estimatedHours: sim.estimatedHours },
        // Starting needs a published simulation; carrying on with one already
        // started does not, so a company archiving it mid-round strands nobody.
        canStart: sim.status === SimulationStatus.PUBLISHED,
        enrolment: enrolmentView(e),
      },
    ];
  });
}

/**
 * "Start it" from an application. Only while the application sits in that
 * round and the simulation is published; calling it again returns the same
 * enrolment rather than a second one.
 */
export async function startRoundSimulation(candidateId: string, applicationId: string) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, candidateId },
    select: { status: true, job: { select: { companyId: true } }, currentRound: { select: { type: true, config: true } } },
  });
  if (!app) throw notFound('No such application.');
  const simulationId = roundSimulationId(app.currentRound?.config);
  if (
    !(LIVE_APPLICATION as readonly string[]).includes(app.status) ||
    app.currentRound?.type !== SIMULATION_ROUND ||
    !simulationId
  ) {
    throw conflict('This application is not at a work-simulation round right now.');
  }
  const sim = await prisma.simulation.findFirst({
    where: { id: simulationId, companyId: app.job.companyId, status: SimulationStatus.PUBLISHED },
    select: { id: true },
  });
  if (!sim) throw conflict('The company has taken this simulation down. Ask them what happens next.');
  const e = await prisma.simulationEnrolment.upsert({
    where: { simulationId_candidateId: { simulationId, candidateId } },
    update: {},
    create: { simulationId, candidateId },
  });
  return { simulationId, enrolment: enrolmentView(e) };
}

/**
 * For the company's applicant page: every simulation round in the job, and
 * how far this applicant has got in each. Only the company's own applicants -
 * anything else is the same 404 as a missing one.
 */
export async function roundSimulationsForCompany(companyId: string, applicationId: string) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, job: { companyId } },
    select: {
      candidateId: true,
      currentRoundId: true,
      job: { select: { rounds: { where: { type: SIMULATION_ROUND }, orderBy: { order: 'asc' }, select: { id: true, name: true, config: true } } } },
    },
  });
  if (!app) throw notFound('No such application.');
  const ids = app.job.rounds.map((r) => roundSimulationId(r.config)).filter((x): x is string => !!x);
  const [sims, enrolments] = await Promise.all([
    prisma.simulation.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, title: true, estimatedHours: true } }),
    prisma.simulationEnrolment.findMany({ where: { candidateId: app.candidateId, simulationId: { in: ids } } }),
  ]);
  return app.job.rounds.flatMap((r) => {
    const sim = sims.find((s) => s.id === roundSimulationId(r.config));
    if (!sim) return [];
    const e = enrolments.find((x) => x.simulationId === sim.id) ?? null;
    return [
      {
        roundId: r.id,
        roundName: r.name,
        isCurrent: r.id === app.currentRoundId,
        simulation: sim,
        enrolment: e ? { id: e.id, ...enrolmentView(e)! } : null,
      },
    ];
  });
}
