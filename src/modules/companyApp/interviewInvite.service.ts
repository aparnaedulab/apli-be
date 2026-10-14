/**
 * Interview invites from company → candidate.
 *
 * A company sees a student's shared work or review and invites them to an
 * interview process. This creates an InterviewInvite record, sends an in-app
 * notification to the student, and lets the company track rounds and record
 * feedback for each one.
 *
 * Deliberately separate from the campus-drive Application pipeline — these
 * invites come directly from a student's work, not from a placement season.
 */

import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound, conflict } from '../../lib/errors.js';

/* ── helpers ──────────────────────────────────────────────────────────── */

async function ownedInvite(companyId: string, id: string) {
  const inv = await prisma.interviewInvite.findUnique({ where: { id } });
  if (!inv) throw notFound('Interview invite not found.');
  if (inv.companyId !== companyId) throw forbidden('This invite belongs to another company.');
  return inv;
}

/* ── company: send an invite ───────────────────────────────────────────── */

export interface InviteInput {
  candidateId: string;
  processId: string;
  role: string;
  message?: string;
}

export async function sendInterviewInvite(
  companyId: string,
  sentById: string,
  input: InviteInput,
) {
  // Verify the process belongs to this company
  const process = await prisma.interviewProcess.findFirst({
    where: { id: input.processId, companyId },
    include: { rounds: { orderBy: { order: 'asc' } }, company: { select: { name: true } } },
  });
  if (!process) throw notFound('Interview process not found.');
  if (process.rounds.length === 0) throw conflict('Add at least one round to the process before inviting.');

  // Verify candidate exists
  const candidate = await prisma.candidate.findUnique({
    where: { id: input.candidateId },
    include: { user: { select: { id: true, fullName: true, email: true } } },
  });
  if (!candidate) throw notFound('Candidate not found.');

  // Prevent duplicate pending invites
  const existing = await prisma.interviewInvite.findFirst({
    where: {
      companyId,
      candidateId: input.candidateId,
      processId: input.processId,
      status: { in: ['PENDING', 'ACCEPTED'] },
    },
  });
  if (existing) throw conflict('An active invite already exists for this candidate and process.');

  const invite = await prisma.$transaction(async (tx) => {
    const inv = await tx.interviewInvite.create({
      data: {
        companyId,
        candidateId: input.candidateId,
        processId: input.processId,
        sentById,
        role: input.role,
        message: input.message ?? null,
        status: 'PENDING',
        currentRoundOrder: 1,
      },
    });

    // In-app notification for the student
    await tx.notification.create({
      data: {
        userId: candidate.user.id,
        type: 'interview.invited',
        title: `Interview invite from ${process.company.name}`,
        body: `${process.company.name} has invited you to interview for ${input.role}. ${process.rounds.length} round${process.rounds.length === 1 ? '' : 's'} — open to see details and accept.`,
        link: '/student/interviews',
        payload: { inviteId: inv.id, companyId, role: input.role },
      },
    });

    return inv;
  });

  return getInviteForCompany(companyId, invite.id);
}

/* ── company: list all invites ─────────────────────────────────────────── */

export async function listInvitesForCompany(companyId: string) {
  const invites = await prisma.interviewInvite.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    include: {
      candidate: { include: { user: { select: { fullName: true, email: true } } } },
      process: { select: { title: true, processType: true } },
      roundFeedbacks: { orderBy: { roundOrder: 'asc' } },
      sentBy: { select: { fullName: true } },
    },
  });

  return invites.map(formatCompanyInvite);
}

/* ── company: one invite ───────────────────────────────────────────────── */

export async function getInviteForCompany(companyId: string, id: string) {
  await ownedInvite(companyId, id);

  const inv = await prisma.interviewInvite.findUniqueOrThrow({
    where: { id },
    include: {
      candidate: { include: { user: { select: { fullName: true, email: true } } } },
      process: { include: { rounds: { orderBy: { order: 'asc' } } } },
      roundFeedbacks: { orderBy: { roundOrder: 'asc' } },
      sentBy: { select: { fullName: true } },
    },
  });

  return formatCompanyInvite(inv);
}

/* ── company: record round feedback ───────────────────────────────────── */

export interface FeedbackInput {
  roundOrder: number;
  outcome: 'PASSED' | 'FAILED' | 'SKIPPED';
  score?: number;
  notes?: string;
}

