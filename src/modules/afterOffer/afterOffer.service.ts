import { ApplicationStatus, JoiningStatus, Prisma, type JoiningTracker } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/**
 * Trust after the offer: what happens between "yes" and the first day, and
 * how both sides behaved along the way.
 *
 * Offers revoked by email, joining dates that slide for months - a student
 * who has accepted has stopped looking, so a broken promise here costs more
 * than anywhere else in the process. The tracker writes every move into one
 * history everyone involved can read, and the company page turns it into an
 * offer-honour rate the company cannot edit.
 *
 * Ratings go the other way and only ever as totals: a student rates how the
 * process was run, never a person, and no average appears until enough
 * students have rated that one student cannot be picked out.
 */

const DAY = 24 * 60 * 60 * 1000;

/** An offer the student has said yes to. */
export const TAKEN: ApplicationStatus[] = [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED];

/** Nothing more will happen on these, so the student can look back and rate the process. */
export const CLOSED: ApplicationStatus[] = [
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.HIRED,
  ApplicationStatus.DECLINED,
];

/** The fewest ratings before an average is shown to anybody. */
export const MIN_RATINGS = 5;

export type Actor = 'STUDENT' | 'COMPANY' | 'COLLEGE';

export interface HistoryEntry {
  at: string;
  by: Actor;
  status: JoiningStatus;
  /** The expected joining date after this change, as YYYY-MM-DD. */
  date?: string | null;
  note?: string | null;
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function historyOf(t: Pick<JoiningTracker, 'history'>): HistoryEntry[] {
  return Array.isArray(t.history) ? (t.history as unknown as HistoryEntry[]) : [];
}

/** The application an offer lives on, with what the tracker needs to know about it. */
const APP_SELECT = {
  id: true,
  status: true,
  candidateId: true,
  job: {
    select: {
      id: true,
      title: true,
      joiningFrom: true,
      companyId: true,
      company: { select: { id: true, name: true } },
    },
  },
  placement: { select: { collegeId: true } },
  candidate: { select: { userId: true, user: { select: { fullName: true } } } },
} as const;

type OfferApp = Prisma.ApplicationGetPayload<{ select: typeof APP_SELECT }>;

/**
 * The tracker for an accepted offer, made the first time anybody looks.
 *
 * Created lazily rather than from the state machine, so nothing in the hiring
 * pipeline had to change: an offer accepted before this module existed gets a
 * tracker the first time the student, company or college opens it. The job's
 * own "joining from" date is the starting expectation.
 */
export async function ensureTracker(app: OfferApp): Promise<JoiningTracker> {
  const existing = await prisma.joiningTracker.findUnique({ where: { applicationId: app.id } });
  if (existing) return existing;
  try {
    return await prisma.joiningTracker.create({
      data: {
        applicationId: app.id,
        candidateId: app.candidateId,
        companyId: app.job.companyId,
        collegeId: app.placement.collegeId,
        expectedJoiningDate: app.job.joiningFrom,
        history: [],
      },
    });
  } catch (err) {
    // Two first readers at once: the other one won, which is fine.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return prisma.joiningTracker.findUniqueOrThrow({ where: { applicationId: app.id } });
    }
    throw err;
  }
}

async function record(
  tracker: JoiningTracker,
  by: Actor,
  change: { status?: JoiningStatus; date?: Date | null; reason?: string | null; note?: string | null },
): Promise<JoiningTracker> {
  const status = change.status ?? tracker.status;
  const date = change.date === undefined ? tracker.expectedJoiningDate : change.date;
  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    by,
    status,
    date: ymd(date),
    note: change.note ?? change.reason ?? null,
  };
  return prisma.joiningTracker.update({
    where: { id: tracker.id },
    data: {
      status,
      expectedJoiningDate: date,
      ...(change.reason !== undefined ? { reason: change.reason } : {}),
      history: [...historyOf(tracker), entry] as unknown as Prisma.InputJsonValue,
    },
  });
}

async function notify(userId: string, title: string, body: string, link: string) {
  await prisma.notification.create({ data: { userId, type: 'joining.update', title, body, link } });
}

/** Days until the expected date (negative once it has passed), or null with no date. */
export function daysToJoining(date: Date | null, now = new Date()): number | null {
  if (!date) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((day - start) / DAY);
}

