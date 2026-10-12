import { CompanyStatus, RunStatus, WorkSimulationLevel, WorkSimulationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { activeInterests } from '../students/lists.js';
import { review, reviewQueue } from '../studentApp/studentApp.service.js';
import type { z } from 'zod';
import { handInKindsSchema, pagesSchema, readHandInKinds, readPages } from './pages.js';

/**
 * The company app: a company writes work simulations, sends them to Apli.ai
 * to check, and once they are live reviews what students hand in.
 *
 *   DRAFT ──submit──▶ SUBMITTED ──approved by Apli.ai──▶ LIVE ──retire──▶ RETIRED
 *     ▲                   │
 *     └── CHANGES_ASKED ◀─┘ (with a note)
 *
 * A simulation can be edited only while it is with the company (DRAFT or
 * CHANGES_ASKED). Once live, students are part way through its tasks, so
 * it stays as it is; a company retires it and writes a new one instead.
 */

const EDITABLE: WorkSimulationStatus[] = [WorkSimulationStatus.DRAFT, WorkSimulationStatus.CHANGES_ASKED];

export interface SimulationInput {
  title: string;
  summary: string;
  about?: string | null;
  coverUrl?: string | null;
  videoUrl?: string | null;
  field: string;
  level: WorkSimulationLevel;
  hours: number;
  skills: string[];
  tasks: {
    title: string;
    brief: string;
    handIn?: string | null;
    learn?: string[];
    steps?: string[];
    /** As written; ids are filled in for any page or question without one. */
    pages?: z.input<typeof pagesSchema>;
    /** How students may hand it in; all three when left out. */
    handInKinds?: z.input<typeof handInKindsSchema>;
    minutes: number;
  }[];
}

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** The task rows a simulation is written with, in order. */
const taskRows = (input: SimulationInput) =>
  input.tasks.map((t, i) => ({
    position: i + 1,
    title: t.title,
    brief: t.brief,
    handIn: t.handIn || null,
    learn: t.learn ?? [],
    steps: t.steps ?? [],
    pages: pagesSchema.parse(t.pages ?? []),
    handInKinds: handInKindsSchema.parse(t.handInKinds ?? undefined),
    minutes: t.minutes,
  }));

/** The simulation's own fields, as written. */
const details = (input: SimulationInput) => ({
  title: input.title,
  summary: input.summary,
  about: input.about || null,
  coverUrl: input.coverUrl || null,
  videoUrl: input.videoUrl || null,
  field: input.field,
  level: input.level,
  hours: input.hours,
  skills: input.skills,
});

async function companyOf(companyId: string) {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, logoUrl: true, status: true },
  });
  if (!c) throw notFound('No such company.');
  return c;
}

async function own(companyId: string, id: string) {
  const sim = await prisma.workSimulation.findFirst({ where: { id, companyId }, select: { id: true, status: true } });
  if (!sim) throw notFound('No such simulation.');
  return sim;
}

/** "Northwind Analytics" + "Build a sales dashboard" -> "northwind-analytics-build-a-sales-dashboard" */
async function uniqueSlug(company: string, title: string): Promise<string> {
  const base =
    `${company} ${title}`
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'simulation';
  let slug = base;
  for (let n = 2; await prisma.workSimulation.findUnique({ where: { slug }, select: { id: true } }); n += 1) {
    slug = `${base}-${n}`;
  }
  return slug;
}

