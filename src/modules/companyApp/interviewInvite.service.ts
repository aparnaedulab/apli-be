/**
 * Interview invites from company → student.
 *
 * A company sees a student's work - handed in, shared, or a test sent to it -
 * and invites them into one of its interview processes. The student accepts
 * or declines; once in, they go through the rounds in order. A recorded
 * interview round they do in the app, question by question; the others
 * (live interview, group discussion, a test...) happen where the company says.
 * The company gives a verdict on each round: passed moves them on, failed
 * on an eliminating round ends it, and passing the last round means the
 * company wants them - it can then offer an internship.
 *
 * Deliberately separate from the campus-drive Application pipeline: these
 * invites come from a student's work, not from a placement season.
 */

import { CompanyStatus, JobOptionKind, WorkSimulationStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { labelsFor } from '../jobs/job.options.js';
import { hasShownWork } from './offers.js';
import { SIMULATION_ROUND, VIDEO_ROUND } from './interviewProcess.service.js';

export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'REJECTED' | 'OFFERED';
const OPEN: InviteStatus[] = ['PENDING', 'ACCEPTED'];

async function ownedInvite(companyId: string, id: string) {
  const inv = await prisma.interviewInvite.findUnique({ where: { id } });
  if (!inv) throw notFound('Interview invite not found.');
  if (inv.companyId !== companyId) throw forbidden('This invite belongs to another company.');
  return inv;
}

const ROUNDS = {
  orderBy: { order: 'asc' },
  include: { questions: { orderBy: { order: 'asc' } } },
} satisfies Prisma.InterviewProcessRoundFindManyArgs;

/* ── company: send an invite ───────────────────────────────────────────── */

export interface InviteInput {
  candidateId: string;
  processId: string;
  role: string;
  message?: string;
}

export async function sendInterviewInvite(companyId: string, sentById: string, input: InviteInput) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { status: true, name: true } });
  if (company?.status !== CompanyStatus.VERIFIED) throw forbidden('Your company is not verified yet, so it cannot invite students.');

  const process = await prisma.interviewProcess.findFirst({
    where: { id: input.processId, companyId },
    include: { rounds: { orderBy: { order: 'asc' } } },
  });
  if (!process) throw notFound('Interview process not found.');
  if (process.status === 'ARCHIVED') throw conflict('That process is archived. Pick an active one.');
  if (process.rounds.length === 0) throw conflict('Add at least one round to the process before inviting.');

  // A company may interview a student who showed it their work, or who
  // applied for one of its jobs - either way the student came to it first.
  const appliedHere = await prisma.application.count({
    where: { candidateId: input.candidateId, job: { companyId } },
  });
  if (!appliedHere && !(await hasShownWork(companyId, input.candidateId))) {
    throw forbidden('You can invite only a student who has shown you their work or applied for one of your jobs.');
  }
  const candidate = await prisma.candidate.findUnique({ where: { id: input.candidateId }, select: { userId: true } });
  if (!candidate) throw notFound('Candidate not found.');

  const existing = await prisma.interviewInvite.findFirst({
    where: { companyId, candidateId: input.candidateId, processId: input.processId, status: { in: OPEN } },
    select: { id: true },
  });
  if (existing) throw conflict('This student already has an open invite to this process.');

  const invite = await prisma.$transaction(async (tx) => {
    const inv = await tx.interviewInvite.create({
      data: {
        companyId,
        candidateId: input.candidateId,
        processId: input.processId,
        sentById,
        role: input.role,
        message: input.message || null,
        status: 'PENDING',
        currentRoundOrder: 1,
      },
    });
    // Inviting someone puts the process to use.
    if (process.status === 'DRAFT') await tx.interviewProcess.update({ where: { id: process.id }, data: { status: 'ACTIVE' } });
    const n = process.rounds.length;
    await tx.notification.create({
      data: {
        userId: candidate.userId,
        type: 'interview.invited',
        title: `Interview invite from ${company.name}`,
        body: `${company.name} has invited you to interview for ${input.role}: ${n} round${n === 1 ? '' : 's'}. Open it to see the rounds and answer.`,
        link: '/student/interviews',
        payload: { inviteId: inv.id, companyId, role: input.role },
      },
    });
    return inv;
  });

  return getInviteForCompany(companyId, invite.id);
}

/* ── company: list and read ────────────────────────────────────────────── */

