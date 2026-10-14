import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';

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
    include: { _count: { select: { rounds: true } } },
  });

  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    processType: p.processType,
    status: p.status,
    roundCount: p._count.rounds,
    updatedAt: p.updatedAt,
  }));
}

/** Full process with rounds. */
export async function getProcess(companyId: string, id: string) {
  await ownedProcess(companyId, id);

  const p = await prisma.interviewProcess.findUniqueOrThrow({
    where: { id },
    include: { rounds: { orderBy: { order: 'asc' } } },
  });

  return {
    id: p.id,
    title: p.title,
    description: p.description,
    processType: p.processType,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    roundCount: p.rounds.length,
    rounds: p.rounds.map((r) => ({
      id: r.id,
      order: r.order,
      name: r.name,
      type: r.type,
      isElimination: r.isElimination,
      description: r.description,
      isOnline: r.isOnline,
      meetingLink: r.meetingLink,
      addressLine: r.addressLine,
      shortlistCount: r.shortlistCount,
      durationMin: r.durationMin,
      mode: r.mode,
    })),
  };
}

export interface ProcessInput {
  title: string;
  description?: string | null;
  processType: string;
}

/** Create a new process (always starts as DRAFT). */
export async function createProcess(
  companyId: string,
  userId: string,
  data: ProcessInput,
) {
  const p = await prisma.interviewProcess.create({
    data: {
      companyId,
      createdById: userId,
      title: data.title,
      description: data.description ?? null,
      processType: data.processType,
      status: 'DRAFT',
    },
    include: { rounds: true },
  });

  return { ...p, roundCount: 0 };
}

/** Update title / description / status. */
export async function updateProcess(
  companyId: string,
  id: string,
  data: Partial<ProcessInput> & { status?: string },
) {
  await ownedProcess(companyId, id);

  const p = await prisma.interviewProcess.update({
    where: { id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description ?? null }),
      ...(data.processType !== undefined && { processType: data.processType }),
      ...(data.status !== undefined && { status: data.status }),
    },
    include: { rounds: { orderBy: { order: 'asc' } } },
  });

  return { ...p, roundCount: p.rounds.length };
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
}

/** Replace all rounds on a process atomically. */
export async function setProcessRounds(
  companyId: string,
  id: string,
  rounds: RoundInput[],
) {
  await ownedProcess(companyId, id);

  await prisma.$transaction(async (tx) => {
    await tx.interviewProcessRound.deleteMany({ where: { processId: id } });
    if (rounds.length) {
      await tx.interviewProcessRound.createMany({
        data: rounds.map((r, i) => ({
          processId: id,
          order: i + 1,
          name: r.name,
          type: r.type,
          isElimination: r.isElimination,
          description: r.description ?? null,
          isOnline: r.isOnline,
          meetingLink: r.isOnline ? r.meetingLink ?? null : null,
          addressLine: r.isOnline ? null : r.addressLine ?? null,
          shortlistCount: r.shortlistCount ?? null,
          durationMin: r.durationMin ?? null,
          mode: r.mode ?? null,
        })),
      });
    }
  });

  const p = await prisma.interviewProcess.findUniqueOrThrow({
    where: { id },
    include: { rounds: { orderBy: { order: 'asc' } } },
  });

  return {
    id: p.id,
    title: p.title,
    description: p.description,
    processType: p.processType,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    roundCount: p.rounds.length,
    rounds: p.rounds,
  };
}

/** Permanently delete a process and all its rounds. */
export async function removeProcess(companyId: string, id: string) {
  await ownedProcess(companyId, id);
  await prisma.interviewProcess.delete({ where: { id } });
}