export async function recordRoundFeedback(
  companyId: string,
  inviteId: string,
  input: FeedbackInput,
) {
  const inv = await ownedInvite(companyId, inviteId);
  if (inv.status === 'REJECTED' || inv.status === 'WITHDRAWN') {
    throw conflict('Cannot record feedback on a closed invite.');
  }

  const process = await prisma.interviewProcess.findUniqueOrThrow({
    where: { id: inv.processId },
    include: { rounds: { orderBy: { order: 'asc' } } },
  });

  const round = process.rounds.find((r) => r.order === input.roundOrder);
  if (!round) throw notFound(`Round ${input.roundOrder} does not exist in this process.`);

  // Upsert feedback for this round
  await prisma.interviewRoundFeedback.upsert({
    where: { inviteId_roundOrder: { inviteId, roundOrder: input.roundOrder } },
    create: {
      inviteId,
      roundOrder: input.roundOrder,
      roundName: round.name,
      outcome: input.outcome,
      score: input.score ?? null,
      notes: input.notes ?? null,
    },
    update: {
      outcome: input.outcome,
      score: input.score ?? null,
      notes: input.notes ?? null,
    },
  });

  // Advance to the next round or close the invite based on outcome
  const maxOrder = process.rounds.length;
  let newStatus = inv.status;
  let newRoundOrder = inv.currentRoundOrder;

  if (input.outcome === 'PASSED' || input.outcome === 'SKIPPED') {
    if (input.roundOrder >= maxOrder) {
      // All rounds done — move to offered
      newStatus = 'OFFERED';
    } else {
      newRoundOrder = input.roundOrder + 1;
    }
  } else if (input.outcome === 'FAILED') {
    // Check if this was an eliminating round
    if (round.isElimination) {
      newStatus = 'REJECTED';
    }
    // Non-eliminating: feedback recorded but candidate continues
  }

  const updated = await prisma.$transaction(async (tx) => {
    const upd = await tx.interviewInvite.update({
      where: { id: inviteId },
      data: { status: newStatus, currentRoundOrder: newRoundOrder },
    });

    // Notify candidate of result if status changed
    if (newStatus !== inv.status) {
      const candidate = await tx.candidate.findUniqueOrThrow({
        where: { id: inv.candidateId },
        include: { user: { select: { id: true } } },
      });
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });

      const title =
        newStatus === 'OFFERED'
          ? `You have cleared all rounds at ${company.name}`
          : `Application update from ${company.name}`;
      const body =
        newStatus === 'OFFERED'
          ? `Congratulations! You have passed all rounds for ${inv.role} at ${company.name}.`
          : `${company.name} has updated your status for ${inv.role}.`;

      await tx.notification.create({
        data: {
          userId: candidate.user.id,
          type: `interview.${newStatus.toLowerCase()}`,
          title,
          body,
          link: '/student/interviews',
          payload: { inviteId, status: newStatus },
        },
      });
    }

    return upd;
  });

  return getInviteForCompany(companyId, updated.id);
}

/* ── company: withdraw invite ─────────────────────────────────────────── */

export async function withdrawInvite(companyId: string, inviteId: string) {
  const inv = await ownedInvite(companyId, inviteId);
  if (['REJECTED', 'WITHDRAWN', 'OFFERED'].includes(inv.status)) {
    throw conflict('This invite cannot be withdrawn.');
  }

  await prisma.interviewInvite.update({
    where: { id: inviteId },
    data: { status: 'WITHDRAWN' },
  });
}

/* ── student: list invites ─────────────────────────────────────────────── */

export async function listInvitesForStudent(candidateId: string) {
  const invites = await prisma.interviewInvite.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    include: {
      company: { select: { name: true, logoUrl: true } },
      process: { include: { rounds: { orderBy: { order: 'asc' } } } },
      roundFeedbacks: { orderBy: { roundOrder: 'asc' } },
    },
  });

  return invites.map(formatStudentInvite);
}

/* ── student: respond to invite ───────────────────────────────────────── */

export async function respondToInvite(
  candidateId: string,
  inviteId: string,
  decision: 'ACCEPTED' | 'DECLINED',
) {
  const inv = await prisma.interviewInvite.findUnique({ where: { id: inviteId } });
  if (!inv) throw notFound('Invite not found.');
  if (inv.candidateId !== candidateId) throw forbidden('This invite is not yours.');
  if (inv.status !== 'PENDING') throw conflict('This invite has already been answered.');

  await prisma.interviewInvite.update({
    where: { id: inviteId },
    data: { status: decision, respondedAt: new Date() },
  });
}

/* ── formatters ────────────────────────────────────────────────────────── */

type FullCompanyInvite = Awaited<ReturnType<typeof prisma.interviewInvite.findUniqueOrThrow>> & {
  candidate: { user: { fullName: string; email: string } } & { phone?: string | null };
  process: { title: string; processType: string; rounds?: { order: number; name: string; type: string; isElimination: boolean; durationMin: number | null; isOnline: boolean; meetingLink: string | null; addressLine: string | null }[] };
  roundFeedbacks: { roundOrder: number; roundName: string; outcome: string; score: number | null; notes: string | null }[];
  sentBy?: { fullName: string } | null;
};

function formatCompanyInvite(inv: FullCompanyInvite) {
  return {
    id: inv.id,
    role: inv.role,
    message: inv.message,
    status: inv.status,
    currentRoundOrder: inv.currentRoundOrder,
    createdAt: inv.createdAt,
    respondedAt: inv.respondedAt,
    candidate: {
      id: inv.candidateId,
      name: inv.candidate.user.fullName,
      email: inv.candidate.user.email,
    },
    process: {
      id: inv.processId,
      title: inv.process.title,
      processType: inv.process.processType,
      rounds: 'rounds' in inv.process ? inv.process.rounds : [],
    },
    roundFeedbacks: inv.roundFeedbacks,
    sentBy: inv.sentBy?.fullName ?? null,
  };
}

type FullStudentInvite = Awaited<ReturnType<typeof prisma.interviewInvite.findUniqueOrThrow>> & {
  company: { name: string; logoUrl: string | null };
  process: { title: string; processType: string; rounds: { order: number; name: string; type: string; isElimination: boolean; durationMin: number | null; isOnline: boolean; description: string | null }[] };
  roundFeedbacks: { roundOrder: number; roundName: string; outcome: string; score: number | null; notes: string | null }[];
};

function formatStudentInvite(inv: FullStudentInvite) {
  return {
    id: inv.id,
    role: inv.role,
    message: inv.message,
    status: inv.status,
    currentRoundOrder: inv.currentRoundOrder,
    createdAt: inv.createdAt,
    respondedAt: inv.respondedAt,
    company: inv.company,
    process: {
      title: inv.process.title,
      processType: inv.process.processType,
      rounds: inv.process.rounds,
    },
    roundFeedbacks: inv.roundFeedbacks,
  };
}