const COMPANY_INCLUDE = {
  candidate: {
    select: {
      phone: true,
      course: true,
      specialisation: true,
      otherCollege: true,
      college: { select: { name: true } },
      listing: { select: { name: true } },
      user: { select: { fullName: true, email: true } },
    },
  },
  process: { include: { rounds: ROUNDS } },
  roundFeedbacks: { orderBy: { roundOrder: 'asc' } },
  videoAnswers: true,
  sentBy: { select: { fullName: true } },
} satisfies Prisma.InterviewInviteInclude;

type CompanyRow = Prisma.InterviewInviteGetPayload<{ include: typeof COMPANY_INCLUDE }>;

export async function listInvitesForCompany(companyId: string) {
  const invites = await prisma.interviewInvite.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    include: COMPANY_INCLUDE,
  });
  const label = await labelsFor(companyId);
  return invites.map((i) => formatCompanyInvite(i, label));
}

export async function getInviteForCompany(companyId: string, id: string) {
  await ownedInvite(companyId, id);
  const inv = await prisma.interviewInvite.findUniqueOrThrow({ where: { id }, include: COMPANY_INCLUDE });
  return formatCompanyInvite(inv, await labelsFor(companyId));
}

/* ── company: record round feedback ───────────────────────────────────── */

export interface FeedbackInput {
  roundOrder: number;
  outcome: 'PASSED' | 'FAILED' | 'SKIPPED';
  score?: number;
  notes?: string;
}

/**
 * The company's verdict on the round the student is in. Passed or skipped
 * moves them to the next round - or, after the last, marks them as wanted.
 * Failed on an eliminating round ends it; on any other, they carry on.
 */
export async function recordRoundFeedback(companyId: string, inviteId: string, input: FeedbackInput) {
  const inv = await ownedInvite(companyId, inviteId);
  if (inv.status === 'PENDING') throw conflict('The student has not accepted this invite yet.');
  if (inv.status !== 'ACCEPTED') throw conflict('This invite is closed.');
  if (input.roundOrder !== inv.currentRoundOrder) throw conflict('Give your verdict on the round they are in.');

  const process = await prisma.interviewProcess.findUniqueOrThrow({
    where: { id: inv.processId },
    include: { rounds: { orderBy: { order: 'asc' } } },
  });
  const round = process.rounds.find((r) => r.order === input.roundOrder);
  if (!round) throw notFound(`Round ${input.roundOrder} does not exist in this process.`);

  const last = input.roundOrder >= process.rounds.length;
  let status: InviteStatus = 'ACCEPTED';
  let next = inv.currentRoundOrder;
  if (input.outcome === 'FAILED' && round.isElimination) status = 'REJECTED';
  else if (last) status = 'OFFERED';
  else next = input.roundOrder + 1;

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
  const student = await prisma.candidate.findUniqueOrThrow({ where: { id: inv.candidateId }, select: { userId: true } });
  const nextRound = process.rounds.find((r) => r.order === next);
  const note =
    status === 'OFFERED'
      ? { title: `You cleared every round at ${company.name}`, body: `${company.name} wants to take things further for ${inv.role}.` }
      : status === 'REJECTED'
        ? { title: `An update from ${company.name}`, body: `${company.name} has decided not to go further for ${inv.role}.` }
        : next !== inv.currentRoundOrder
          ? { title: `On to the next round at ${company.name}`, body: `Next for ${inv.role}: ${nextRound?.name ?? 'the next round'}.` }
          : null;

  await prisma.$transaction([
    prisma.interviewRoundFeedback.upsert({
      where: { inviteId_roundOrder: { inviteId, roundOrder: input.roundOrder } },
      create: {
        inviteId,
        roundOrder: input.roundOrder,
        roundName: round.name,
        outcome: input.outcome,
        score: input.score ?? null,
        notes: input.notes || null,
      },
      update: { outcome: input.outcome, score: input.score ?? null, notes: input.notes || null },
    }),
    prisma.interviewInvite.update({ where: { id: inviteId }, data: { status, currentRoundOrder: next } }),
    ...(note
      ? [
          prisma.notification.create({
            data: {
              userId: student.userId,
              type: `interview.${status === 'ACCEPTED' ? 'next-round' : status.toLowerCase()}`,
              ...note,
              link: '/student/interviews',
              payload: { inviteId, status },
            },
          }),
        ]
      : []),
  ]);

  return getInviteForCompany(companyId, inviteId);
}

/* ── company: withdraw invite ─────────────────────────────────────────── */

