import { ApplicationStatus as S, RoundOutcome, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The live application tracker (trust.tracker).
 *
 * Two promises, made to two people. To the student: you can always see where
 * an application stands and how long it has been sitting there. To the
 * college: you can see which companies are leaving your students waiting.
 * Both come from the same facts - the status history and the round results -
 * so neither can drift from what actually happened.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Statuses where the next move is the company's. Waitlisted is a decision, not a wait. */
const COMPANYS_MOVE: readonly S[] = [S.APPLIED, S.UNDER_REVIEW, S.IN_ROUND];

/** Statuses that mean every round was cleared, whatever the results table says. */
const CLEARED: readonly S[] = [S.OFFERED, S.ACCEPTED, S.DECLINED, S.HIRED];

export type RoundState = 'passed' | 'current' | 'upcoming' | 'failed' | 'skipped';

export interface RoundRow {
  id: string;
  order: number;
  name: string;
}

export interface ResultRow {
  roundId: string;
  outcome: RoundOutcome;
  evaluatedAt: Date | null;
}

/**
 * Each round's state, in order.
 *
 * A recorded outcome always wins. Without one, the round's position against
 * the current round decides - a round before the current one was cleared even
 * if nobody wrote a result, which is how a recruiter who skips the paperwork
 * still leaves an honest picture. An application rejected mid-round failed the
 * round it was in.
 */
export function roundStates(
  rounds: RoundRow[],
  results: ResultRow[],
  currentRoundId: string | null,
  status: S,
): { id: string; order: number; name: string; state: RoundState }[] {
  const byRound = new Map(results.map((r) => [r.roundId, r.outcome]));
  const current = rounds.find((r) => r.id === currentRoundId);

  return [...rounds]
    .sort((a, b) => a.order - b.order)
    .map((r) => {
      const outcome = byRound.get(r.id);
      let state: RoundState;
      if (outcome === RoundOutcome.PASSED) state = 'passed';
      else if (outcome === RoundOutcome.FAILED) state = 'failed';
      else if (outcome === RoundOutcome.SKIPPED) state = 'skipped';
      else if (CLEARED.includes(status)) state = 'passed';
      else if (current && r.id === current.id) state = status === S.REJECTED ? 'failed' : 'current';
      else if (current && r.order < current.order) state = 'passed';
      else state = 'upcoming';
      return { id: r.id, order: r.order, name: r.name, state };
    });
}

export interface EventRow {
  fromStatus: S | null;
  toStatus: S;
  note: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface TimelineEntry {
  at: Date;
  kind: 'applied' | 'status' | 'round';
  text: string;
  /** For the company's own view: the note its team wrote. Never sent to the student. */
  note?: string;
}

/**
 * The history as sentences.
 *
 * The student sees what happened, never what a recruiter wrote about it: a
 * rejection note is the company's working note, not a message. The notes the
 * system itself writes ("Passed Aptitude, moved to Technical interview") are
 * facts, and those the student does see.
 */
export function timeline(
  input: {
    appliedAt: Date;
    companyName: string;
    events: EventRow[];
    results: (ResultRow & { roundName: string })[];
  },
  audience: 'student' | 'company',
): TimelineEntry[] {
  const out: TimelineEntry[] = [{ at: input.appliedAt, kind: 'applied', text: 'Applied' }];

  for (const e of input.events) {
    if (e.toStatus === S.APPLIED) continue; // the "Applied" line above says it
    const text = sentence(e, input.companyName, audience);
    const entry: TimelineEntry = { at: e.createdAt, kind: 'status', text };
    if (audience === 'company' && e.note && !systemNote(e)) entry.note = e.note;
    out.push(entry);
  }

  // A failed round is worth its own line: "Not taken forward" says the end,
  // this says where. Passed rounds are already in the moves between rounds.
  for (const r of input.results) {
    if (r.outcome === RoundOutcome.FAILED && r.evaluatedAt) {
      out.push({ at: r.evaluatedAt, kind: 'round', text: `Did not clear ${r.roundName}` });
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Notes the state machine's callers write themselves, as opposed to a person's. */
function systemNote(e: EventRow): boolean {
  return (
    (e.toStatus === S.IN_ROUND && Boolean(e.note)) ||
    (e.toStatus === S.OFFERED && e.note === 'Cleared the final round')
  );
}

function sentence(e: EventRow, company: string, audience: 'student' | 'company'): string {
  const you = audience === 'student';
  switch (e.toStatus) {
    case S.UNDER_REVIEW:
      return you ? `${company} opened your application` : 'Opened for review';
    case S.IN_ROUND:
      return e.note ?? 'Moved to the next round';
    case S.WAITLISTED:
      return 'Waitlisted';
    case S.OFFERED:
      return e.note === 'Cleared the final round' ? 'Cleared the final round - offer made' : 'Offer made';
    case S.ACCEPTED:
      return you ? 'You accepted the offer' : 'Offer accepted';
    case S.DECLINED:
      return you ? 'You declined the offer' : 'Offer declined';
    case S.HIRED:
      return 'Hired';
    case S.REJECTED:
      return 'Not taken forward';
    case S.WITHDRAWN:
      if (e.reason === 'auto_placed') {
        return you ? 'Closed - you accepted another offer in this drive' : 'Closed - accepted an offer elsewhere in the drive';
      }
      return you ? 'You withdrew' : 'Withdrawn by the student';
    default:
      return e.toStatus;
  }
}

/**
 * Whether the company owes the student a move, and for how long.
 *
 * Measured from the last thing that happened - a status change or a round
 * result - so a recruiter who is actively working a candidate through rounds
 * is not flagged, and one who has gone quiet is, however early it went quiet.
 */
export function waiting(input: {
  status: S;
  currentRoundId: string | null;
  results: ResultRow[];
  lastActivityAt: Date;
  responseDays: number;
  now?: Date;
}): { daysWaiting: number; overdue: boolean; responseDays: number } | null {
  if (!COMPANYS_MOVE.includes(input.status)) return null;
  if (input.status === S.IN_ROUND) {
    const res = input.results.find((r) => r.roundId === input.currentRoundId);
    // A result recorded for the current round means the ball moved; the
    // status change that follows it is the company's paperwork.
    if (res && res.outcome !== RoundOutcome.PENDING) return null;
  }
  const now = (input.now ?? new Date()).getTime();
  const daysWaiting = Math.max(0, Math.floor((now - input.lastActivityAt.getTime()) / DAY));
  return { daysWaiting, overdue: daysWaiting > input.responseDays, responseDays: input.responseDays };
}

/* -------------------------------------------------------------------------- */
/* Reading applications                                                        */
/* -------------------------------------------------------------------------- */

export const TRACKED_INCLUDE = {
  job: {
    select: {
      id: true,
      title: true,
      companyId: true,
      company: { select: { id: true, name: true } },
      rounds: { orderBy: { order: 'asc' }, select: { id: true, order: true, name: true } },
    },
  },
  // The drive's institution sets the deadline. A company answers to each
  // college's rule, because a company spans every institution.
  placement: {
    select: {
      id: true,
      name: true,
      collegeId: true,
      college: { select: { tenant: { select: { responseDays: true } } } },
    },
  },
  results: {
    select: {
      roundId: true,
      outcome: true,
      evaluatedAt: true,
      createdAt: true,
      round: { select: { name: true } },
    },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    select: { fromStatus: true, toStatus: true, note: true, reason: true, createdAt: true },
  },
} satisfies Prisma.ApplicationInclude;

export type TrackedApplication = Prisma.ApplicationGetPayload<{ include: typeof TRACKED_INCLUDE }>;

function lastActivity(a: TrackedApplication): Date {
  let last = a.appliedAt;
  for (const e of a.events) if (e.createdAt > last) last = e.createdAt;
  for (const r of a.results) {
    const t = r.evaluatedAt ?? r.createdAt;
    if (t > last) last = t;
  }
  return last;
}

/** One application, as the tracker shows it to one audience. */
export function track(a: TrackedApplication, audience: 'student' | 'company', now?: Date) {
  const results = a.results.map((r) => ({ roundId: r.roundId, outcome: r.outcome, evaluatedAt: r.evaluatedAt }));
  const last = lastActivity(a);
  return {
    id: a.id,
    status: a.status,
    appliedAt: a.appliedAt,
    lastActivityAt: last,
    job: { id: a.job.id, title: a.job.title },
    company: { id: a.job.company.id, name: a.job.company.name },
    placement: { id: a.placement.id, name: a.placement.name },
    rounds: roundStates(a.job.rounds, results, a.currentRoundId, a.status),
    timeline: timeline(
      {
        appliedAt: a.appliedAt,
        companyName: a.job.company.name,
        events: a.events,
        results: a.results.map((r) => ({ ...r, roundName: r.round.name })),
      },
      audience,
    ),
    waiting: waiting({
      status: a.status,
      currentRoundId: a.currentRoundId,
      results,
      lastActivityAt: last,
      responseDays: a.placement.college.tenant.responseDays,
      now,
    }),
  };
}

const WAITING_WHERE: Prisma.ApplicationWhereInput = { status: { in: [...COMPANYS_MOVE] } };

/** The student's own applications, newest first. */
export async function studentApplications(candidateId: string) {
  const apps = await prisma.application.findMany({
    where: { candidateId },
    orderBy: { appliedAt: 'desc' },
    include: TRACKED_INCLUDE,
  });
  return apps.map((a) => track(a, 'student'));
}

/**
 * Overdue applications on a company's roles, grouped by role.
 *
 * Only the company's own jobs, and only applications waiting on it - the
 * question this answers is "who have we left hanging?".
 */
export async function companyOverdue(companyId: string, now?: Date) {
  const apps = await prisma.application.findMany({
    where: { ...WAITING_WHERE, job: { companyId } },
    include: TRACKED_INCLUDE,
  });

  const jobs = new Map<string, { jobId: string; title: string; overdue: number; applicationIds: string[]; oldestDays: number }>();
  for (const a of apps) {
    const t = track(a, 'company', now);
    if (!t.waiting?.overdue) continue;
    const g = jobs.get(a.job.id) ?? { jobId: a.job.id, title: a.job.title, overdue: 0, applicationIds: [], oldestDays: 0 };
    g.overdue++;
    g.applicationIds.push(a.id);
    g.oldestDays = Math.max(g.oldestDays, t.waiting.daysWaiting);
    jobs.set(a.job.id, g);
  }
  const list = [...jobs.values()].sort((a, b) => b.overdue - a.overdue);
  return { total: list.reduce((n, j) => n + j.overdue, 0), jobs: list };
}

/**
 * Companies leaving this college's students waiting, most-overdue first -
 * so a placement officer knows whom to chase, with the numbers to chase with.
 */
export async function collegeOverdue(collegeId: string, now?: Date) {
  const apps = await prisma.application.findMany({
    where: { ...WAITING_WHERE, placement: { collegeId } },
    include: TRACKED_INCLUDE,
  });

  const companies = new Map<
    string,
    { companyId: string; name: string; overdue: number; oldestDays: number; jobs: Map<string, { jobId: string; title: string; overdue: number }> }
  >();
  for (const a of apps) {
    const t = track(a, 'company', now);
    if (!t.waiting?.overdue) continue;
    const c =
      companies.get(a.job.company.id) ??
      { companyId: a.job.company.id, name: a.job.company.name, overdue: 0, oldestDays: 0, jobs: new Map() };
    c.overdue++;
    c.oldestDays = Math.max(c.oldestDays, t.waiting.daysWaiting);
    const j = c.jobs.get(a.job.id) ?? { jobId: a.job.id, title: a.job.title, overdue: 0 };
    j.overdue++;
    c.jobs.set(a.job.id, j);
    companies.set(a.job.company.id, c);
  }

  const list = [...companies.values()]
    .map((c) => ({ ...c, jobs: [...c.jobs.values()] }))
    .sort((a, b) => b.overdue - a.overdue || b.oldestDays - a.oldestDays);
  return { total: list.reduce((n, c) => n + c.overdue, 0), companies: list };
}
