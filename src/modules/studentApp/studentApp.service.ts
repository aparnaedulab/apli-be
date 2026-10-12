import { randomBytes } from 'node:crypto';
import { CompanyStatus, Prisma, RunStatus, WorkSimulationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import {
  checkPageIds,
  complete,
  forStudent,
  mark,
  readHandInKinds,
  readPages,
  writtenAnswers,
  type Answers,
  type CheckPage,
} from '../companyApp/pages.js';

/**
 * The student app: the dashboard and the work simulations behind it.
 *
 * A simulation goes: start, hand in each task (an answer, a link, or both),
 * explain the work in their own words, wait for a reviewer, and - once
 * approved - hold a verified certificate they can choose to show companies.
 *
 *   ACTIVE ──every task in + explained──▶ IN_REVIEW ──approved──▶ COMPLETED
 *     ▲                                       │
 *     └──────────── NEEDS_WORK ◀──changes asked┘
 *
 * The student's own picks drive what they are shown: the career interests
 * they chose decide what is suggested first, and anything they close stays
 * closed.
 */

const CARD_SELECT = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  coverUrl: true,
  field: true,
  level: true,
  hours: true,
  skills: true,
  publishedAt: true,
  company: { select: { id: true, name: true, logoUrl: true } },
  _count: { select: { tasks: true } },
} satisfies Prisma.WorkSimulationSelect;

type CardRow = Prisma.WorkSimulationGetPayload<{ select: typeof CARD_SELECT }>;

export interface SimulationCard {
  id: string;
  slug: string;
  title: string;
  summary: string;
  field: string;
  level: string;
  hours: number;
  skills: string[];
  tasks: number;
  company: { id: string; name: string; logoUrl: string | null };
  coverUrl: string | null;
  /** Published in the last fortnight. */
  isNew: boolean;
  /** Where this student stands on it, when they have started it. */
  myStatus: RunStatus | null;
  /** How many students from the same college have finished it. */
  fromCollege: number;
}

const FORTNIGHT = 14 * 24 * 60 * 60 * 1000;
/** How many suggestions the board shows; the catalogue has the rest. */
const TRY_LIMIT = 3;

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

function card(row: CardRow, fromCollege = 0, myStatus: RunStatus | null = null): SimulationCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    field: row.field,
    level: row.level,
    hours: row.hours,
    skills: list(row.skills),
    tasks: row._count.tasks,
    company: row.company,
    coverUrl: row.coverUrl,
    isNew: Boolean(row.publishedAt && Date.now() - row.publishedAt.getTime() < FORTNIGHT),
    myStatus,
    fromCollege,
  };
}

/** Open to students: approved, and from a company that is still verified. */
const LIVE = { status: WorkSimulationStatus.LIVE, company: { status: CompanyStatus.VERIFIED } } as const;
/** Started and not given up: on the board's middle column. */
const ON_THE_GO: RunStatus[] = [RunStatus.ACTIVE, RunStatus.IN_REVIEW, RunStatus.NEEDS_WORK];

/**
 * A simulation a student may open: any live one, and any they have already
 * started - so retiring it, or a company being suspended, never takes a
 * student's own work away from them part way through.
 */
const openTo = (candidateId: string, slug: string): Prisma.WorkSimulationWhereInput => ({
  slug,
  OR: [LIVE, { runs: { some: { candidateId } } }],
});

async function me(candidateId: string) {
  const c = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { interests: true, collegeId: true, user: { select: { fullName: true } } },
  });
  if (!c) throw notFound('No such student.');
  return {
    firstName: c.user.fullName.trim().split(/\s+/)[0] ?? '',
    interests: Array.isArray(c.interests) ? (c.interests as string[]) : [],
    collegeId: c.collegeId,
  };
}

/** For each simulation, how many students at this college have finished it. */
async function collegeCounts(collegeId: string | null, simulationIds: string[]): Promise<Map<string, number>> {
  if (!collegeId || simulationIds.length === 0) return new Map();
  const rows = await prisma.workSimulationRun.groupBy({
    by: ['simulationId'],
    where: { simulationId: { in: simulationIds }, status: RunStatus.COMPLETED, candidate: { collegeId } },
    _count: true,
  });
  return new Map(rows.map((r) => [r.simulationId, r._count]));
}

