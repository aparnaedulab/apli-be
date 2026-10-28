import { JobOptionKind, WorkSimulationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { assertKnown, labelsFor } from '../jobs/job.options.js';
import { BUILT_IN_PACKS } from './interviewPacks.js';

/**
 * A company's own interview processes: named, reusable sets of rounds it
 * puts students through after seeing their work. Round types are the same
 * vocabulary as job rounds - the shipped ones plus any the company adds.
 *
 * Once a process has invites, its rounds are fixed: students are part way
 * through them and their recorded answers hang off its questions. To change
 * it, the company duplicates it.
 */

export const VIDEO_ROUND = 'VIDEO_INTERVIEW';
export const SIMULATION_ROUND = 'WORK_SIMULATION';

/** Invites still running; a withdrawn or declined one does not hold the process. */
const LIVE_INVITE = { status: { in: ['PENDING', 'ACCEPTED', 'OFFERED', 'REJECTED'] } };

/** Fetch one process and assert it belongs to this company. */
export async function ownedProcess(companyId: string, id: string) {
  const p = await prisma.interviewProcess.findUnique({ where: { id } });
  if (!p) throw notFound('Interview process not found.');
  if (p.companyId !== companyId) throw forbidden('This process belongs to another company.');
  return p;
}

/** All processes for a company, newest first. */
export async function listProcesses(companyId: string) {
  const rows = await prisma.interviewProcess.findMany({
    where: { companyId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { rounds: true, invites: true } } },
  });

  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    processType: p.processType,
    status: p.status,
    roundCount: p._count.rounds,
    inviteCount: p._count.invites,
    updatedAt: p.updatedAt,
  }));
}

/** Full process with rounds, their questions, and whether it can still change. */
export async function getProcess(companyId: string, id: string) {
  await ownedProcess(companyId, id);

  const p = await prisma.interviewProcess.findUniqueOrThrow({
    where: { id },
    include: {
      rounds: { orderBy: { order: 'asc' }, include: { questions: { orderBy: { order: 'asc' } } } },
      _count: { select: { invites: { where: LIVE_INVITE } } },
    },
  });
  const simIds = p.rounds.map((r) => r.simulationId).filter((x): x is string => Boolean(x));
  const sims = simIds.length
    ? await prisma.workSimulation.findMany({ where: { id: { in: simIds } }, select: { id: true, title: true } })
    : [];
  const label = await labelsFor(companyId);

  return {
    id: p.id,
    title: p.title,
    description: p.description,
    processType: p.processType,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    roundCount: p.rounds.length,
    inviteCount: p._count.invites,
    /** False once students are going through it. */
    editable: p._count.invites === 0,
    rounds: p.rounds.map((r) => ({
      id: r.id,
      order: r.order,
      name: r.name,
      type: r.type,
      typeLabel: label(JobOptionKind.ROUND_TYPE, r.type) ?? r.type,
      isElimination: r.isElimination,
      description: r.description,
      isOnline: r.isOnline,
      meetingLink: r.meetingLink,
      addressLine: r.addressLine,
      shortlistCount: r.shortlistCount,
      durationMin: r.durationMin,
      mode: r.mode,
      questionTimeSec: r.questionTimeSec,
      prepTimeSec: r.prepTimeSec,
      simulationId: r.simulationId,
      simulationTitle: sims.find((s) => s.id === r.simulationId)?.title ?? null,
      questions: r.questions.map((q) => ({ id: q.id, order: q.order, text: q.text, hint: q.hint, type: q.type })),
    })),
  };
}

export interface ProcessInput {
  title: string;
  description?: string | null;
  processType: string;
}

/** Create a new process (always starts as DRAFT). */
export async function createProcess(companyId: string, userId: string, data: ProcessInput) {
  const p = await prisma.interviewProcess.create({
    data: {
      companyId,
      createdById: userId,
      title: data.title,
      description: data.description ?? null,
      processType: data.processType,
      status: 'DRAFT',
    },
  });
  return getProcess(companyId, p.id);
}

/** Update title / description / status. */
export async function updateProcess(
  companyId: string,
  id: string,
  data: Partial<ProcessInput> & { status?: string },
) {
  await ownedProcess(companyId, id);
  if (data.status === 'ACTIVE') {
    const rounds = await prisma.interviewProcessRound.count({ where: { processId: id } });
    if (!rounds) throw badRequest('Add at least one round before making it active.');
  }
  await prisma.interviewProcess.update({
    where: { id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description ?? null }),
      ...(data.processType !== undefined && { processType: data.processType }),
      ...(data.status !== undefined && { status: data.status }),
    },
  });
  return getProcess(companyId, id);
}

export interface QuestionInput {
  text: string;
  hint?: string | null;
  type?: string | null;
}