/** Past the expected date and still nobody has said the student joined. */
export function isOverdue(t: Pick<JoiningTracker, 'expectedJoiningDate' | 'status'>, now = new Date()): boolean {
  const d = daysToJoining(t.expectedJoiningDate, now);
  return d !== null && d < 0 && t.status !== JoiningStatus.JOINED && t.status !== JoiningStatus.REVOKED;
}

export function trackerView(t: JoiningTracker, now = new Date()) {
  return {
    status: t.status,
    expectedJoiningDate: ymd(t.expectedJoiningDate),
    daysToJoining: daysToJoining(t.expectedJoiningDate, now),
    overdue: isOverdue(t, now),
    reason: t.reason,
    history: historyOf(t),
    updatedAt: t.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* The company's side                                                          */
/* -------------------------------------------------------------------------- */

async function companyOffer(companyId: string, applicationId: string): Promise<OfferApp> {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, job: { companyId } },
    select: APP_SELECT,
  });
  // Another company's applicant answers exactly like one that does not exist.
  if (!app) throw notFound('No such application.');
  return app;
}

export async function companyView(companyId: string, applicationId: string) {
  const app = await companyOffer(companyId, applicationId);
  const reliability = await prisma.reliabilityMark.findUnique({ where: { applicationId } });
  const tracker = TAKEN.includes(app.status) ? await ensureTracker(app) : null;
  return {
    offerTaken: TAKEN.includes(app.status),
    tracker: tracker ? trackerView(tracker) : null,
    reliability: reliability ? { kind: reliability.kind, note: reliability.note, at: reliability.createdAt } : null,
  };
}

export type CompanyJoiningAction =
  | { action: 'SET_DATE'; date: Date; reason?: string }
  | { action: 'JOINED' }
  | { action: 'REVOKE'; reason: string };

/**
 * The company moves the joining date, confirms the student joined, or takes
 * the offer back. A later date needs a reason, and so does a revocation -
 * the student is told both, in the company's own words.
 */
export async function companyJoining(companyId: string, applicationId: string, input: CompanyJoiningAction) {
  const app = await companyOffer(companyId, applicationId);
  if (!TAKEN.includes(app.status)) throw conflict('The student has not accepted this offer.');
  const tracker = await ensureTracker(app);
  if (tracker.status === JoiningStatus.REVOKED) throw conflict('This offer has already been withdrawn.');
  if (tracker.status === JoiningStatus.JOINED && input.action !== 'JOINED') {
    throw conflict('This student has already joined.');
  }

  const company = app.job.company.name;
  const link = '/student/applications';
  let updated: JoiningTracker;

  if (input.action === 'SET_DATE') {
    const later = tracker.expectedJoiningDate && input.date.getTime() > tracker.expectedJoiningDate.getTime();
    if (later && !input.reason?.trim()) {
      throw badRequest('Say why the joining date is moving later. The student is shown this.', { field: 'reason' });
    }
    updated = await record(tracker, 'COMPANY', {
      status: later ? JoiningStatus.DELAYED : JoiningStatus.AWAITING,
      date: input.date,
      reason: later ? input.reason!.trim() : tracker.reason,
      note: input.reason?.trim() || null,
    });
    await notify(
      app.candidate.userId,
      later ? `${company} moved your joining date` : `${company} set your joining date`,
      `Expected joining: ${ymd(input.date)}.${later ? ` Reason given: ${input.reason!.trim()}` : ' Please confirm you have seen it.'}`,
      link,
    );
  } else if (input.action === 'JOINED') {
    updated = await record(tracker, 'COMPANY', { status: JoiningStatus.JOINED, note: 'Marked as joined.' });
    await notify(app.candidate.userId, `Welcome aboard at ${company}`, 'Your joining has been recorded.', link);
  } else {
    if (!input.reason?.trim()) throw badRequest('Say why the offer is being withdrawn. The student and college see this.', { field: 'reason' });
    updated = await record(tracker, 'COMPANY', { status: JoiningStatus.REVOKED, reason: input.reason.trim() });
    await notify(
      app.candidate.userId,
      `${company} withdrew your offer`,
      `Reason given: ${input.reason.trim()} Your placement cell has been told and can help you with what comes next.`,
      link,
    );
  }
  return trackerView(updated);
}