async function dismissed(candidateId: string, kind: string): Promise<Set<string>> {
  const rows = await prisma.dashboardDismissal.findMany({ where: { candidateId, kind }, select: { refId: true } });
  return new Set(rows.map((r) => r.refId));
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export async function dashboard(candidateId: string) {
  const [who, runs, hiddenSuggestions, hiddenRuns, profileState] = await Promise.all([
    me(candidateId),
    prisma.workSimulationRun.findMany({
      where: { candidateId, status: { in: [...ON_THE_GO, RunStatus.COMPLETED] } },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        status: true,
        startedAt: true,
        lastActiveAt: true,
        completedAt: true,
        submittedAt: true,
        reviewedAt: true,
        certificateCode: true,
        reviewNote: true,
        simulation: {
          select: {
            ...CARD_SELECT,
            tasks: { orderBy: { position: 'asc' }, select: { id: true, title: true, minutes: true } },
          },
        },
        done: { select: { taskId: true, doneAt: true } },
        shares: { select: { company: { select: { id: true, name: true } } } },
      },
    }),
    dismissed(candidateId, 'suggestion'),
    dismissed(candidateId, 'run'),
    profile(candidateId),
  ]);

  const started = new Set(runs.map((r) => r.simulation.id));

  const working = runs
    .filter((r) => ON_THE_GO.includes(r.status) && !hiddenRuns.has(r.id))
    .map((r) => {
      const doneIds = new Set(r.done.map((d) => d.taskId));
      const next = r.simulation.tasks.find((t) => !doneIds.has(t.id));
      return {
        runId: r.id,
        status: r.status,
        simulation: card(r.simulation),
        tasksDone: doneIds.size,
        tasksLeft: r.simulation.tasks.length - doneIds.size,
        nextTask: next ? { title: next.title, minutes: next.minutes } : null,
        /** Every task is in and only the explanation is left. */
        readyToExplain: r.status === RunStatus.ACTIVE && !next,
        reviewNote: r.status === RunStatus.NEEDS_WORK ? r.reviewNote : null,
        lastActiveAt: r.lastActiveAt,
      };
    });

  const certificates = runs
    .filter((r) => r.status === RunStatus.COMPLETED)
    .map((r) => ({
      runId: r.id,
      simulation: card(r.simulation),
      completedAt: r.completedAt,
      certificateCode: r.certificateCode,
      sharedWith: r.shares.map((s) => s.company),
    }));

  // Their fields first, then everything else that is new, so nobody sees an empty board.
  const pool = await prisma.workSimulation.findMany({
    where: { ...LIVE, id: { notIn: [...started] } },
    orderBy: { publishedAt: 'desc' },
    take: 40,
    select: CARD_SELECT,
  });
  const fresh = pool.filter((p) => !hiddenSuggestions.has(p.id));
  const rank = (row: CardRow) => (who.interests.includes(row.field) ? 0 : 1);
  const ordered = [...fresh].sort((a, b) => rank(a) - rank(b));
  const top = ordered.slice(0, TRY_LIMIT);
  const counts = await collegeCounts(who.collegeId, top.map((t) => t.id));

  // What they did lately, newest first, read off the runs themselves.
  type Event = { at: Date; kind: 'started' | 'handed-in' | 'sent' | 'changes' | 'verified'; text: string; slug: string };
  const events: Event[] = [];
  for (const r of runs) {
    const title = r.simulation.title;
    const slug = r.simulation.slug;
    const taskTitle = new Map(r.simulation.tasks.map((t) => [t.id, t.title]));
    events.push({ at: r.startedAt, kind: 'started', text: `Started ${title}`, slug });
    for (const d of r.done) {
      events.push({ at: d.doneAt, kind: 'handed-in', text: `Handed in "${taskTitle.get(d.taskId) ?? 'a task'}"`, slug });
    }
    if (r.submittedAt) events.push({ at: r.submittedAt, kind: 'sent', text: `Sent ${title} for review`, slug });
    if (r.status === RunStatus.NEEDS_WORK && r.reviewedAt) {
      events.push({ at: r.reviewedAt, kind: 'changes', text: `Changes asked on ${title}`, slug });
    }
    if (r.completedAt) events.push({ at: r.completedAt, kind: 'verified', text: `${title} verified`, slug });
  }
  const activity = events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 7);

  // Skills from every simulation they have worked on; verified ones count most.
  const skillMap = new Map<string, { name: string; times: number; verified: boolean }>();
  for (const r of runs) {
    for (const name of card(r.simulation).skills) {
      const k = name.toLowerCase();
      const cur = skillMap.get(k) ?? { name, times: 0, verified: false };
      cur.times += 1;
      cur.verified ||= r.status === RunStatus.COMPLETED;
      skillMap.set(k, cur);
    }
  }
  const skills = [...skillMap.values()].sort(
    (a, b) => Number(b.verified) - Number(a.verified) || b.times - a.times || a.name.localeCompare(b.name),
  );

  // For each field they picked: how many are open, and how far they have got in it.
  const fieldCounts = who.interests.length
    ? await prisma.workSimulation.groupBy({
        by: ['field'],
        where: { ...LIVE, field: { in: who.interests } },
        _count: true,
      })
    : [];
  const fields = who.interests.map((f) => ({
    field: f,
    open: fieldCounts.find((c) => c.field === f)?._count ?? 0,
    started: runs.filter((r) => r.simulation.field === f && r.status !== RunStatus.COMPLETED).length,
    verified: runs.filter((r) => r.simulation.field === f && r.status === RunStatus.COMPLETED).length,
  }));

  return {
    firstName: who.firstName,
    interests: who.interests,
    stats: {
      tasksHandedIn: runs.reduce((n, r) => n + r.done.length, 0),
      hoursVerified: runs.filter((r) => r.status === RunStatus.COMPLETED).reduce((n, r) => n + r.simulation.hours, 0),
    },
    activity,
    skills,
    fields,
    suggested: top.map((t) => card(t, counts.get(t.id) ?? 0)),
    /** How many more there are to try beyond the ones shown. */
    moreToTry: Math.max(0, ordered.length - TRY_LIMIT),
    inProgress: working,
    certificates,
    sharedCount: new Set(certificates.flatMap((c) => c.sharedWith.map((s) => s.id))).size,
    profile: { complete: profileState.complete, missing: profileState.missing },
  };
}