export interface RoundInput {
  order: number;
  name: string;
  type: string;
  isElimination: boolean;
  description?: string | null;
  isOnline: boolean;
  meetingLink?: string | null;
  addressLine?: string | null;
  shortlistCount?: number | null;
  durationMin?: number | null;
  mode?: string | null;
  questionTimeSec?: number | null;
  prepTimeSec?: number | null;
  simulationId?: string | null;
  questions?: QuestionInput[];
}

/**
 * Replaces all rounds on a process at once. Each round's type must be one
 * the company knows; a recorded interview needs questions; a work-simulation
 * round needs one of the company's live simulations.
 */
export async function setProcessRounds(companyId: string, id: string, rounds: RoundInput[]) {
  await ownedProcess(companyId, id);
  const running = await prisma.interviewInvite.count({ where: { processId: id, ...LIVE_INVITE } });
  if (running) {
    throw conflict('Students are already going through this process, so its rounds are fixed. Duplicate it to make changes.');
  }

  for (const [i, r] of rounds.entries()) {
    const where = `Round ${i + 1}`;
    await assertKnown(companyId, JobOptionKind.ROUND_TYPE, r.type);
    if (r.mode) await assertKnown(companyId, JobOptionKind.ROUND_MODE, r.mode);
    if (r.type === VIDEO_ROUND && !r.questions?.length) {
      throw badRequest(`${where} is a recorded interview - add at least one question.`);
    }
    if (r.type === SIMULATION_ROUND) {
      if (!r.simulationId) throw badRequest(`${where} is a work simulation - pick which one.`);
      const sim = await prisma.workSimulation.findFirst({
        where: { id: r.simulationId, companyId, status: WorkSimulationStatus.LIVE },
        select: { id: true },
      });
      if (!sim) throw badRequest(`${where}: pick one of your live simulations.`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.interviewProcessRound.deleteMany({ where: { processId: id } });
    for (const [i, r] of rounds.entries()) {
      const video = r.type === VIDEO_ROUND;
      await tx.interviewProcessRound.create({
        data: {
          processId: id,
          order: i + 1,
          name: r.name,
          type: r.type,
          isElimination: r.isElimination,
          description: r.description ?? null,
          isOnline: r.isOnline,
          meetingLink: r.isOnline ? (r.meetingLink ?? null) : null,
          addressLine: r.isOnline ? null : (r.addressLine ?? null),
          shortlistCount: r.shortlistCount ?? null,
          durationMin: r.durationMin ?? null,
          mode: r.mode ?? null,
          questionTimeSec: video ? (r.questionTimeSec ?? 90) : null,
          prepTimeSec: video ? (r.prepTimeSec ?? 30) : null,
          simulationId: r.type === SIMULATION_ROUND ? r.simulationId! : null,
          questions: video
            ? {
                create: r.questions!.map((q, k) => ({
                  order: k + 1,
                  text: q.text,
                  hint: q.hint || null,
                  type: q.type || 'behavioural',
                })),
              }
            : undefined,
        },
      });
    }
    await tx.interviewProcess.update({ where: { id }, data: { updatedAt: new Date() } });
  });

  return getProcess(companyId, id);
}

/** A copy with the same rounds and questions, as a fresh draft nobody is in. */
export async function duplicateProcess(companyId: string, userId: string, id: string) {
  const from = await getProcess(companyId, id);
  const copy = await prisma.interviewProcess.create({
    data: {
      companyId,
      createdById: userId,
      title: `${from.title} (copy)`.slice(0, 120),
      description: from.description,
      processType: from.processType,
      status: 'DRAFT',
    },
  });
  if (from.rounds.length) {
    await setProcessRounds(
      companyId,
      copy.id,
      from.rounds.map((r) => ({ ...r, questions: r.questions })),
    );
  }
  return getProcess(companyId, copy.id);
}

/** Deletes a process - not one students are going through. */
export async function removeProcess(companyId: string, id: string) {
  await ownedProcess(companyId, id);
  const running = await prisma.interviewInvite.count({ where: { processId: id, ...LIVE_INVITE } });
  if (running) throw conflict('Students are going through this process. Archive it instead of deleting it.');
  await prisma.interviewProcess.delete({ where: { id } });
}

/** Question packs to pull into a recorded interview: Apli.ai's own, then any the platform added. */
export async function questionPacks() {
  const rows = await prisma.interviewQuestionPackage.findMany({
    where: { kind: VIDEO_ROUND },
    orderBy: { createdAt: 'desc' },
  });
  const added = rows.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description ?? '',
    role: p.role,
    questions: (Array.isArray(p.questions) ? p.questions : []) as { text: string; hint?: string; type: string }[],
  }));
  return [...BUILT_IN_PACKS, ...added];
}

/** The company's live simulations, for a work-simulation round. */
export async function simulationChoices(companyId: string) {
  return prisma.workSimulation.findMany({
    where: { companyId, status: WorkSimulationStatus.LIVE },
    orderBy: { title: 'asc' },
    select: { id: true, title: true, hours: true },
  });
}