export async function markReliability(
  companyId: string,
  applicationId: string,
  input: { kind: 'ON_TIME' | 'NO_SHOW' | 'RENEGED'; note?: string },
  userId: string,
) {
  const app = await companyOffer(companyId, applicationId);
  const mark = await prisma.reliabilityMark.upsert({
    where: { applicationId },
    update: { kind: input.kind, note: input.note?.trim() || null, createdById: userId },
    create: {
      applicationId,
      candidateId: app.candidateId,
      companyId,
      kind: input.kind,
      note: input.note?.trim() || null,
      createdById: userId,
    },
  });
  return { kind: mark.kind, note: mark.note, at: mark.createdAt };
}

/* -------------------------------------------------------------------------- */
/* The student's side                                                          */
/* -------------------------------------------------------------------------- */

async function studentApp(candidateId: string, applicationId: string): Promise<OfferApp> {
  const app = await prisma.application.findFirst({ where: { id: applicationId, candidateId }, select: APP_SELECT });
  if (!app) throw notFound('No such application.');
  return app;
}

export async function studentOffers(candidateId: string) {
  const apps = await prisma.application.findMany({
    where: { candidateId, status: { in: TAKEN } },
    select: APP_SELECT,
    orderBy: { updatedAt: 'desc' },
  });
  const out = [];
  for (const app of apps) {
    const tracker = await ensureTracker(app);
    out.push({
      applicationId: app.id,
      job: { id: app.job.id, title: app.job.title },
      company: app.job.company,
      tracker: trackerView(tracker),
    });
  }
  return out;
}

export type StudentJoiningAction =
  | { action: 'CONFIRM' }
  | { action: 'NO_NEWS'; note?: string }
  | { action: 'REPORT_DELAY'; note: string; date?: Date }
  | { action: 'REPORT_REVOKED'; note: string };

/**
 * The student's half of the story. Confirming a date is a yes; "no news" and
 * reports of a delay or withdrawal they heard about elsewhere go on the record
 * and to their placement cell, because that is often the only way a college
 * learns an offer was quietly taken back.
 */
export async function studentJoining(candidateId: string, applicationId: string, input: StudentJoiningAction) {
  const app = await studentApp(candidateId, applicationId);
  if (!TAKEN.includes(app.status)) throw conflict('Only an accepted offer has a joining date.');
  const tracker = await ensureTracker(app);
  if (tracker.status === JoiningStatus.REVOKED || tracker.status === JoiningStatus.JOINED) {
    throw conflict('This offer is already closed.');
  }

  let updated: JoiningTracker;
  switch (input.action) {
    case 'CONFIRM':
      if (!tracker.expectedJoiningDate) throw conflict('There is no joining date to confirm yet.');
      updated = await record(tracker, 'STUDENT', { status: JoiningStatus.CONFIRMED, note: 'Confirmed the joining date.' });
      break;
    case 'NO_NEWS':
      updated = await record(tracker, 'STUDENT', {
        note: input.note?.trim() || 'Has not heard anything from the company about joining.',
      });
      break;
    case 'REPORT_DELAY':
      if (!input.note?.trim()) throw badRequest('Say what you were told.', { field: 'note' });
      updated = await record(tracker, 'STUDENT', {
        status: JoiningStatus.DELAYED,
        date: input.date ?? tracker.expectedJoiningDate,
        reason: `Reported by the student: ${input.note.trim()}`,
        note: input.note.trim(),
      });
      break;
    case 'REPORT_REVOKED':
      if (!input.note?.trim()) throw badRequest('Say what you were told.', { field: 'note' });
      updated = await record(tracker, 'STUDENT', {
        status: JoiningStatus.REVOKED,
        reason: `Reported by the student: ${input.note.trim()}`,
        note: input.note.trim(),
      });
      break;
  }
  return trackerView(updated);
}

