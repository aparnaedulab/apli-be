import { ApplicationStatus, type AptitudeSection, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  AREAS,
  AREA_LABELS,
  CHECK_QUESTIONS,
  blendAptitude,
  composite,
  isQuestionKey,
  planFor,
  scoreAnswers,
  type AreaScores,
} from './readiness.js';
import { topicStats, wrongToRetry, type AttemptRow } from './spaced.js';

/**
 * Readiness and aptitude practice, over the database.
 *
 * Everything a student sees here is about their own progress. The college
 * overview at the bottom deals only in counts and averages - it helps a
 * placement cell decide what to run a session on, never who to single out.
 */

/* -------------------------------------------------------------------------- */
/* Practice history                                                            */
/* -------------------------------------------------------------------------- */

async function attemptRows(candidateId: string): Promise<AttemptRow[]> {
  const rows = await prisma.aptitudeAttempt.findMany({
    where: { candidateId },
    select: {
      questionId: true,
      correct: true,
      createdAt: true,
      question: { select: { topic: true, section: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    questionId: r.questionId,
    topic: r.question.topic,
    section: r.question.section,
    correct: r.correct,
    createdAt: r.createdAt,
  }));
}

/** Only the aptitude sections count toward the aptitude score; technical is its own area. */
async function aptitudePractice(candidateId: string) {
  const [attempts, correct] = await Promise.all([
    prisma.aptitudeAttempt.count({ where: { candidateId, question: { section: { not: 'TECHNICAL' } } } }),
    prisma.aptitudeAttempt.count({
      where: { candidateId, correct: true, question: { section: { not: 'TECHNICAL' } } },
    }),
  ]);
  return { attempts, correct };
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

function asScores(value: Prisma.JsonValue): AreaScores {
  const raw = (value ?? {}) as Record<string, unknown>;
  const out = {} as AreaScores;
  for (const a of AREAS) out[a] = typeof raw[a] === 'number' ? (raw[a] as number) : 0;
  return out;
}

/** Aptitude-heavy round types get test practice; conversation-heavy ones get interview practice. */
const TEST_ROUNDS = new Set(['MCQ_TEST', 'ASSIGNMENT', 'WORK_SIMULATION']);
const TALK_ROUNDS = new Set(['LIVE_INTERVIEW', 'VIDEO_INTERVIEW', 'GROUP_DISCUSSION']);

/**
 * "Deloitte on Friday": for every application with a round coming up, what to
 * do on each day until then. Built from the round the company described, so a
 * test gets practice and an interview gets interview practice.
 */
async function upcomingRounds(candidateId: string) {
  const now = new Date();
  const apps = await prisma.application.findMany({
    where: {
      candidateId,
      status: { in: [ApplicationStatus.APPLIED, ApplicationStatus.UNDER_REVIEW, ApplicationStatus.IN_ROUND] },
    },
    select: {
      id: true,
      currentRoundId: true,
      job: {
        select: {
          id: true,
          title: true,
          company: { select: { name: true } },
          rounds: {
            orderBy: { order: 'asc' },
            select: { id: true, order: true, name: true, type: true, description: true, scheduledAt: true, isOnline: true },
          },
        },
      },
    },
  });

  const out = [];
  for (const a of apps) {
    const rounds = a.job.rounds;
    const current = rounds.find((r) => r.id === a.currentRoundId);
    // The current round if it is still ahead, else the next one that is dated.
    const next = [current, ...rounds.filter((r) => !current || r.order > current.order)].find(
      (r) => r?.scheduledAt && r.scheduledAt > now,
    );
    if (!next?.scheduledAt) continue;

    const days = Math.max(0, Math.ceil((next.scheduledAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    const steps: { when: string; task: string; to: string }[] = [];
    if (TEST_ROUNDS.has(next.type)) {
      steps.push({ when: 'Every day until then', task: 'Ten questions on your weakest topics', to: '/student/practice?mode=REVIEW' });
      steps.push({ when: days > 1 ? 'Two days before' : 'Today', task: 'One full timed test, 20 questions in 20 minutes', to: '/student/practice?mode=MIXED' });
    }
    if (TALK_ROUNDS.has(next.type)) {
      steps.push({ when: 'Every day until then', task: 'Answer two interview questions out loud', to: '/student/interview' });
      steps.push({ when: days > 1 ? 'Two days before' : 'Today', task: `Say why you want to work at ${a.job.company.name} in a minute`, to: '/student/interview' });
    }
    steps.push({
      when: 'The day before',
      task: next.isOnline ? 'Check your camera, light and sound' : 'Plan what to wear and when to leave',
      to: '/student/prepare',
    });

    out.push({
      applicationId: a.id,
      jobId: a.job.id,
      company: a.job.company.name,
      role: a.job.title,
      round: { name: next.name, type: next.type, description: next.description, at: next.scheduledAt, isOnline: next.isOnline },
      daysUntil: days,
      steps,
    });
  }
  return out.sort((x, y) => x.round.at.getTime() - y.round.at.getTime());
}

export async function readinessView(candidateId: string) {
  const [checks, practice, upcoming] = await Promise.all([
    prisma.readinessCheck.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'asc' },
      select: { scores: true, createdAt: true },
    }),
    aptitudePractice(candidateId),
    upcomingRounds(candidateId),
  ]);

  const history = checks.map((c) => {
    const scores = asScores(c.scores);
    return { at: c.createdAt, composite: composite(scores), scores };
  });
  const latest = history.at(-1) ?? null;

  return {
    areas: AREAS.map((a) => ({ key: a, label: AREA_LABELS[a] })),
    questions: CHECK_QUESTIONS,
    latest,
    // Oldest first: a line of the student's own progress, nobody else's.
    history: history.map((h) => ({ at: h.at, composite: h.composite })),
    plan: latest ? planFor(latest.scores) : null,
    practice: {
      attempts: practice.attempts,
      accuracy: practice.attempts ? Math.round((practice.correct / practice.attempts) * 100) : null,
    },
    upcoming,
  };
}

export async function saveReadiness(candidateId: string, answers: Record<string, number>) {
  const unknown = Object.keys(answers).find((k) => !isQuestionKey(k));
  if (unknown) throw badRequest(`There is no question called ${unknown}.`);
  const missing = CHECK_QUESTIONS.filter((q) => typeof answers[q.key] !== 'number');
  if (missing.length > 0) throw badRequest('Answer every statement, even with a guess.');

  const scores = scoreAnswers(answers);
  scores.aptitude = blendAptitude(scores.aptitude, await aptitudePractice(candidateId));
  await prisma.readinessCheck.create({ data: { candidateId, scores } });
  return readinessView(candidateId);
}

/* -------------------------------------------------------------------------- */
/* Aptitude                                                                    */
/* -------------------------------------------------------------------------- */

/** The shared bank plus anything the student's own institution added. */
function bankFor(tenantId: string | undefined): Prisma.AptitudeQuestionWhereInput {
  return { isActive: true, OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])] };
}