async function checkField(field: string) {
  const fields = await activeInterests();
  if (fields.length && !fields.includes(field)) throw badRequest('Pick the field from the list.');
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

export async function overview(companyId: string) {
  const company = await companyOf(companyId);
  const [sims, runs, sharedWith] = await Promise.all([
    prisma.workSimulation.groupBy({ by: ['status'], where: { companyId }, _count: true }),
    prisma.workSimulationRun.groupBy({
      by: ['status'],
      where: { simulation: { companyId } },
      _count: true,
    }),
    prisma.workSimulationShare.findMany({
      where: { companyId },
      distinct: ['runId'],
      select: { run: { select: { candidateId: true } } },
    }),
  ]);
  const simCount = (s: WorkSimulationStatus) => sims.find((x) => x.status === s)?._count ?? 0;
  const runCount = (...s: RunStatus[]) => runs.filter((x) => s.includes(x.status)).reduce((n, x) => n + x._count, 0);
  const toReview = (await reviewQueue()).filter((r) => r.companyId === companyId);
  return {
    company,
    simulations: {
      draft: simCount(WorkSimulationStatus.DRAFT) + simCount(WorkSimulationStatus.CHANGES_ASKED),
      submitted: simCount(WorkSimulationStatus.SUBMITTED),
      live: simCount(WorkSimulationStatus.LIVE),
      retired: simCount(WorkSimulationStatus.RETIRED),
      changesAsked: simCount(WorkSimulationStatus.CHANGES_ASKED),
    },
    students: {
      working: runCount(RunStatus.ACTIVE, RunStatus.NEEDS_WORK),
      toReview: toReview.length,
      verified: runCount(RunStatus.COMPLETED),
      sharedWithYou: new Set(sharedWith.map((s) => s.run.candidateId)).size,
    },
    waiting: toReview.slice(0, 5).map((r) => ({
      runId: r.runId,
      student: r.student.name,
      simulation: r.simulation.title,
      submittedAt: r.submittedAt,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Writing simulations                                                         */
/* -------------------------------------------------------------------------- */

export async function listSimulations(companyId: string) {
  const rows = await prisma.workSimulation.findMany({
    where: { companyId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      slug: true,
      title: true,
      field: true,
      level: true,
      hours: true,
      status: true,
      reviewNote: true,
      submittedAt: true,
      publishedAt: true,
      updatedAt: true,
      _count: { select: { tasks: true } },
      runs: { select: { status: true } },
    },
  });
  return rows.map(({ runs, _count, ...r }) => ({
    ...r,
    tasks: _count.tasks,
    students: {
      working: runs.filter((x) => x.status === RunStatus.ACTIVE || x.status === RunStatus.NEEDS_WORK).length,
      toReview: runs.filter((x) => x.status === RunStatus.IN_REVIEW).length,
      verified: runs.filter((x) => x.status === RunStatus.COMPLETED).length,
    },
  }));
}

export async function getSimulation(companyId: string, id: string) {
  const sim = await prisma.workSimulation.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      about: true,
      coverUrl: true,
      videoUrl: true,
      field: true,
      level: true,
      hours: true,
      skills: true,
      status: true,
      reviewNote: true,
      submittedAt: true,
      publishedAt: true,
      tasks: {
        orderBy: { position: 'asc' },
        select: { id: true, position: true, title: true, brief: true, handIn: true, learn: true, steps: true, pages: true, handInKinds: true, minutes: true },
      },
    },
  });
  if (!sim) throw notFound('No such simulation.');
  return {
    ...sim,
    skills: list(sim.skills),
    tasks: sim.tasks.map((t) => ({ ...t, learn: list(t.learn), steps: list(t.steps), pages: readPages(t.pages), handInKinds: readHandInKinds(t.handInKinds) })),
    editable: EDITABLE.includes(sim.status),
  };
}

export async function createSimulation(companyId: string, userId: string, input: SimulationInput) {
  const company = await companyOf(companyId);
  await checkField(input.field);
  const sim = await prisma.workSimulation.create({
    data: {
      companyId,
      createdById: userId,
      slug: await uniqueSlug(company.name, input.title),
      ...details(input),
      tasks: { create: taskRows(input) },
    },
    select: { id: true },
  });
  return getSimulation(companyId, sim.id);
}

/** Replaces a draft's details and tasks. Only while it is with the company. */
export async function updateSimulation(companyId: string, id: string, input: SimulationInput) {
  const sim = await own(companyId, id);
  if (!EDITABLE.includes(sim.status)) {
    throw conflict(
      sim.status === WorkSimulationStatus.SUBMITTED
        ? 'This is with Apli.ai to check. Withdraw it to make changes.'
        : 'Students are doing this one, so it cannot change. Retire it and write a new one.',
    );
  }
  await checkField(input.field);
  await prisma.$transaction([
    prisma.workSimulationTask.deleteMany({ where: { simulationId: id } }),
    prisma.workSimulation.update({
      where: { id },
      data: { ...details(input), tasks: { create: taskRows(input) } },
    }),
  ]);
  return getSimulation(companyId, id);
}

/** Sends a draft to Apli.ai to check. A company must be verified first. */
export async function submitSimulation(companyId: string, id: string) {
  const company = await companyOf(companyId);
  if (company.status !== CompanyStatus.VERIFIED) {
    throw forbidden('Your company is not verified yet. Apli.ai checks new companies before their simulations go live.');
  }
  const sim = await own(companyId, id);
  if (!EDITABLE.includes(sim.status)) throw conflict('Only a draft can be sent to be checked.');
  const tasks = await prisma.workSimulationTask.count({ where: { simulationId: id } });
  if (tasks < 2) throw badRequest('Add at least two tasks before sending it.');
  await prisma.workSimulation.update({
    where: { id },
    data: { status: WorkSimulationStatus.SUBMITTED, submittedAt: new Date() },
  });
  return getSimulation(companyId, id);
}

/** Takes a submitted simulation back to edit it. */
export async function withdrawSimulation(companyId: string, id: string) {
  const sim = await own(companyId, id);
  if (sim.status !== WorkSimulationStatus.SUBMITTED) throw conflict('Only a simulation waiting to be checked can be withdrawn.');
  await prisma.workSimulation.update({ where: { id }, data: { status: WorkSimulationStatus.DRAFT } });
  return getSimulation(companyId, id);
}

/** Closes a live simulation to new students; those part way through can finish. */
export async function retireSimulation(companyId: string, id: string) {
  const sim = await own(companyId, id);
  if (sim.status !== WorkSimulationStatus.LIVE) throw conflict('Only a live simulation can be retired.');
  await prisma.workSimulation.update({ where: { id }, data: { status: WorkSimulationStatus.RETIRED } });
  return getSimulation(companyId, id);
}

/** A draft no student has seen can be thrown away. */
export async function deleteSimulation(companyId: string, id: string) {
  const sim = await own(companyId, id);
  if (!EDITABLE.includes(sim.status)) throw conflict('Only a draft can be deleted.');
  await prisma.workSimulation.delete({ where: { id } });
}

/* -------------------------------------------------------------------------- */
/* Students' work                                                              */
/* -------------------------------------------------------------------------- */

/** Work handed in on this company's simulations, waiting for its decision. */
export async function companyReviewQueue(companyId: string) {
  return (await reviewQueue()).filter((r) => r.companyId === companyId);
}

export async function companyReview(
  companyId: string,
  userId: string,
  runId: string,
  input: { decision: 'approve' | 'changes'; note?: string },
) {
  const run = await prisma.workSimulationRun.findFirst({
    where: { id: runId, simulation: { companyId } },
    select: { id: true },
  });
  if (!run) throw notFound('No such submission.');
  await review(userId, runId, input);
}

/**
 * Students who chose to show this company verified work: who they are, what
 * they did, and how to reach them. Only what they shared, and only while it
 * stays shared.
 */
export async function sharedWithCompany(companyId: string) {
  const shares = await prisma.workSimulationShare.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      run: {
        select: {
          id: true,
          completedAt: true,
          certificateCode: true,
          explainHow: true,
          explainChange: true,
          simulation: {
            select: {
              title: true,
              field: true,
              company: { select: { name: true } },
              tasks: { orderBy: { position: 'asc' }, select: { id: true, title: true } },
            },
          },
          done: { select: { taskId: true, answer: true, link: true, fileUrl: true, fileName: true } },
          candidate: {
            select: {
              id: true,
              city: true,
              phone: true,
              course: true,
              specialisation: true,
              cgpa: true,
              startYear: true,
              graduationYear: true,
              otherCollege: true,
              college: { select: { name: true } },
              listing: { select: { name: true } },
              user: { select: { fullName: true, email: true } },
            },
          },
        },
      },
    },
  });
  return shares.map(({ createdAt, run }) => {
    const handedIn = new Map(run.done.map((d) => [d.taskId, d]));
    const c = run.candidate;
    return {
      sharedAt: createdAt,
      runId: run.id,
      student: {
        id: c.id,
        name: c.user.fullName,
        email: c.user.email,
        phone: c.phone,
        city: c.city,
        college: c.college?.name ?? c.listing?.name ?? c.otherCollege ?? null,
        course: [c.course, c.specialisation].filter(Boolean).join(' · ') || null,
        batch: c.startYear && c.graduationYear ? `${c.startYear} – ${c.graduationYear}` : null,
        cgpa: c.cgpa === null ? null : Number(c.cgpa),
      },
      simulation: { title: run.simulation.title, field: run.simulation.field, company: run.simulation.company.name },
      certificateCode: run.certificateCode,
      completedAt: run.completedAt,
      tasks: run.simulation.tasks.map((t) => ({
        title: t.title,
        answer: handedIn.get(t.id)?.answer ?? null,
        link: handedIn.get(t.id)?.link ?? null,
        fileUrl: handedIn.get(t.id)?.fileUrl ?? null,
        fileName: handedIn.get(t.id)?.fileName ?? null,
      })),
      explainHow: run.explainHow,
      explainChange: run.explainChange,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Apli.ai's check before a simulation goes live                               */
/* -------------------------------------------------------------------------- */

export async function simulationsToCheck() {
  const rows = await prisma.workSimulation.findMany({
    where: { status: WorkSimulationStatus.SUBMITTED },
    orderBy: { submittedAt: 'asc' },
    select: {
      id: true,
      title: true,
      summary: true,
      about: true,
      coverUrl: true,
      videoUrl: true,
      field: true,
      level: true,
      hours: true,
      skills: true,
      submittedAt: true,
      company: { select: { id: true, name: true, status: true } },
      tasks: {
        orderBy: { position: 'asc' },
        select: { position: true, title: true, brief: true, handIn: true, learn: true, steps: true, pages: true, handInKinds: true, minutes: true },
      },
    },
  });
  return rows.map((r) => ({ ...r, skills: list(r.skills), tasks: r.tasks.map((t) => ({ ...t, learn: list(t.learn), steps: list(t.steps), pages: readPages(t.pages), handInKinds: readHandInKinds(t.handInKinds) })) }));
}

/** Makes it live, or sends it back to the company with a note. */
export async function checkSimulation(
  id: string,
  input: { decision: 'approve' | 'changes'; note?: string },
) {
  const sim = await prisma.workSimulation.findUnique({
    where: { id },
    select: { status: true, publishedAt: true, company: { select: { status: true } } },
  });
  if (!sim) throw notFound('No such simulation.');
  if (sim.status !== WorkSimulationStatus.SUBMITTED) throw conflict('This is not waiting to be checked.');
  if (input.decision === 'changes' && !input.note?.trim()) throw badRequest('Say what needs changing.');
  if (input.decision === 'approve' && sim.company.status !== CompanyStatus.VERIFIED) {
    throw conflict('Verify the company before its simulations go live.');
  }
  const now = new Date();
  await prisma.workSimulation.update({
    where: { id },
    data:
      input.decision === 'approve'
        ? {
            status: WorkSimulationStatus.LIVE,
            publishedAt: sim.publishedAt ?? now,
            reviewedAt: now,
            reviewNote: input.note?.trim() || null,
          }
        : { status: WorkSimulationStatus.CHANGES_ASKED, reviewedAt: now, reviewNote: input.note!.trim() },
  });
}