/** Closed applications the student can still rate, and the ones already rated. */
export async function studentRatings(candidateId: string) {
  const apps = await prisma.application.findMany({
    where: { candidateId, status: { in: CLOSED } },
    select: { id: true, status: true, job: { select: { title: true, company: { select: { id: true, name: true } } } } },
    orderBy: { updatedAt: 'desc' },
  });
  const rated = await prisma.processRating.findMany({
    where: { candidateId },
    select: { applicationId: true, communication: true, clarity: true, fairness: true, createdAt: true },
  });
  const byApp = new Map(rated.map((r) => [r.applicationId, r]));
  return apps.map((a) => ({
    applicationId: a.id,
    status: a.status,
    job: { title: a.job.title },
    company: a.job.company,
    rating: byApp.get(a.id) ?? null,
  }));
}

export async function rateProcess(
  candidateId: string,
  applicationId: string,
  input: { communication: number; clarity: number; fairness: number; note?: string },
) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, candidateId },
    select: { id: true, status: true, job: { select: { companyId: true } } },
  });
  if (!app) throw notFound('No such application.');
  if (!CLOSED.includes(app.status)) {
    throw conflict('You can rate how this was run once the application is closed.');
  }
  if (await prisma.processRating.findUnique({ where: { applicationId }, select: { id: true } })) {
    throw conflict('You have already rated this one.');
  }
  try {
    const r = await prisma.processRating.create({
      data: {
        applicationId,
        candidateId,
        companyId: app.job.companyId,
        communication: input.communication,
        clarity: input.clarity,
        fairness: input.fairness,
        note: input.note?.trim() || null,
      },
    });
    return { applicationId: r.applicationId, communication: r.communication, clarity: r.clarity, fairness: r.fairness, createdAt: r.createdAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('You have already rated this one.');
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A company's process rating as totals only. Below MIN_RATINGS nothing but the
 * count comes back - a small average points at the handful of students who gave it.
 */
export async function ratingSummary(companyIds: string[]) {
  if (companyIds.length === 0) return new Map<string, RatingSummary>();
  const groups = await prisma.processRating.groupBy({
    by: ['companyId'],
    where: { companyId: { in: companyIds } },
    _count: { _all: true },
    _avg: { communication: true, clarity: true, fairness: true },
  });
  const out = new Map<string, RatingSummary>();
  for (const id of companyIds) out.set(id, { count: 0, enough: false, communication: null, clarity: null, fairness: null, overall: null });
  for (const g of groups) {
    const count = g._count._all;
    const enough = count >= MIN_RATINGS;
    const c = g._avg.communication ?? 0;
    const cl = g._avg.clarity ?? 0;
    const f = g._avg.fairness ?? 0;
    out.set(g.companyId, {
      count,
      enough,
      communication: enough ? round1(c) : null,
      clarity: enough ? round1(cl) : null,
      fairness: enough ? round1(f) : null,
      overall: enough ? round1((c + cl + f) / 3) : null,
    });
  }
  return out;
}

export interface RatingSummary {
  count: number;
  enough: boolean;
  communication: number | null;
  clarity: number | null;
  fairness: number | null;
  overall: number | null;
}

/**
 * Offers kept against offers broken, among offers whose outcome is known:
 * the student joined, or the offer was withdrawn. Offers still in the future
 * are not counted either way.
 */
export async function honourSummary(companyIds: string[], min = MIN_RATINGS) {
  const out = new Map<string, { joined: number; revoked: number; decided: number; enough: boolean; rate: number | null }>();
  for (const id of companyIds) out.set(id, { joined: 0, revoked: 0, decided: 0, enough: false, rate: null });
  if (companyIds.length === 0) return out;
  const groups = await prisma.joiningTracker.groupBy({
    by: ['companyId', 'status'],
    where: { companyId: { in: companyIds }, status: { in: [JoiningStatus.JOINED, JoiningStatus.REVOKED] } },
    _count: { _all: true },
  });
  for (const g of groups) {
    const row = out.get(g.companyId)!;
    if (g.status === JoiningStatus.JOINED) row.joined += g._count._all;
    else row.revoked += g._count._all;
  }
  for (const row of out.values()) {
    row.decided = row.joined + row.revoked;
    row.enough = row.decided >= min;
    row.rate = row.enough ? Math.round((row.joined / row.decided) * 100) : null;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The college's side                                                          */
/* -------------------------------------------------------------------------- */

export async function collegeOffers(collegeId: string, filter: { companyId?: string } = {}) {
  const apps = await prisma.application.findMany({
    where: {
      status: { in: TAKEN },
      placement: { collegeId },
      ...(filter.companyId ? { job: { companyId: filter.companyId } } : {}),
    },
    select: APP_SELECT,
    orderBy: { updatedAt: 'desc' },
  });

  const rows = [];
  for (const app of apps) {
    const t = await ensureTracker(app);
    rows.push({
      applicationId: app.id,
      student: app.candidate.user.fullName,
      job: { id: app.job.id, title: app.job.title },
      company: app.job.company,
      tracker: trackerView(t),
    });
  }

  const summary = {
    total: rows.length,
    awaiting: rows.filter((r) => r.tracker.status === JoiningStatus.AWAITING).length,
    confirmed: rows.filter((r) => r.tracker.status === JoiningStatus.CONFIRMED).length,
    delayed: rows.filter((r) => r.tracker.status === JoiningStatus.DELAYED).length,
    joined: rows.filter((r) => r.tracker.status === JoiningStatus.JOINED).length,
    revoked: rows.filter((r) => r.tracker.status === JoiningStatus.REVOKED).length,
    overdue: rows.filter((r) => r.tracker.overdue).length,
  };

  const companies = [...new Map(rows.map((r) => [r.company.id, r.company])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { offers: rows, summary, companies };
}

export async function collegeNote(collegeId: string, applicationId: string, note: string) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, placement: { collegeId }, status: { in: TAKEN } },
    select: APP_SELECT,
  });
  if (!app) throw notFound('No such offer at your college.');
  const tracker = await ensureTracker(app);
  return trackerView(await record(tracker, 'COLLEGE', { note: note.trim() }));
}

/**
 * Every company that has made offers to this college's students, with the
 * totals a placement officer weighs before inviting them back.
 */
export async function collegeCompanies(collegeId: string, withRatings: boolean) {
  const apps = await prisma.application.findMany({
    where: {
      placement: { collegeId },
      status: { in: [ApplicationStatus.OFFERED, ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED, ApplicationStatus.DECLINED] },
    },
    select: { status: true, job: { select: { company: { select: { id: true, name: true } } } } },
  });
  const byCompany = new Map<string, { id: string; name: string; offers: number; accepted: number }>();
  for (const a of apps) {
    const c = a.job.company;
    const row = byCompany.get(c.id) ?? { id: c.id, name: c.name, offers: 0, accepted: 0 };
    row.offers++;
    if (TAKEN.includes(a.status)) row.accepted++;
    byCompany.set(c.id, row);
  }
  const ids = [...byCompany.keys()];
  const [honour, ratings] = await Promise.all([honourSummary(ids), withRatings ? ratingSummary(ids) : Promise.resolve(null)]);
  return [...byCompany.values()]
    .map((c) => ({ ...c, honour: honour.get(c.id)!, rating: ratings ? ratings.get(c.id)! : null }))
    .sort((a, b) => b.offers - a.offers);
}

/** Reliability marks this college's students have received, so the college can counsel them. */
export async function collegeReliability(collegeId: string) {
  // Narrowed to the college's own students first; the application join below
  // then keeps only marks from this college's drives.
  const students = await prisma.candidate.findMany({ where: { collegeId }, select: { id: true } });
  const marks = await prisma.reliabilityMark.findMany({
    where: { kind: { in: ['NO_SHOW', 'RENEGED'] }, candidateId: { in: students.map((s) => s.id) } },
    orderBy: { createdAt: 'desc' },
  });
  if (marks.length === 0) return [];
  const apps = await prisma.application.findMany({
    where: { id: { in: marks.map((m) => m.applicationId) }, placement: { collegeId } },
    select: { id: true, candidate: { select: { user: { select: { fullName: true } } } }, job: { select: { title: true, company: { select: { name: true } } } } },
  });
  const byId = new Map(apps.map((a) => [a.id, a]));
  return marks
    .filter((m) => byId.has(m.applicationId))
    .map((m) => {
      const a = byId.get(m.applicationId)!;
      return {
        applicationId: m.applicationId,
        student: a.candidate.user.fullName,
        company: a.job.company.name,
        job: a.job.title,
        kind: m.kind,
        note: m.note,
        at: m.createdAt,
      };
    });
}