const PUBLIC_QUESTION = {
  id: true,
  section: true,
  topic: true,
  difficulty: true,
  stem: true,
  options: true,
} as const;

export async function aptitudeOverview(candidateId: string, tenantId: string | undefined) {
  const [questions, rows] = await Promise.all([
    prisma.aptitudeQuestion.groupBy({ by: ['section', 'topic'], where: bankFor(tenantId), _count: { _all: true } }),
    attemptRows(candidateId),
  ]);
  const stats = topicStats(rows);
  const byTopic = new Map(stats.map((s) => [s.topic, s]));

  const sections = (['QUANT', 'REASONING', 'VERBAL', 'TECHNICAL'] as AptitudeSection[]).map((section) => ({
    section,
    topics: questions
      .filter((q) => q.section === section)
      .map((q) => {
        const s = byTopic.get(q.topic);
        return {
          topic: q.topic,
          questions: q._count._all,
          attempts: s?.attempts ?? 0,
          accuracy: s ? Math.round(s.accuracy * 100) : null,
        };
      })
      .sort((a, b) => a.topic.localeCompare(b.topic)),
  }));

  const correct = rows.filter((r) => r.correct).length;
  return {
    sections,
    totals: { attempts: rows.length, accuracy: rows.length ? Math.round((correct / rows.length) * 100) : null },
    // Weak and overdue first - the review mode serves these.
    weakTopics: stats.slice(0, 5).map((s) => ({
      topic: s.topic,
      section: s.section,
      accuracy: Math.round(s.accuracy * 100),
      attempts: s.attempts,
      lastAt: s.lastAt,
    })),
    toRetry: wrongToRetry(rows).length,
  };
}

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export type SessionMode = 'TOPIC' | 'MIXED' | 'REVIEW';

export const MIXED_SIZE = 20;
export const MIXED_SECONDS = 20 * 60;
const TOPIC_SIZE = 10;

/**
 * A practice set. Answers are never sent with the questions - each one is
 * checked on the server as it is answered, so the explanation arrives with the
 * verdict and a curious look at the network tab gives nothing away.
 */
