import { createHash, randomBytes } from 'node:crypto';
import { ApplicationStatus, InternshipStatus, PlacementType, type Internship } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { sendMail, type MailResult } from '../../lib/mailer.js';

/**
 * NEP internships: the student proposes, the college approves and sets the
 * credits, the student logs each week, the mentor evaluates through a link,
 * and the college closes it and confirms the credits went to ABC.
 *
 * The college is the authority throughout - it is the college's degree the
 * credits count towards - so every decision is the placement cell's, and the
 * student and mentor only ever supply facts for it to decide on.
 */

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

const DAY = 24 * 60 * 60 * 1000;

/** NEP's usual rate: one credit for thirty hours of internship work. */
export const HOURS_PER_CREDIT = 30;

/** Whole weeks an internship spans, counting a part week as a week. */
export function weeksBetween(start: Date, end: Date): number {
  const days = Math.floor((end.getTime() - start.getTime()) / DAY) + 1;
  return Math.max(1, Math.ceil(days / 7));
}

/**
 * The credits an internship would normally earn, to the nearest half credit.
 *
 * A suggestion, not a rule: universities differ, and the college can change
 * it when it approves. Null when there is not enough to go on.
 */
export function suggestCredits(hoursPerWeek: number | null | undefined, start: Date, end: Date): number | null {
  if (!hoursPerWeek || hoursPerWeek <= 0 || end < start) return null;
  const hours = hoursPerWeek * weeksBetween(start, end);
  return Math.max(0.5, Math.round((hours / HOURS_PER_CREDIT) * 2) / 2);
}

/**
 * The hours a student should log. From the credits once the college has set
 * them - that is what the degree counts - otherwise from the plan.
 */
export function requiredHours(i: {
  credits: unknown;
  hoursPerWeek: number | null;
  startDate: Date;
  endDate: Date;
}): number | null {
  const credits = i.credits === null || i.credits === undefined ? null : Number(i.credits);
  if (credits) return credits * HOURS_PER_CREDIT;
  if (i.hoursPerWeek) return i.hoursPerWeek * weeksBetween(i.startDate, i.endDate);
  return null;
}

/**
 * The Monday a date falls in, at midnight UTC. Weekly logs are keyed on it,
 * so a log written on a Thursday and one written on the Sunday of the same
 * week are the same week - and the second is refused.
 */
export function weekStartOf(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - offset * DAY);
}

/** How long a mentor has, after the internship ends, to send an evaluation. */
export const REVIEW_WINDOW_DAYS = 60;

