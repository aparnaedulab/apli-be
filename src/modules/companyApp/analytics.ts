import { RunStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { inWords, mark, readPages, type Answers, type CheckPage } from './pages.js';

/**
 * How a company's simulation is being used: how many start it and where they
 * are, who they are, how far they get task by task, how they do on each
 * test, and - for students who chose to show the company their work - each
 * one by name.
 *
 * The counts and charts cover everyone. Names, contact details and answers
 * only cover a student who handed the simulation in for the company's review,
 * shared it with the company, or sent it a test; everyone else is a number.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Working, but nothing done for this long: probably stopped. */
const STALLED_AFTER_DAYS = 14;
const WEEKS = 12;
/** The biggest groups by name; the rest together as "Others". */
const TOP = 6;

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Counts by a label, biggest first; past the top few, folded into "Others". */
function groupCount(values: (string | null)[]) {
  const counts = new Map<string, number>();
  let missing = 0;
  for (const v of values) {
    if (!v) missing += 1;
    else counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows = sorted.slice(0, TOP).map(([label, count]) => ({ label, count }));
  const rest = sorted.slice(TOP).reduce((n, [, c]) => n + c, 0);
  if (rest) rows.push({ label: 'Others', count: rest });
  return { rows, missing };
}

/** The Monday a date falls in, as yyyy-mm-dd. */
function weekOf(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

export async function simulationAnalytics(companyId: string, id: string, now = new Date()) {
  const sim = await prisma.workSimulation.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      title: true,
      status: true,
      publishedAt: true,
      tasks: { orderBy: { position: 'asc' }, select: { id: true, position: true, title: true, pages: true } },
    },
  });
  if (!sim) throw notFound('No such simulation.');

  const runs = await prisma.workSimulationRun.findMany({
    where: { simulationId: sim.id },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      status: true,
      startedAt: true,
      lastActiveAt: true,
      completedAt: true,
      submittedAt: true,
      candidate: {
        select: {
          id: true,
          city: true,
          phone: true,
          course: true,
          specialisation: true,
          degreeLevel: true,
          startYear: true,
          graduationYear: true,
          otherCollege: true,
          college: { select: { name: true } },
          listing: { select: { name: true } },
          user: { select: { fullName: true, email: true } },
        },
      },
      done: { select: { taskId: true, doneAt: true } },
      checks: { select: { taskId: true, pageId: true, score: true, total: true, answers: true, revealedAt: true } },
      attempts: {
        orderBy: { number: 'asc' },
        select: { taskId: true, pageId: true, number: true, score: true, total: true, answers: true, sentAt: true },
      },
      shares: { where: { companyId }, select: { id: true } },
      review: { select: { stars: true } },
    },
  });

  const tasks = sim.tasks.map((t) => ({
    ...t,
    checks: readPages(t.pages).filter((p): p is CheckPage => p.kind === 'check'),
  }));
  const collegeOf = (c: (typeof runs)[number]['candidate']) => c.college?.name ?? c.listing?.name ?? c.otherCollege ?? null;
  const stalledBefore = new Date(now.getTime() - STALLED_AFTER_DAYS * DAY);

  /* ---------------------------------------------------------------- status */
  const count = (s: RunStatus) => runs.filter((r) => r.status === s).length;
  const finishDays = runs
    .filter((r) => r.completedAt)
    .map((r) => Math.max(0, (r.completedAt!.getTime() - r.startedAt.getTime()) / DAY));
  const stars = runs.map((r) => r.review?.stars).filter((s): s is number => typeof s === 'number');
  const status = {
    started: runs.length,
    working: count(RunStatus.ACTIVE),
    stalled: runs.filter((r) => r.status === RunStatus.ACTIVE && r.lastActiveAt < stalledBefore).length,
    toReview: count(RunStatus.IN_REVIEW),
    changesAsked: count(RunStatus.NEEDS_WORK),
    verified: count(RunStatus.COMPLETED),
    left: count(RunStatus.LEFT),
    completionRate: pct(count(RunStatus.COMPLETED), runs.length),
    medianDaysToFinish: finishDays.length ? Math.round(median(finishDays)! * 10) / 10 : null,
    rating: avg(stars),
    ratings: stars.length,
    stalledAfterDays: STALLED_AFTER_DAYS,
  };

  /* ----------------------------------------------------------------- weeks */
  const weeks: { week: string; started: number; finished: number }[] = [];
  const thisWeek = new Date(weekOf(now));
  for (let i = WEEKS - 1; i >= 0; i -= 1) {
    weeks.push({ week: weekOf(new Date(thisWeek.getTime() - i * 7 * DAY)), started: 0, finished: 0 });
  }
  const byWeek = new Map(weeks.map((w) => [w.week, w]));
  for (const r of runs) {
    const s = byWeek.get(weekOf(r.startedAt));
    if (s) s.started += 1;
    const f = r.completedAt ? byWeek.get(weekOf(r.completedAt)) : undefined;
    if (f) f.finished += 1;
  }

  /* ------------------------------------------------------------------- who */
  const people = runs.map((r) => r.candidate);
  const who = {
    colleges: groupCount(people.map(collegeOf)),
    courses: groupCount(people.map((c) => c.course)),
    branches: groupCount(people.map((c) => c.specialisation)),
    cities: groupCount(people.map((c) => c.city)),
    classOf: groupCount(people.map((c) => (c.graduationYear ? `Class of ${c.graduationYear}` : null))),
    levels: groupCount(people.map((c) => c.degreeLevel)),
  };

  /* ------------------------------------------------------- task by task */
  const doneBy = runs.map((r) => new Set(r.done.map((d) => d.taskId)));
  const taskStats = tasks.map((t, i) => {
    // Reached: the first task, or the one before it handed in.
    const reached = i === 0 ? runs.length : doneBy.filter((d) => d.has(tasks[i - 1]!.id)).length;
    const handedIn = doneBy.filter((d) => d.has(t.id)).length;
    const tests = t.checks.map((page) => {
      const tries = runs.flatMap((r) => r.attempts.filter((a) => a.taskId === t.id && a.pageId === page.id));
      const firsts = tries.filter((a) => a.number === 1);
      const latest = runs.flatMap((r) => r.checks.filter((c) => c.taskId === t.id && c.pageId === page.id));
      const graded = page.questions.some((q) => q.kind !== 'text');
      const triesPer = new Map<string, number>();
      for (const r of runs) {
        const n = r.attempts.filter((a) => a.taskId === t.id && a.pageId === page.id).length;
        if (n) triesPer.set(r.id, n);
      }
      // How each question went on a first try: the honest measure of how hard it is.
      const firstMarks = firsts.map((a) => mark(page, (a.answers ?? {}) as Answers));
      const questions = page.questions.map((q) => {
        const right = firstMarks.filter((m) => m.questions[q.id]?.correct === true).length;
        return {
          prompt: q.prompt,
          kind: q.kind,
          firstTryRight: q.kind === 'text' ? null : pct(right, firstMarks.length),
        };
      });
      return {
        id: page.id,
        title: page.title,
        graded,
        takers: triesPer.size,
        firstTry: graded ? pct(firsts.reduce((n, a) => n + a.score, 0), firsts.reduce((n, a) => n + a.total, 0)) : null,
        latest: graded ? pct(latest.reduce((n, c) => n + c.score, 0), latest.reduce((n, c) => n + c.total, 0)) : null,
        averageTries: avg([...triesPer.values()]),
        sawAnswers: latest.filter((c) => c.revealedAt).length,
        sent: tries.filter((a) => a.sentAt).length,
        questions,
      };
    });
    return { id: t.id, position: t.position, title: t.title, reached, handedIn, tests };
  });

  /* -------------------------------------------- students, by their choice */
  const students = runs.flatMap((r) => {
    const handedToCompany = Boolean(r.submittedAt) || r.status === RunStatus.COMPLETED;
    const shared = r.shares.length > 0;
    const sentAny = r.attempts.some((a) => a.sentAt);
    if (!handedToCompany && !shared && !sentAny) return [];
    // Handed in or shared: all their work. Only sent tests: only the tries they sent.
    const full = handedToCompany || shared;
    const c = r.candidate;
    const done = new Map(r.done.map((d) => [d.taskId, d.doneAt]));
    return [
      {
        runId: r.id,
        candidateId: c.id,
        name: c.user.fullName,
        email: c.user.email,
        phone: c.phone,
        college: collegeOf(c),
        course: [c.course, c.specialisation].filter(Boolean).join(' · ') || null,
        batch: c.startYear && c.graduationYear ? `${c.startYear} – ${c.graduationYear}` : null,
        city: c.city,
        status: r.status,
        why: handedToCompany ? 'handed-in' : shared ? 'shared' : 'sent-a-test',
        startedAt: r.startedAt,
        lastActiveAt: r.lastActiveAt,
        completedAt: r.completedAt,
        tasksDone: done.size,
        tasks: tasks.map((t) => ({
          taskId: t.id,
          handedInAt: done.get(t.id) ?? null,
          tests: t.checks.map((page) => {
            const tries = r.attempts.filter((a) => a.taskId === t.id && a.pageId === page.id);
            const latest = r.checks.find((x) => x.taskId === t.id && x.pageId === page.id);
            const visible = full ? tries : tries.filter((a) => a.sentAt);
            const shownTry = full ? tries[tries.length - 1] : visible[visible.length - 1];
            return {
              pageId: page.id,
              title: page.title,
              tries: tries.length,
              /** What the company may read: every try if they handed in or shared, else only those sent. */
              visible: visible.map((a) => ({ number: a.number, score: a.score, total: a.total, sent: Boolean(a.sentAt) })),
              latest: full && latest ? { score: latest.score, total: latest.total } : null,
              sawAnswers: full ? Boolean(latest?.revealedAt) : null,
              answers: shownTry
                ? { number: shownTry.number, questions: inWords(page, (shownTry.answers ?? {}) as Answers) }
                : null,
            };
          }),
        })),
      },
    ];
  });

  return {
    simulation: { id: sim.id, title: sim.title, status: sim.status, publishedAt: sim.publishedAt },
    status,
    weeks,
    who,
    tasks: taskStats,
    students,
    /** Started, but not shown to the company by name. */
    anonymous: runs.length - students.length,
  };
}