export async function startSession(
  candidateId: string,
  tenantId: string | undefined,
  input: { mode: SessionMode; section?: AptitudeSection; topic?: string },
) {
  const base = bankFor(tenantId);

  if (input.mode === 'TOPIC') {
    if (!input.topic) throw badRequest('Choose a topic to practise.');
    const pool = await prisma.aptitudeQuestion.findMany({
      where: { ...base, topic: input.topic, ...(input.section ? { section: input.section } : {}) },
      select: PUBLIC_QUESTION,
    });
    if (pool.length === 0) throw notFound('There are no questions on that topic yet.');
    return { mode: input.mode, timeLimitSec: null, questions: shuffle(pool).slice(0, TOPIC_SIZE) };
  }

  if (input.mode === 'MIXED') {
    // Spread across sections the way a first-round test is, technical only when asked for.
    const sections: AptitudeSection[] = input.section ? [input.section] : ['QUANT', 'REASONING', 'VERBAL'];
    const pool = await prisma.aptitudeQuestion.findMany({
      where: { ...base, section: { in: sections } },
      select: PUBLIC_QUESTION,
    });
    const per = Math.ceil(MIXED_SIZE / sections.length);
    const picked = sections.flatMap((s) => shuffle(pool.filter((q) => q.section === s)).slice(0, per));
    return { mode: input.mode, timeLimitSec: MIXED_SECONDS, questions: shuffle(picked).slice(0, MIXED_SIZE) };
  }

  // REVIEW: last-answered-wrong questions first, then fresh questions from the
  // weakest, most overdue topics.
  const rows = await attemptRows(candidateId);
  if (rows.length === 0) throw badRequest('Practise a topic first - review brings back what you found hard.');
  const retryIds = wrongToRetry(rows).slice(0, TOPIC_SIZE);
  const weak = topicStats(rows).slice(0, 3).map((s) => s.topic);
  const [retry, fresh] = await Promise.all([
    prisma.aptitudeQuestion.findMany({ where: { ...base, id: { in: retryIds } }, select: PUBLIC_QUESTION }),
    prisma.aptitudeQuestion.findMany({
      where: { ...base, topic: { in: weak }, id: { notIn: retryIds } },
      select: PUBLIC_QUESTION,
    }),
  ]);
  const order = new Map(retryIds.map((id, i) => [id, i]));
  const first = retry.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    mode: input.mode,
    timeLimitSec: null,
    questions: [...first, ...shuffle(fresh)].slice(0, TOPIC_SIZE),
  };
}

export async function answerQuestion(
  candidateId: string,
  tenantId: string | undefined,
  input: { questionId: string; chosenIndex: number; timeMs?: number },
) {
  const q = await prisma.aptitudeQuestion.findFirst({
    where: { ...bankFor(tenantId), id: input.questionId },
    select: { id: true, answerIndex: true, explanation: true, options: true },
  });
  if (!q) throw notFound('That question is not in your practice bank.');
  const options = Array.isArray(q.options) ? q.options : [];
  if (input.chosenIndex < 0 || input.chosenIndex >= options.length) throw badRequest('Choose one of the options.');

  const correct = input.chosenIndex === q.answerIndex;
  await prisma.aptitudeAttempt.create({
    data: {
      candidateId,
      questionId: q.id,
      chosenIndex: input.chosenIndex,
      correct,
      timeMs: input.timeMs ?? null,
    },
  });
  return { correct, answerIndex: q.answerIndex, explanation: q.explanation };
}

/* -------------------------------------------------------------------------- */
/* The college's view                                                          */
/* -------------------------------------------------------------------------- */

/** Score bands for the distribution - wide enough that no band points at a person. */
const BANDS = [
  { label: '0–39', min: 0, max: 39 },
  { label: '40–59', min: 40, max: 59 },
  { label: '60–79', min: 60, max: 79 },
  { label: '80–100', min: 80, max: 100 },
];

export async function collegeOverview(collegeId: string) {
  const students = await prisma.candidate.findMany({
    where: { collegeId },
    select: {
      id: true,
      batchMemberships: { select: { batch: { select: { id: true, name: true } } } },
      readinessChecks: { orderBy: { createdAt: 'desc' }, take: 1, select: { scores: true } },
    },
  });

  const latest = students
    .filter((s) => s.readinessChecks.length > 0)
    .map((s) => ({ student: s, scores: asScores(s.readinessChecks[0]!.scores) }));

  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  const areas = AREAS.map((a) => ({ key: a, label: AREA_LABELS[a], average: avg(latest.map((l) => l.scores[a])) })).sort(
    (x, y) => (x.average ?? 101) - (y.average ?? 101),
  );

  const batches = new Map<string, { name: string; students: number; checked: number[] }>();
  for (const s of students) {
    const score = s.readinessChecks[0] ? composite(asScores(s.readinessChecks[0].scores)) : null;
    for (const m of s.batchMemberships) {
      const b = batches.get(m.batch.id) ?? { name: m.batch.name, students: 0, checked: [] };
      b.students++;
      if (score !== null) b.checked.push(score);
      batches.set(m.batch.id, b);
    }
  }

  const composites = latest.map((l) => composite(l.scores));
  return {
    students: students.length,
    checked: latest.length,
    checkedPct: students.length ? Math.round((latest.length / students.length) * 100) : 0,
    average: avg(composites),
    distribution: BANDS.map((b) => ({ label: b.label, count: composites.filter((c) => c >= b.min && c <= b.max).length })),
    // Weakest first: the first row is what a workshop should be about.
    areas,
    batches: [...batches.values()]
      .map((b) => ({ name: b.name, students: b.students, checked: b.checked.length, average: avg(b.checked) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