/* -------------------------------------------------------------------------- */
/* Catalogue and one simulation                                                */
/* -------------------------------------------------------------------------- */

export async function listSimulations(candidateId: string, input: { field?: string; q?: string }) {
  const who = await me(candidateId);
  const rows = await prisma.workSimulation.findMany({
    where: {
      ...LIVE,
      ...(input.field ? { field: input.field } : {}),
      ...(input.q
        ? {
            OR: [
              { title: { contains: input.q } },
              { summary: { contains: input.q } },
              { company: { name: { contains: input.q } } },
            ],
          }
        : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: 60,
    select: CARD_SELECT,
  });
  const [fields, counts, mine] = await Promise.all([
    prisma.workSimulation.groupBy({ by: ['field'], where: LIVE, _count: true, orderBy: { field: 'asc' } }),
    collegeCounts(who.collegeId, rows.map((r) => r.id)),
    prisma.workSimulationRun.findMany({
      where: { candidateId, simulationId: { in: rows.map((r) => r.id) } },
      select: { simulationId: true, status: true },
    }),
  ]);
  const status = new Map(mine.map((m) => [m.simulationId, m.status]));
  return {
    simulations: rows.map((r) => card(r, counts.get(r.id) ?? 0, status.get(r.id) ?? null)),
    fields: fields.map((f) => ({ field: f.field, count: f._count })),
  };
}

/** One simulation, its tasks with what the student handed in, and where they stand. */
export async function simulationDetail(candidateId: string, slug: string) {
  const row = await prisma.workSimulation.findFirst({
    where: openTo(candidateId, slug),
    select: {
      ...CARD_SELECT,
      about: true,
      videoUrl: true,
      company: {
        select: {
          id: true,
          name: true,
          logoUrl: true,
          headline: true,
          about: true,
          website: true,
          city: true,
          sizeBand: true,
          foundedYear: true,
          industryOther: true,
          industry: { select: { name: true } },
        },
      },
      tasks: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          title: true,
          brief: true,
          handIn: true,
          learn: true,
          steps: true,
          pages: true,
          handInKinds: true,
          minutes: true,
        },
      },
    },
  });
  if (!row) throw notFound('That simulation is not open.');
  const run = await prisma.workSimulationRun.findUnique({
    where: { simulationId_candidateId: { simulationId: row.id, candidateId } },
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      certificateCode: true,
      explainHow: true,
      explainChange: true,
      submittedAt: true,
      reviewNote: true,
      done: { select: { taskId: true, answer: true, link: true, fileUrl: true, fileName: true, doneAt: true } },
      checks: { select: { taskId: true, pageId: true, answers: true } },
      shares: { select: { company: { select: { id: true, name: true } } } },
      review: { select: { stars: true, comment: true } },
    },
  });
  const [moreFromCompany, rating] = await Promise.all([
    prisma.workSimulation.findMany({
      where: { ...LIVE, companyId: row.company.id, id: { not: row.id } },
      orderBy: { publishedAt: 'desc' },
      take: 4,
      select: { slug: true, title: true, field: true, hours: true },
    }),
    prisma.workSimulationReview.aggregate({
      where: { run: { simulationId: row.id } },
      _avg: { stars: true },
      _count: true,
    }),
  ]);
  const c = row.company;
  const handedIn = new Map(run?.done.map((d) => [d.taskId, d]) ?? []);
  return {
    simulation: {
      ...card(row, 0, run?.status ?? null),
      headline: c.headline ?? null,
      about: row.about,
      videoUrl: row.videoUrl,
    },
    company: {
      name: c.name,
      headline: c.headline,
      about: c.about,
      website: c.website,
      city: c.city,
      size: c.sizeBand ? SIZE[c.sizeBand] : null,
      founded: c.foundedYear,
      industry: c.industry?.name ?? c.industryOther ?? null,
      more: moreFromCompany,
    },
    reviews: {
      average: rating._avg.stars === null ? null : Math.round(rating._avg.stars * 10) / 10,
      count: rating._count,
      mine: run?.review ?? null,
      /** Only a student who finished it may say what it was like. */
      canReview: run?.status === RunStatus.COMPLETED,
    },
    tasks: row.tasks.map((t) => {
      const h = handedIn.get(t.id);
      const pages = readPages(t.pages);
      return {
        ...t,
        learn: list(t.learn),
        steps: list(t.steps),
        pages: forStudent(pages),
        handInKinds: readHandInKinds(t.handInKinds),
        checks: markedChecks(pages, (run?.checks ?? []).filter((c) => c.taskId === t.id)),
        done: Boolean(h),
        handedIn: h ? { answer: h.answer, link: h.link, fileUrl: h.fileUrl, fileName: h.fileName, at: h.doneAt } : null,
      };
    }),
    run: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          certificateCode: run.certificateCode,
          explainHow: run.explainHow,
          explainChange: run.explainChange,
          submittedAt: run.submittedAt,
          reviewNote: run.reviewNote,
          sharedWith: run.shares.map((s) => s.company),
        }
      : null,
  };
}