export function reviewExpiresAt(endDate: Date): Date {
  return new Date(endDate.getTime() + REVIEW_WINDOW_DAYS * DAY);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mintToken() {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function mentorLinkFor(token: string): string {
  return `${env.CLIENT_ORIGIN}/internship-review/${token}`;
}

/** Statuses in which the internship is running and work can be logged. */
const RUNNING: InternshipStatus[] = [InternshipStatus.APPROVED, InternshipStatus.ONGOING];

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

const LOG_ORDER = { orderBy: { weekStart: 'asc' as const } };

export function present(i: Internship & { logs: { hours: number; weekStart: Date; summary: string; reviewedAt: Date | null; reviewerNote: string | null; id: string }[] }) {
  const hoursLogged = i.logs.reduce((n, l) => n + l.hours, 0);
  const now = Date.now();
  return {
    id: i.id,
    organisation: i.organisation,
    role: i.role,
    mode: i.mode,
    companyId: i.companyId,
    jobId: i.jobId,
    startDate: i.startDate,
    endDate: i.endDate,
    hoursPerWeek: i.hoursPerWeek,
    credits: i.credits === null ? null : Number(i.credits),
    suggestedCredits: suggestCredits(i.hoursPerWeek, i.startDate, i.endDate),
    requiredHours: requiredHours(i),
    hoursLogged,
    status: i.status,
    decisionNote: i.decisionNote,
    mentorName: i.mentorName,
    mentorEmail: i.mentorEmail,
    evaluation: i.evaluatedAt
      ? { score: i.evaluationScore, note: i.evaluationNote, at: i.evaluatedAt }
      : null,
    /** A live evaluation link exists (the link itself is never stored, so never sent). */
    mentorLinkIssued: Boolean(i.mentorTokenHash),
    certificateUrl: i.certificateUrl,
    abcSubmittedAt: i.abcSubmittedAt,
    hasEnded: i.endDate.getTime() < now,
    logs: i.logs.map((l) => ({
      id: l.id,
      weekStart: l.weekStart,
      hours: l.hours,
      summary: l.summary,
      reviewedAt: l.reviewedAt,
      reviewerNote: l.reviewerNote,
    })),
    createdAt: i.createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Student                                                                     */
/* -------------------------------------------------------------------------- */

export interface ProposalInput {
  organisation: string;
  role: string;
  mode?: string;
  startDate: Date;
  endDate: Date;
  hoursPerWeek?: number;
  mentorName?: string;
  mentorEmail?: string;
}

export async function listMine(candidateId: string) {
  const rows = await prisma.internship.findMany({
    where: { candidateId },
    orderBy: { startDate: 'desc' },
    include: { logs: LOG_ORDER },
  });
  return rows.map(present);
}

async function ownInternship(candidateId: string, id: string) {
  const i = await prisma.internship.findFirst({ where: { id, candidateId } });
  if (!i) throw notFound('That internship is not yours.');
  return i;
}

export async function propose(
  candidateId: string,
  scope: { collegeId: string | null; tenantId: string | null },
  input: ProposalInput & { companyId?: string; jobId?: string },
) {
  if (input.endDate < input.startDate) throw badRequest('The end date is before the start date.', { field: 'endDate' });
  return prisma.internship.create({
    data: {
      candidateId,
      collegeId: scope.collegeId,
      tenantId: scope.tenantId,
      organisation: input.organisation,
      role: input.role,
      mode: input.mode || null,
      startDate: input.startDate,
      endDate: input.endDate,
      hoursPerWeek: input.hoursPerWeek ?? null,
      mentorName: input.mentorName || null,
      mentorEmail: input.mentorEmail || null,
      companyId: input.companyId ?? null,
      jobId: input.jobId ?? null,
    },
  });
}

/** Only while the college has not decided yet - after that, the facts are the college's. */
export async function editProposal(candidateId: string, id: string, input: ProposalInput) {
  const i = await ownInternship(candidateId, id);
  if (i.status !== InternshipStatus.PROPOSED) {
    throw conflict('Your college has already decided on this internship. Ask the placement cell to change it.');
  }
  if (input.endDate < input.startDate) throw badRequest('The end date is before the start date.', { field: 'endDate' });
  return prisma.internship.update({
    where: { id },
    data: {
      organisation: input.organisation,
      role: input.role,
      mode: input.mode || null,
      startDate: input.startDate,
      endDate: input.endDate,
      hoursPerWeek: input.hoursPerWeek ?? null,
      mentorName: input.mentorName || null,
      mentorEmail: input.mentorEmail || null,
    },
  });
}

export async function withdraw(candidateId: string, id: string) {
  const i = await ownInternship(candidateId, id);
  if (i.status === InternshipStatus.COMPLETED) throw conflict('A completed internship cannot be withdrawn.');
  if (i.status === InternshipStatus.WITHDRAWN) return i;
  return prisma.internship.update({
    where: { id },
    data: { status: InternshipStatus.WITHDRAWN, mentorTokenHash: null },
  });
}

export interface LogInput {
  weekOf: Date;
  hours: number;
  summary: string;
}

/**
 * One log per week. The week must overlap the internship's own dates - a log
 * for a week outside them is a mistake, not extra credit.
 */
export async function addLog(candidateId: string, id: string, input: LogInput) {
  const i = await ownInternship(candidateId, id);
  if (!RUNNING.includes(i.status)) {
    throw conflict(
      i.status === InternshipStatus.PROPOSED
        ? 'Your college has not approved this internship yet, so work cannot be logged against it.'
        : 'This internship is closed, so no more weeks can be logged.',
    );
  }
  const weekStart = weekStartOf(input.weekOf);
  const weekEnd = new Date(weekStart.getTime() + 6 * DAY);
  if (weekEnd < weekStartOf(i.startDate) || weekStart > i.endDate) {
    throw badRequest('That week is outside the internship’s dates.', { field: 'weekOf' });
  }
  if (weekStart.getTime() > Date.now()) {
    throw badRequest('That week has not started yet.', { field: 'weekOf' });
  }

  const clash = await prisma.internshipLog.findUnique({
    where: { internshipId_weekStart: { internshipId: id, weekStart } },
  });
  if (clash) throw conflict('You have already logged that week. Edit it instead.', { logId: clash.id });

  return prisma.$transaction(async (tx) => {
    const log = await tx.internshipLog.create({
      data: { internshipId: id, weekStart, hours: input.hours, summary: input.summary },
    });
    // The first week logged is when an approved internship is plainly under way.
    if (i.status === InternshipStatus.APPROVED) {
      await tx.internship.update({ where: { id }, data: { status: InternshipStatus.ONGOING } });
    }
    return log;
  });
}

/** A week can be corrected until the college has read it. */
export async function editLog(candidateId: string, id: string, logId: string, input: Omit<LogInput, 'weekOf'>) {
  await ownInternship(candidateId, id);
  const log = await prisma.internshipLog.findFirst({ where: { id: logId, internshipId: id } });
  if (!log) throw notFound('That week is not on this internship.');
  if (log.reviewedAt) throw conflict('Your college has already reviewed this week, so it can no longer change.');
  return prisma.internshipLog.update({ where: { id: logId }, data: { hours: input.hours, summary: input.summary } });
}

/**
 * Internships the student already won on the platform - an accepted offer on
 * an internship drive or a stipend-paying role - not yet on their record.
 */
export async function importable(candidateId: string) {
  const apps = await prisma.application.findMany({
    where: {
      candidateId,
      status: { in: [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
      OR: [{ placement: { type: PlacementType.INTERNSHIP } }, { job: { stipendPerMonth: { not: null } } }],
    },
    include: {
      job: {
        select: {
          id: true,
          title: true,
          companyId: true,
          joiningFrom: true,
          internshipMonths: true,
          workMode: true,
          company: { select: { name: true } },
        },
      },
    },
  });
  const already = new Set(
    (
      await prisma.internship.findMany({
        where: { candidateId, jobId: { in: apps.map((a) => a.jobId) } },
        select: { jobId: true },
      })
    ).map((r) => r.jobId),
  );
  return apps
    .filter((a) => !already.has(a.jobId))
    .map((a) => ({
      applicationId: a.id,
      jobId: a.job.id,
      organisation: a.job.company.name,
      role: a.job.title,
      startDate: a.job.joiningFrom,
      months: a.job.internshipMonths,
    }));
}

export async function importFromApplication(
  candidateId: string,
  scope: { collegeId: string | null; tenantId: string | null },
  applicationId: string,
) {
  const offer = (await importable(candidateId)).find((o) => o.applicationId === applicationId);
  if (!offer) throw notFound('That offer is not one that can be added as an internship.');
  const app = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { job: { select: { companyId: true, workMode: true } } },
  });

  const start = offer.startDate && offer.startDate.getTime() > 0 ? offer.startDate : new Date();
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + (offer.months ?? 2));
  end.setUTCDate(end.getUTCDate() - 1);

  return propose(candidateId, scope, {
    organisation: offer.organisation,
    role: offer.role,
    mode: app.job.workMode ?? undefined,
    startDate: start,
    endDate: end,
    companyId: app.job.companyId,
    jobId: offer.jobId,
  });
}

/* -------------------------------------------------------------------------- */
/* College                                                                     */
/* -------------------------------------------------------------------------- */

export type Queue = 'to_approve' | 'ongoing' | 'to_evaluate' | 'completed' | 'closed' | 'all';

/** Which queue an internship sits in, decided in one place for the list and the counts. */
export function queueOf(i: Pick<Internship, 'status' | 'endDate'>, now = Date.now()): Exclude<Queue, 'all'> {
  if (i.status === InternshipStatus.PROPOSED) return 'to_approve';
  if (i.status === InternshipStatus.COMPLETED) return 'completed';
  if (i.status === InternshipStatus.REJECTED || i.status === InternshipStatus.WITHDRAWN) return 'closed';
  return i.endDate.getTime() < now ? 'to_evaluate' : 'ongoing';
}

export async function ownCollegeInternship(collegeId: string, id: string) {
  const i = await prisma.internship.findFirst({
    where: { id, collegeId },
    include: {
      logs: LOG_ORDER,
      candidate: {
        select: {
          id: true,
          prn: true,
          course: true,
          specialisation: true,
          user: { select: { fullName: true, email: true } },
        },
      },
    },
  });
  if (!i) throw notFound('That internship does not belong to your college.');
  return i;
}

function presentForCollege(i: Awaited<ReturnType<typeof ownCollegeInternship>>) {
  return {
    ...present(i),
    queue: queueOf(i),
    student: {
      id: i.candidate.id,
      name: i.candidate.user.fullName,
      email: i.candidate.user.email,
      prn: i.candidate.prn,
      course: [i.candidate.course, i.candidate.specialisation].filter(Boolean).join(' ') || null,
    },
  };
}

export async function listForCollege(collegeId: string, queue: Queue) {
  const rows = await prisma.internship.findMany({
    where: { collegeId },
    orderBy: [{ endDate: 'asc' }],
    include: {
      logs: LOG_ORDER,
      candidate: {
        select: {
          id: true,
          prn: true,
          course: true,
          specialisation: true,
          user: { select: { fullName: true, email: true } },
        },
      },
    },
  });
  const all = rows.map(presentForCollege);
  return queue === 'all' ? all : all.filter((r) => r.queue === queue);
}

/** The numbers at the top of the college's page. */
export async function collegeSummary(collegeId: string) {
  const rows = await prisma.internship.findMany({
    where: { collegeId },
    select: { status: true, endDate: true, credits: true, logs: { select: { hours: true, reviewedAt: true } } },
  });
  const counts = { to_approve: 0, ongoing: 0, to_evaluate: 0, completed: 0, closed: 0 };
  let creditsAwarded = 0;
  let hoursLogged = 0;
  let logsToReview = 0;
  for (const r of rows) {
    counts[queueOf(r)]++;
    if (r.status === InternshipStatus.COMPLETED && r.credits !== null) creditsAwarded += Number(r.credits);
    for (const l of r.logs) {
      hoursLogged += l.hours;
      if (!l.reviewedAt) logsToReview++;
    }
  }
  return { ...counts, creditsAwarded, hoursLogged, logsToReview };
}

export async function getForCollege(collegeId: string, id: string) {
  return presentForCollege(await ownCollegeInternship(collegeId, id));
}

/**
 * Issues a fresh evaluation link for the mentor.
 *
 * Only the hash is kept, so a link cannot be shown twice: asking again makes
 * a new one and the old stops working. Mail goes out when the portal can send
 * it; when it cannot, the college copies the link, and nothing waits on it.
 */
async function issueMentorLink(i: { id: string; mentorEmail: string | null; mentorName: string | null; organisation: string; role: string }, studentName: string) {
  const { token, hash } = mintToken();
  await prisma.internship.update({ where: { id: i.id }, data: { mentorTokenHash: hash } });
  const link = mentorLinkFor(token);

  let emailed: MailResult | null = null;
  if (i.mentorEmail) {
    const greeting = i.mentorName ? `Hello ${i.mentorName},` : 'Hello,';
    const lines = [
      greeting,
      '',
      `${studentName} is doing an internship with you as ${i.role} at ${i.organisation}, for academic credit.`,
      'When it is finished, their college asks for a short evaluation - a score out of five and a few words. It takes two minutes and needs no account:',
      '',
      link,
      '',
      'Thank you for mentoring them.',
    ];
    emailed = await sendMail({
      to: i.mentorEmail,
      subject: `Internship evaluation for ${studentName}`,
      text: lines.join('\n'),
      html: lines.map((l) => (l === link ? `<p><a href="${link}">${link}</a></p>` : `<p>${l}</p>`)).join(''),
    });
  }
  return { link, emailed: emailed ? (emailed.sent ? 'sent' : 'failed') : 'no email' } as const;
}

export async function decide(
  collegeId: string,
  id: string,
  input: { approve: boolean; note?: string; credits?: number },
) {
  const i = await ownCollegeInternship(collegeId, id);
  if (i.status !== InternshipStatus.PROPOSED) throw conflict('This internship has already been decided.');

  if (!input.approve) {
    if (!input.note) throw badRequest('Say why - the student is shown this.', { field: 'note' });
    await prisma.internship.update({
      where: { id },
      data: { status: InternshipStatus.REJECTED, decisionNote: input.note },
    });
    return { internship: await getForCollege(collegeId, id), mentor: null };
  }

  const credits = input.credits ?? suggestCredits(i.hoursPerWeek, i.startDate, i.endDate);
  await prisma.internship.update({
    where: { id },
    data: {
      status: i.startDate.getTime() <= Date.now() ? InternshipStatus.ONGOING : InternshipStatus.APPROVED,
      decisionNote: input.note || null,
      credits: credits ?? null,
    },
  });
  const mentor = await issueMentorLink(i, i.candidate.user.fullName);
  return { internship: await getForCollege(collegeId, id), mentor };
}

export async function reissueMentorLink(collegeId: string, id: string) {
  const i = await ownCollegeInternship(collegeId, id);
  if (!RUNNING.includes(i.status)) throw conflict('Only a running internship can be sent to its mentor.');
  if (i.evaluatedAt) throw conflict('The mentor has already sent their evaluation.');
  return issueMentorLink(i, i.candidate.user.fullName);
}

export async function reviewLog(collegeId: string, id: string, logId: string, note?: string) {
  await ownCollegeInternship(collegeId, id);
  const log = await prisma.internshipLog.findFirst({ where: { id: logId, internshipId: id } });
  if (!log) throw notFound('That week is not on this internship.');
  await prisma.internshipLog.update({
    where: { id: logId },
    data: { reviewedAt: new Date(), reviewerNote: note || null },
  });
  return getForCollege(collegeId, id);
}

export async function setCredits(collegeId: string, id: string, credits: number) {
  const i = await ownCollegeInternship(collegeId, id);
  if (i.abcSubmittedAt) throw conflict('The credits have already gone to ABC, so they can no longer change here.');
  await prisma.internship.update({ where: { id }, data: { credits } });
  return getForCollege(collegeId, id);
}

export async function complete(collegeId: string, id: string, input: { certificateUrl?: string }) {
  const i = await ownCollegeInternship(collegeId, id);
  if (!RUNNING.includes(i.status)) throw conflict('Only a running internship can be completed.');
  await prisma.internship.update({
    where: { id },
    data: {
      status: InternshipStatus.COMPLETED,
      certificateUrl: input.certificateUrl || i.certificateUrl,
      // A completed internship takes no more evaluations.
      mentorTokenHash: null,
    },
  });
  return getForCollege(collegeId, id);
}

/**
 * A record that the college put the credits into the student's ABC account.
 * We do not talk to the ABC portal: this is the college saying it did, and
 * when.
 */
export async function markAbc(collegeId: string, id: string, at: Date) {
  const i = await ownCollegeInternship(collegeId, id);
  if (i.status !== InternshipStatus.COMPLETED) throw conflict('Complete the internship before recording its credits.');
  if (i.credits === null) throw conflict('Set the credits before recording them as sent.');
  await prisma.internship.update({ where: { id }, data: { abcSubmittedAt: at } });
  return getForCollege(collegeId, id);
}

/* -------------------------------------------------------------------------- */
/* The mentor's link                                                           */
/* -------------------------------------------------------------------------- */

/** A token that is unknown, used or past its window all look the same from outside: gone. */
async function internshipForToken(token: string) {
  const i = await prisma.internship.findUnique({
    where: { mentorTokenHash: hashToken(token) },
    include: {
      logs: { select: { hours: true } },
      candidate: { select: { user: { select: { fullName: true } }, college: { select: { name: true } } } },
    },
  });
  if (!i) throw notFound('This evaluation link is not valid. It may have been used already, or replaced by a newer one.');
  if (reviewExpiresAt(i.endDate).getTime() < Date.now()) {
    throw notFound('This evaluation link has expired. Ask the student’s college for a new one.');
  }
  return i;
}

export async function reviewPreview(token: string) {
  const i = await internshipForToken(token);
  return {
    student: i.candidate.user.fullName,
    college: i.candidate.college?.name ?? null,
    organisation: i.organisation,
    role: i.role,
    startDate: i.startDate,
    endDate: i.endDate,
    mentorName: i.mentorName,
    weeksLogged: i.logs.length,
    hoursLogged: i.logs.reduce((n, l) => n + l.hours, 0),
  };
}

/** One evaluation per link: saving it spends the link. */
export async function submitReview(token: string, input: { score: number; note: string }) {
  const i = await internshipForToken(token);
  await prisma.internship.update({
    where: { id: i.id },
    data: {
      evaluationScore: input.score,
      evaluationNote: input.note,
      evaluatedAt: new Date(),
      mentorTokenHash: null,
    },
  });
}