export async function withdrawInvite(companyId: string, inviteId: string) {
  const inv = await ownedInvite(companyId, inviteId);
  if (!OPEN.includes(inv.status as InviteStatus)) throw conflict('This invite cannot be withdrawn.');
  await prisma.interviewInvite.update({ where: { id: inviteId }, data: { status: 'WITHDRAWN' } });
}

/* ── student ───────────────────────────────────────────────────────────── */

const STUDENT_INCLUDE = {
  company: { select: { name: true, logoUrl: true, website: true } },
  process: { include: { rounds: ROUNDS } },
  roundFeedbacks: { orderBy: { roundOrder: 'asc' } },
  videoAnswers: true,
} satisfies Prisma.InterviewInviteInclude;

/** Invites made to the student, open ones first. Withdrawn ones are not shown. */
export async function listInvitesForStudent(candidateId: string) {
  const invites = await prisma.interviewInvite.findMany({
    where: { candidateId, status: { not: 'WITHDRAWN' } },
    orderBy: { createdAt: 'desc' },
    include: STUDENT_INCLUDE,
  });
  const simIds = invites.flatMap((i) => i.process.rounds.map((r) => r.simulationId)).filter((x): x is string => Boolean(x));
  const sims = simIds.length
    ? await prisma.workSimulation.findMany({ where: { id: { in: simIds } }, select: { id: true, slug: true, title: true, status: true } })
    : [];
  const labels = new Map<string, Awaited<ReturnType<typeof labelsFor>>>();
  for (const id of new Set(invites.map((i) => i.companyId))) labels.set(id, await labelsFor(id));

  const out = invites.map((i) => formatStudentInvite(i, labels.get(i.companyId)!, sims));
  const rank = (s: string) => (s === 'PENDING' ? 0 : s === 'ACCEPTED' ? 1 : 2);
  return out.sort((a, b) => rank(a.status) - rank(b.status));
}

export async function respondToInvite(candidateId: string, inviteId: string, decision: 'ACCEPTED' | 'DECLINED') {
  const inv = await prisma.interviewInvite.findUnique({
    where: { id: inviteId },
    include: { candidate: { select: { user: { select: { fullName: true } } } } },
  });
  if (!inv || inv.status === 'WITHDRAWN') throw notFound('Invite not found.');
  if (inv.candidateId !== candidateId) throw forbidden('This invite is not yours.');
  if (inv.status !== 'PENDING') throw conflict('This invite has already been answered.');

  await prisma.$transaction([
    prisma.interviewInvite.update({ where: { id: inviteId }, data: { status: decision, respondedAt: new Date() } }),
    prisma.notification.create({
      data: {
        userId: inv.sentById,
        type: `interview.${decision.toLowerCase()}`,
        title: `${inv.candidate.user.fullName} ${decision === 'ACCEPTED' ? 'accepted' : 'declined'} your interview invite: ${inv.role}`,
        link: '/company/interviews',
        payload: { inviteId },
      },
    }),
  ]);
}

/**
 * Saves a recorded answer to one question of the round the student is in.
 * Recording again replaces it, until the company gives its verdict.
 */
export async function saveVideoAnswer(
  candidateId: string,
  inviteId: string,
  questionId: string,
  fileUrl: string,
  seconds: number | null,
) {
  const inv = await prisma.interviewInvite.findUnique({
    where: { id: inviteId },
    include: { process: { include: { rounds: ROUNDS } }, roundFeedbacks: true },
  });
  if (!inv || inv.candidateId !== candidateId || inv.status === 'WITHDRAWN') throw notFound('Invite not found.');
  if (inv.status !== 'ACCEPTED') throw conflict('Accept the invite first.');
  const round = inv.process.rounds.find((r) => r.order === inv.currentRoundOrder);
  if (!round || round.type !== VIDEO_ROUND) throw conflict('The round you are in is not a recorded interview.');
  if (!round.questions.some((q) => q.id === questionId)) throw badRequest('That question is not in this round.');
  if (inv.roundFeedbacks.some((f) => f.roundOrder === round.order)) {
    throw conflict('The company has already looked at this round, so the answers are final.');
  }
  await prisma.interviewVideoAnswer.upsert({
    where: { inviteId_questionId: { inviteId, questionId } },
    create: { inviteId, questionId, fileUrl, seconds },
    update: { fileUrl, seconds },
  });
  return listInvitesForStudent(candidateId);
}

/* ── formatters ────────────────────────────────────────────────────────── */

type Label = Awaited<ReturnType<typeof labelsFor>>;