const SIZE: Record<string, string> = {
  STARTUP: '1-50 people',
  SMALL: '51-200 people',
  MID: '201-1,000 people',
  LARGE: '1,001-5,000 people',
  ENTERPRISE: '5,000+ people',
};

/**
 * What students who finished a simulation said about it, newest first.
 * Each is signed with a first name and initial, and their college: enough
 * to trust it, not enough to find them.
 */
export async function simulationReviews(candidateId: string, slug: string) {
  const row = await prisma.workSimulation.findFirst({ where: openTo(candidateId, slug), select: { id: true } });
  if (!row) throw notFound('That simulation is not open.');
  const reviews = await prisma.workSimulationReview.findMany({
    where: { run: { simulationId: row.id } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      stars: true,
      comment: true,
      createdAt: true,
      run: {
        select: {
          candidate: {
            select: {
              otherCollege: true,
              college: { select: { name: true } },
              listing: { select: { name: true } },
              user: { select: { fullName: true } },
            },
          },
        },
      },
    },
  });
  return reviews.map((r) => {
    const c = r.run.candidate;
    const [first = 'A student', last] = c.user.fullName.trim().split(/\s+/);
    return {
      stars: r.stars,
      comment: r.comment,
      at: r.createdAt,
      by: last ? `${first} ${last[0]}.` : first,
      college: c.college?.name ?? c.listing?.name ?? c.otherCollege ?? null,
    };
  });
}

/** A student's stars and words on a simulation they finished. One each; saving again changes it. */
export async function saveReview(candidateId: string, slug: string, input: { stars: number; comment?: string }) {
  const row = await prisma.workSimulation.findFirst({ where: openTo(candidateId, slug), select: { id: true } });
  if (!row) throw notFound('That simulation is not open.');
  const run = await prisma.workSimulationRun.findUnique({
    where: { simulationId_candidateId: { simulationId: row.id, candidateId } },
    select: { id: true, status: true },
  });
  if (run?.status !== RunStatus.COMPLETED) throw forbidden('Finish the simulation first, then say what it was like.');
  const comment = input.comment?.trim() || null;
  await prisma.workSimulationReview.upsert({
    where: { runId: run.id },
    create: { runId: run.id, stars: input.stars, comment },
    update: { stars: input.stars, comment },
  });
  return simulationDetail(candidateId, slug);
}

/** Starts a simulation, or picks one back up that was left or taken off the board. */
export async function startSimulation(candidateId: string, slug: string) {
  const row = await prisma.workSimulation.findFirst({ where: { slug, ...LIVE }, select: { id: true } });
  if (!row) throw notFound('That simulation is not open.');
  const run = await prisma.workSimulationRun.upsert({
    where: { simulationId_candidateId: { simulationId: row.id, candidateId } },
    create: { simulationId: row.id, candidateId },
    update: { lastActiveAt: new Date() },
  });
  if (run.status === RunStatus.LEFT) {
    await prisma.workSimulationRun.update({ where: { id: run.id }, data: { status: RunStatus.ACTIVE } });
  }
  // Starting it again brings it back onto the board.
  await prisma.dashboardDismissal.deleteMany({ where: { candidateId, kind: 'run', refId: run.id } });
  return simulationDetail(candidateId, slug);
}

/** A student's answered checks in one task, marked again against the task as it is now. */
function markedChecks(pages: ReturnType<typeof readPages>, answered: { pageId: string; answers: unknown }[]) {
  const out: Record<string, { answers: Answers; score: number; total: number; questions: ReturnType<typeof mark>['questions'] }> = {};
  for (const a of answered) {
    const page = pages.find((p): p is CheckPage => p.id === a.pageId && p.kind === 'check');
    if (!page) continue;
    const answers = (a.answers ?? {}) as Answers;
    out[a.pageId] = { answers, ...mark(page, answers) };
  }
  return out;
}

/**
 * Marks a quick check inside a task and keeps the answers. It can be answered
 * again; the latest counts. Only a task the student has reached - the next
 * one, or one already handed in - can be answered.
 */
export async function answerCheck(candidateId: string, slug: string, taskId: string, pageId: string, answers: Answers) {
  const { row, run } = await runFor(candidateId, slug);
  const task = await prisma.workSimulationTask.findFirst({ where: { id: taskId, simulationId: row.id }, select: { pages: true } });
  if (!task) throw notFound('No such task.');
  if (run.status === RunStatus.IN_REVIEW || run.status === RunStatus.COMPLETED) {
    throw conflict('This is already handed in.');
  }
  const done = new Set(run.done.map((d) => d.taskId));
  const next = row.tasks.find((t) => !done.has(t.id));
  if (!done.has(taskId) && next?.id !== taskId) throw badRequest('Work through the tasks in order.');

  const page = readPages(task.pages).find((p): p is CheckPage => p.id === pageId && p.kind === 'check');
  if (!page) throw notFound('No such check.');
  if (!complete(page, answers)) throw badRequest('Answer every question first.');
  const result = mark(page, answers);
  await prisma.workSimulationCheckAnswer.upsert({
    where: { runId_taskId_pageId: { runId: run.id, taskId, pageId } },
    create: { runId: run.id, taskId, pageId, answers, score: result.score, total: result.total },
    update: { answers, score: result.score, total: result.total },
  });
  await prisma.workSimulationRun.update({ where: { id: run.id }, data: { lastActiveAt: new Date() } });
  return simulationDetail(candidateId, slug);
}