function feedbacks(rows: CompanyRow['roundFeedbacks'], withNotes: boolean) {
  return rows.map((f) => ({
    roundOrder: f.roundOrder,
    roundName: f.roundName,
    outcome: f.outcome,
    score: withNotes && f.score !== null ? f.score.toNumber() : null,
    notes: withNotes ? f.notes : null,
  }));
}

function formatCompanyInvite(inv: CompanyRow, label: Label) {
  const c = inv.candidate;
  const answers = new Map(inv.videoAnswers.map((a) => [a.questionId, a]));
  return {
    id: inv.id,
    role: inv.role,
    message: inv.message,
    status: inv.status as InviteStatus,
    currentRoundOrder: inv.currentRoundOrder,
    createdAt: inv.createdAt,
    respondedAt: inv.respondedAt,
    candidate: {
      id: inv.candidateId,
      name: c.user.fullName,
      email: c.user.email,
      phone: c.phone,
      college: c.college?.name ?? c.listing?.name ?? c.otherCollege ?? null,
      course: [c.course, c.specialisation].filter(Boolean).join(' · ') || null,
    },
    process: {
      id: inv.processId,
      title: inv.process.title,
      processType: inv.process.processType,
      rounds: inv.process.rounds.map((r) => ({
        order: r.order,
        name: r.name,
        type: r.type,
        typeLabel: label(JobOptionKind.ROUND_TYPE, r.type) ?? r.type,
        isElimination: r.isElimination,
        durationMin: r.durationMin,
        isOnline: r.isOnline,
        meetingLink: r.meetingLink,
        addressLine: r.addressLine,
        questions: r.questions.map((q) => {
          const a = answers.get(q.id);
          return { id: q.id, text: q.text, answer: a ? { fileUrl: a.fileUrl, seconds: a.seconds, at: a.updatedAt } : null };
        }),
      })),
    },
    roundFeedbacks: feedbacks(inv.roundFeedbacks, true),
    sentBy: inv.sentBy?.fullName ?? null,
  };
}

function formatStudentInvite(
  inv: Prisma.InterviewInviteGetPayload<{ include: typeof STUDENT_INCLUDE }>,
  label: Label,
  sims: { id: string; slug: string; title: string; status: WorkSimulationStatus }[],
) {
  // Where and when only matters - and is only shown - once they are in.
  const inside = inv.status === 'ACCEPTED' || inv.status === 'OFFERED' || inv.status === 'REJECTED';
  const answers = new Map(inv.videoAnswers.map((a) => [a.questionId, a]));
  const judged = new Set(inv.roundFeedbacks.map((f) => f.roundOrder));
  return {
    id: inv.id,
    role: inv.role,
    message: inv.message,
    status: inv.status as InviteStatus,
    currentRoundOrder: inv.currentRoundOrder,
    createdAt: inv.createdAt,
    respondedAt: inv.respondedAt,
    company: inv.company,
    process: {
      title: inv.process.title,
      processType: inv.process.processType,
      rounds: inv.process.rounds.map((r) => {
        const sim = r.type === SIMULATION_ROUND ? sims.find((s) => s.id === r.simulationId) : undefined;
        const current = inside && inv.status === 'ACCEPTED' && r.order === inv.currentRoundOrder;
        return {
          order: r.order,
          name: r.name,
          type: r.type,
          typeLabel: label(JobOptionKind.ROUND_TYPE, r.type) ?? r.type,
          isElimination: r.isElimination,
          durationMin: r.durationMin,
          description: r.description,
          isOnline: r.isOnline,
          meetingLink: inside ? r.meetingLink : null,
          addressLine: inside ? r.addressLine : null,
          simulation: sim ? { slug: sim.slug, title: sim.title } : null,
          /** A recorded interview: the questions and the student's own takes, for the round they are in. */
          video:
            r.type === VIDEO_ROUND
              ? {
                  questionTimeSec: r.questionTimeSec ?? 90,
                  prepTimeSec: r.prepTimeSec ?? 30,
                  count: r.questions.length,
                  locked: judged.has(r.order),
                  questions: current
                    ? r.questions.map((q) => {
                        const a = answers.get(q.id);
                        return { id: q.id, text: q.text, hint: q.hint, answer: a ? { fileUrl: a.fileUrl, seconds: a.seconds } : null };
                      })
                    : [],
                }
              : null,
        };
      }),
    },
    // The verdict on each round, not the company's private notes or score.
    roundFeedbacks: feedbacks(inv.roundFeedbacks, false),
  };
}