async function runFor(candidateId: string, slug: string) {
  const row = await prisma.workSimulation.findFirst({
    where: openTo(candidateId, slug),
    select: { id: true, tasks: { orderBy: { position: 'asc' }, select: { id: true, pages: true, handInKinds: true } } },
  });
  if (!row) throw notFound('That simulation is not open.');
  const run = await prisma.workSimulationRun.findUnique({
    where: { simulationId_candidateId: { simulationId: row.id, candidateId } },
    select: { id: true, status: true, done: { select: { taskId: true } } },
  });
  if (!run) throw badRequest('Start the simulation first.');
  return { row, run };
}

/**
 * Hands in one task. Tasks go in order the first time through; once the
 * reviewer has asked for changes, any of them can be handed in again.
 */
export async function submitTask(
  candidateId: string,
  slug: string,
  taskId: string,
  input: { answer?: string; link?: string; fileUrl?: string | null; fileName?: string | null },
) {
  const { row, run } = await runFor(candidateId, slug);
  if (!row.tasks.some((t) => t.id === taskId)) throw notFound('No such task.');
  if (run.status === RunStatus.IN_REVIEW) throw conflict('This is with a reviewer. You can change it if they ask.');
  if (run.status === RunStatus.COMPLETED) throw conflict('This simulation is finished.');

  const done = new Set(run.done.map((d) => d.taskId));
  const next = row.tasks.find((t) => !done.has(t.id));
  if (run.status === RunStatus.ACTIVE && !done.has(taskId) && next?.id !== taskId) {
    throw badRequest('Hand in the tasks in order.');
  }

  // Every quick check in the task is answered first.
  const checks = checkPageIds(readPages(row.tasks.find((t) => t.id === taskId)!.pages));
  if (checks.length) {
    const answered = await prisma.workSimulationCheckAnswer.count({ where: { runId: run.id, taskId, pageId: { in: checks } } });
    if (answered < checks.length) throw badRequest('Answer the quick checks in this task before handing it in.');
  }

  const kinds = readHandInKinds(row.tasks.find((t) => t.id === taskId)!.handInKinds);
  const answer = kinds.includes('text') ? input.answer?.trim() || null : null;
  const link = kinds.includes('link') ? input.link?.trim() || null : null;
  const fileUrl = kinds.includes('file') ? input.fileUrl?.trim() || null : null;
  const fileName = fileUrl ? input.fileName?.trim() || 'Your file' : null;
  if (!answer && !link && !fileUrl) {
    const ways = { text: 'write your answer', link: 'add a link', file: 'upload a file' };
    throw badRequest(`To hand this in, ${kinds.map((k) => ways[k]).join(' or ')}.`);
  }

  await prisma.workSimulationTaskDone.upsert({
    where: { runId_taskId: { runId: run.id, taskId } },
    create: { runId: run.id, taskId, answer, link, fileUrl, fileName },
    update: { answer, link, fileUrl, fileName, doneAt: new Date() },
  });
  await prisma.workSimulationRun.update({ where: { id: run.id }, data: { lastActiveAt: new Date() } });
  return simulationDetail(candidateId, slug);
}

/**
 * "Explain your work": the last step before review. Only once every task is
 * in, and again after changes were asked for.
 */
export async function explainWork(candidateId: string, slug: string, input: { how: string; change: string }) {
  const { row, run } = await runFor(candidateId, slug);
  if (run.status !== RunStatus.ACTIVE && run.status !== RunStatus.NEEDS_WORK) {
    throw conflict('This is not waiting for an explanation.');
  }
  const done = new Set(run.done.map((d) => d.taskId));
  if (row.tasks.some((t) => !done.has(t.id))) throw badRequest('Hand in every task first.');

  await prisma.workSimulationRun.update({
    where: { id: run.id },
    data: {
      explainHow: input.how.trim(),
      explainChange: input.change.trim(),
      status: RunStatus.IN_REVIEW,
      submittedAt: new Date(),
      lastActiveAt: new Date(),
    },
  });
  return simulationDetail(candidateId, slug);
}

/* -------------------------------------------------------------------------- */
/* Sharing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Companies a student may show a finished simulation to: verified ones with
 * simulations on Apli.ai, the simulation's own company first.
 */
export async function shareOptions(candidateId: string, runId: string) {
  const run = await prisma.workSimulationRun.findFirst({
    where: { id: runId, candidateId, status: RunStatus.COMPLETED },
    select: { simulation: { select: { companyId: true } }, shares: { select: { companyId: true } } },
  });
  if (!run) throw notFound('No finished simulation like that.');
  const companies = await prisma.company.findMany({
    where: { status: CompanyStatus.VERIFIED, workSimulations: { some: LIVE } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, logoUrl: true },
  });
  const own = run.simulation.companyId;
  const chosen = new Set(run.shares.map((s) => s.companyId));
  return {
    companies: [...companies]
      .sort((a, b) => (a.id === own ? -1 : b.id === own ? 1 : 0))
      .map((c) => ({ ...c, isOwner: c.id === own, shared: chosen.has(c.id) })),
  };
}

/** Exactly these companies may now see it; everyone else may not. */
export async function setShares(candidateId: string, runId: string, companyIds: string[]) {
  const options = await shareOptions(candidateId, runId);
  const allowed = new Set(options.companies.map((c) => c.id));
  const wanted = [...new Set(companyIds)];
  if (wanted.some((id) => !allowed.has(id))) throw badRequest('Pick companies from the list.');
  await prisma.$transaction([
    prisma.workSimulationShare.deleteMany({ where: { runId, companyId: { notIn: wanted } } }),
    ...wanted.map((companyId) =>
      prisma.workSimulationShare.upsert({
        where: { runId_companyId: { runId, companyId } },
        create: { runId, companyId },
        update: {},
      }),
    ),
  ]);
  return shareOptions(candidateId, runId);
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

const PROFILE_PARTS = [
  { key: 'interests', label: 'Fields you want to try' },
  { key: 'city', label: 'City' },
  { key: 'phone', label: 'Mobile' },
  { key: 'specialisation', label: 'Branch or main subject' },
  { key: 'cgpa', label: 'CGPA' },
] as const;

/** What the student has told us, and what is still missing. */
export async function profile(candidateId: string) {
  const c = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      interests: true,
      city: true,
      phone: true,
      specialisation: true,
      cgpa: true,
      course: true,
      degreeLevel: true,
      startYear: true,
      graduationYear: true,
      otherCollege: true,
      college: { select: { name: true } },
      listing: { select: { name: true } },
      user: { select: { fullName: true, email: true } },
    },
  });
  if (!c) throw notFound('No such student.');
  const values = {
    interests: Array.isArray(c.interests) ? (c.interests as string[]) : [],
    city: c.city,
    phone: c.phone,
    specialisation: c.specialisation,
    cgpa: c.cgpa === null ? null : Number(c.cgpa),
  };
  const missing = PROFILE_PARTS.filter((p) => {
    const v = values[p.key];
    return v === null || v === '' || (Array.isArray(v) && v.length === 0);
  }).map((p) => ({ key: p.key, label: p.label }));
  return {
    fullName: c.user.fullName,
    email: c.user.email,
    college: c.college?.name ?? c.listing?.name ?? c.otherCollege ?? null,
    course: c.course,
    degreeLevel: c.degreeLevel,
    batch: c.startYear && c.graduationYear ? `${c.startYear} – ${c.graduationYear}` : null,
    ...values,
    complete: Math.round(((PROFILE_PARTS.length - missing.length) / PROFILE_PARTS.length) * 100),
    missing,
  };
}

export async function saveProfile(
  candidateId: string,
  input: { interests: string[]; city: string; phone: string | null; specialisation: string | null; cgpa: number | null },
) {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      interests: input.interests,
      city: input.city,
      phone: input.phone,
      specialisation: input.specialisation,
      cgpa: input.cgpa,
    },
  });
  return profile(candidateId);
}

/* -------------------------------------------------------------------------- */
/* Dismissing                                                                  */
/* -------------------------------------------------------------------------- */

/** Closes a board card for good. */
export async function dismiss(candidateId: string, kind: 'suggestion' | 'run', refId: string) {
  await prisma.dashboardDismissal.upsert({
    where: { candidateId_kind_refId: { candidateId, kind, refId } },
    create: { candidateId, kind, refId },
    update: {},
  });
}

/* -------------------------------------------------------------------------- */
/* Review - the platform team's side                                           */
/* -------------------------------------------------------------------------- */

/** Simulations waiting for a reviewer, oldest first, with everything handed in. */
export async function reviewQueue() {
  const runs = await prisma.workSimulationRun.findMany({
    where: { status: RunStatus.IN_REVIEW },
    orderBy: { submittedAt: 'asc' },
    select: {
      id: true,
      submittedAt: true,
      explainHow: true,
      explainChange: true,
      candidate: {
        select: {
          otherCollege: true,
          college: { select: { name: true } },
          listing: { select: { name: true } },
          user: { select: { fullName: true, email: true } },
        },
      },
      simulation: {
        select: {
          title: true,
          slug: true,
          company: { select: { id: true, name: true } },
          tasks: {
            orderBy: { position: 'asc' },
            select: { id: true, position: true, title: true, brief: true, handIn: true, pages: true },
          },
        },
      },
      done: { select: { taskId: true, answer: true, link: true, fileUrl: true, fileName: true } },
      checks: { select: { taskId: true, pageId: true, score: true, total: true, answers: true } },
    },
  });
  return runs.map((r) => {
    const handedIn = new Map(r.done.map((d) => [d.taskId, d]));
    return {
      runId: r.id,
      companyId: r.simulation.company.id,
      submittedAt: r.submittedAt,
      student: {
        name: r.candidate.user.fullName,
        email: r.candidate.user.email,
        college: r.candidate.college?.name ?? r.candidate.listing?.name ?? r.candidate.otherCollege ?? null,
      },
      simulation: { title: r.simulation.title, slug: r.simulation.slug, company: r.simulation.company.name },
      tasks: r.simulation.tasks.map(({ pages, ...t }) => ({
        ...t,
        answer: handedIn.get(t.id)?.answer ?? null,
        link: handedIn.get(t.id)?.link ?? null,
        fileUrl: handedIn.get(t.id)?.fileUrl ?? null,
        fileName: handedIn.get(t.id)?.fileName ?? null,
        checks: readPages(pages)
          .filter((p) => p.kind === 'check')
          .map((p) => {
            const c = r.checks.find((x) => x.taskId === t.id && x.pageId === p.id);
            const check = p as CheckPage;
            return {
              title: p.title,
              score: c?.score ?? null,
              total: c?.total ?? check.questions.filter((q) => q.kind !== 'text').length,
              written: c ? writtenAnswers(check, (c.answers ?? {}) as Answers) : [],
            };
          }),
      })),
      explainHow: r.explainHow,
      explainChange: r.explainChange,
    };
  });
}

/** Approves a simulation (issuing its certificate) or sends it back with a note. */
export async function review(reviewerId: string, runId: string, input: { decision: 'approve' | 'changes'; note?: string }) {
  const run = await prisma.workSimulationRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run) throw notFound('No such submission.');
  if (run.status !== RunStatus.IN_REVIEW) throw conflict('This is not waiting for review.');
  if (input.decision === 'changes' && !input.note?.trim()) throw badRequest('Say what needs changing.');

  const now = new Date();
  await prisma.workSimulationRun.update({
    where: { id: runId },
    data:
      input.decision === 'approve'
        ? {
            status: RunStatus.COMPLETED,
            completedAt: now,
            certificateCode: certificateCode(),
            reviewedAt: now,
            reviewedById: reviewerId,
            reviewNote: input.note?.trim() || null,
          }
        : {
            status: RunStatus.NEEDS_WORK,
            reviewedAt: now,
            reviewedById: reviewerId,
            reviewNote: input.note!.trim(),
          },
  });
}

/** "APLI-7K2M-9QXD": short enough to read out, long enough not to guess. */
function certificateCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `APLI-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * What anyone holding a code may see: that it is real, whose, and for what.
 * The same shape the public certificate page already reads.
 */
export async function checkWorkCertificate(code: string) {
  const clean = code.trim().toUpperCase();
  if (!/^APLI-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clean)) return null;
  const run = await prisma.workSimulationRun.findFirst({
    where: { certificateCode: clean, status: RunStatus.COMPLETED },
    select: {
      completedAt: true,
      candidate: { select: { user: { select: { fullName: true } } } },
      simulation: { select: { title: true, field: true, hours: true, company: { select: { name: true } } } },
    },
  });
  if (!run?.completedAt) return null;
  return {
    code: clean,
    student: run.candidate.user.fullName,
    simulation: run.simulation.title,
    role: run.simulation.field,
    hours: run.simulation.hours,
    company: run.simulation.company.name,
    completedAt: run.completedAt,
  };
}
