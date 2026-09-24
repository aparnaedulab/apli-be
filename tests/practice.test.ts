import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import {
  makeApplication,
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makePosting,
  makeRecruiter,
  makeStudent,
  makeTenant,
  systemRole,
} from './factories.js';
import { practiceRouter } from '../src/modules/practice/practice.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import {
  AREAS,
  CHECK_QUESTIONS,
  PRACTICE_THRESHOLD,
  blendAptitude,
  composite,
  planFor,
  scoreAnswers,
} from '../src/modules/practice/readiness.js';
import { topicStats, wrongToRetry } from '../src/modules/practice/spaced.js';
import { QUESTION_BANK } from '../src/modules/practice/bank.js';
import { seedAptitude } from '../src/scripts/seedAptitude.js';

/**
 * Readiness and aptitude practice.
 *
 * The maths is tested bare, because a wrong score or a wrong "practise this
 * next" is invisible in a demo. The routes are tested for the fences: a
 * college sees only its own students, and a module that is off is off.
 */

const DAY = 24 * 60 * 60 * 1000;

describe('the readiness score', () => {
  const all = (v: number) => Object.fromEntries(CHECK_QUESTIONS.map((q) => [q.key, v]));

  it('maps 1-5 answers onto 0-100 per area, and averages them into one number', () => {
    expect(composite(scoreAnswers(all(1)))).toBe(0);
    expect(composite(scoreAnswers(all(5)))).toBe(100);
    const scores = scoreAnswers({ ...all(3), apt1: 5, apt2: 5, apt3: 5 });
    expect(scores.aptitude).toBe(100);
    expect(scores.technical).toBe(50);
    // (100 + 5 × 50) / 6 = 58.3
    expect(composite(scores)).toBe(58);
  });

  it('lets real practice outweigh the self-rating only once there is enough of it', () => {
    expect(blendAptitude(80, { attempts: PRACTICE_THRESHOLD - 1, correct: 0 })).toBe(80);
    // 0.4 × 80 + 0.6 × 50 = 62
    expect(blendAptitude(80, { attempts: 20, correct: 10 })).toBe(62);
  });

  it('plans the week around the two weakest areas, the same way every time', () => {
    const scores = Object.fromEntries(AREAS.map((a) => [a, 70])) as Record<(typeof AREAS)[number], number>;
    scores.presence = 20;
    scores.interview = 40;
    const plan = planFor(scores);
    expect(plan.focus.map((f) => f.area)).toEqual(['presence', 'interview']);
    expect(plan.tasks.length).toBe(4);
    expect(plan.tasks.every((t) => t.to.startsWith('/student/'))).toBe(true);

    // A tie goes to the order the areas are listed in.
    const flat = Object.fromEntries(AREAS.map((a) => [a, 50])) as typeof scores;
    expect(planFor(flat).focus.map((f) => f.area)).toEqual(['aptitude', 'technical']);
  });
});

describe('spaced repetition', () => {
  const now = new Date('2026-09-20T10:00:00Z');
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
  const row = (questionId: string, topic: string, correct: boolean, daysAgo: number) => ({
    questionId,
    topic,
    section: 'QUANT',
    correct,
    createdAt: at(daysAgo),
  });

  it('puts weak topics first, and brings back a strong topic once it is overdue', () => {
    const rows = [
      // Ratios: always right, practised yesterday - not due.
      row('r1', 'Ratios', true, 1),
      row('r2', 'Ratios', true, 1),
      // Averages: always right, but a month ago - overdue for review.
      row('a1', 'Averages', true, 30),
      row('a2', 'Averages', true, 30),
      // Probability: mostly wrong, today - weakest.
      row('p1', 'Probability', false, 0),
      row('p2', 'Probability', false, 0),
      row('p3', 'Probability', true, 0),
    ];
    const order = topicStats(rows, now).map((s) => s.topic);
    expect(order).toEqual(['Probability', 'Averages', 'Ratios']);
  });

  it('resurfaces questions whose latest answer was wrong, and drops ones since put right', () => {
    const rows = [row('q1', 'X', false, 5), row('q1', 'X', true, 1), row('q2', 'X', false, 3), row('q3', 'X', false, 1)];
    expect(wrongToRetry(rows)).toEqual(['q3', 'q2']);
  });
});

describe('the question bank', () => {
  it('has around sixty well-formed questions across all four sections', () => {
    expect(QUESTION_BANK.length).toBeGreaterThanOrEqual(55);
    for (const q of QUESTION_BANK) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.answerIndex).toBeGreaterThanOrEqual(0);
      expect(q.answerIndex).toBeLessThan(q.options.length);
      expect(q.explanation.length).toBeGreaterThan(10);
    }
    expect(new Set(QUESTION_BANK.map((q) => q.section))).toEqual(new Set(['QUANT', 'REASONING', 'VERBAL', 'TECHNICAL']));
    // No accidental duplicates - the seed matches on section + wording.
    expect(new Set(QUESTION_BANK.map((q) => `${q.section}|${q.stem}`)).size).toBe(QUESTION_BANK.length);
  });

  it('seeds idempotently', async () => {
    const first = await seedAptitude(db);
    expect(first.added).toBe(QUESTION_BANK.length);
    const second = await seedAptitude(db);
    expect(second).toEqual({ added: 0, updated: QUESTION_BANK.length });
    expect(await db.aptitudeQuestion.count()).toBe(QUESTION_BANK.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Through the router                                                          */
/* -------------------------------------------------------------------------- */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function appFor(session: Partial<SessionData>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Partial<SessionData> }).session = { ...session };
    next();
  });
  app.use('/practice', practiceRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function modulesOn(tenantId: string, keys: string[]) {
  for (const moduleKey of keys) await db.tenantModule.create({ data: { tenantId, moduleKey, enabled: true } });
}

async function studentWorld(modules = ['dev.readiness', 'dev.aptitude']) {
  const tenant = await makeTenant();
  await modulesOn(tenant.id, modules);
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id });
  return { tenant, college, batch, candidate, call };
}

const allAnswers = (v: number) => Object.fromEntries(CHECK_QUESTIONS.map((q) => [q.key, v]));

describe('the readiness routes', () => {
  it('saves a check, keeps the history, and blends in practice accuracy', async () => {
    await seedAptitude(db);
    const w = await studentWorld();

    const before = await w.call('GET', '/practice/readiness');
    expect(before.status).toBe(200);
    expect(before.body.latest).toBeNull();

    const partial = await w.call('POST', '/practice/readiness', { answers: { apt1: 3 } });
    expect(partial.status).toBe(400);

    const first = await w.call('POST', '/practice/readiness', { answers: allAnswers(3) });
    expect(first.status).toBe(201);
    expect(first.body.latest.composite).toBe(50);
    expect(first.body.plan.focus).toHaveLength(2);

    // Ten wrong answers on non-technical questions pull aptitude down on the retake.
    const qs = await db.aptitudeQuestion.findMany({ where: { section: 'QUANT' }, take: PRACTICE_THRESHOLD });
    for (const q of qs) {
      const wrong = (q.answerIndex + 1) % (q.options as unknown[]).length;
      const r = await w.call('POST', '/practice/aptitude/answer', { questionId: q.id, chosenIndex: wrong });
      expect(r.body.correct).toBe(false);
      expect(r.body.explanation).toBeTruthy();
    }
    const retake = await w.call('POST', '/practice/readiness', { answers: allAnswers(3) });
    // 0.4 × 50 + 0.6 × 0 = 20
    expect(retake.body.latest.scores.aptitude).toBe(20);
    expect(retake.body.history).toHaveLength(2);
    expect(retake.body.practice).toEqual({ attempts: PRACTICE_THRESHOLD, accuracy: 0 });
  });

  it('builds a countdown plan for a dated round ahead', async () => {
    const w = await studentWorld();
    const drive = await makeDrive(w.college.id, w.batch.id);
    const company = await makeCompany('Demo Analytics');
    const recruiter = await makeRecruiter(company.id);
    const job = await makeJob(company.id, recruiter.id, { rounds: 2 });
    await makePosting(job.id, drive.id);
    const app = await makeApplication(w.candidate.id, job.id, drive.id, ApplicationStatus.IN_ROUND);
    const rounds = await db.round.findMany({ where: { jobId: job.id }, orderBy: { order: 'asc' } });
    await db.application.update({ where: { id: app.id }, data: { currentRoundId: rounds[0]!.id } });
    await db.round.update({
      where: { id: rounds[1]!.id },
      data: { type: 'MCQ_TEST', name: 'Online test', scheduledAt: new Date(Date.now() + 3 * DAY) },
    });

    const res = await w.call('GET', '/practice/readiness');
    expect(res.body.upcoming).toHaveLength(1);
    const plan = res.body.upcoming[0];
    expect(plan.company).toBe('Demo Analytics');
    expect(plan.round.name).toBe('Online test');
    expect(plan.daysUntil).toBe(3);
    expect(plan.steps.some((s: { to: string }) => s.to.startsWith('/student/practice'))).toBe(true);
  });

  it('is off where the institution has not switched it on', async () => {
    const w = await studentWorld(['dev.aptitude']);
    expect((await w.call('GET', '/practice/readiness')).status).toBe(403);
    const other = await studentWorld(['dev.readiness']);
    expect((await other.call('GET', '/practice/aptitude')).status).toBe(403);
  });
});

describe('the aptitude routes', () => {
  it('serves questions without answers, and checks each answer on the server', async () => {
    await seedAptitude(db);
    const w = await studentWorld();

    const topic = await w.call('POST', '/practice/aptitude/session', { mode: 'TOPIC', topic: 'Percentages' });
    expect(topic.status).toBe(200);
    expect(topic.body.questions.length).toBeGreaterThan(0);
    for (const q of topic.body.questions) {
      expect(q.topic).toBe('Percentages');
      expect(q).not.toHaveProperty('answerIndex');
      expect(q).not.toHaveProperty('explanation');
    }

    const mixed = await w.call('POST', '/practice/aptitude/session', { mode: 'MIXED' });
    expect(mixed.body.questions.length).toBe(20);
    expect(mixed.body.timeLimitSec).toBe(1200);
    expect(mixed.body.questions.every((q: { section: string }) => q.section !== 'TECHNICAL')).toBe(true);

    // Review needs something to review.
    expect((await w.call('POST', '/practice/aptitude/session', { mode: 'REVIEW' })).status).toBe(400);
  });

  it('records attempts, reports accuracy per topic, and reviews the wrong ones first', async () => {
    await seedAptitude(db);
    const w = await studentWorld();
    const pct = await db.aptitudeQuestion.findMany({ where: { topic: 'Percentages' }, orderBy: { stem: 'asc' } });
    const ratio = await db.aptitudeQuestion.findFirstOrThrow({ where: { topic: 'Ratios' } });

    await w.call('POST', '/practice/aptitude/answer', { questionId: pct[0]!.id, chosenIndex: pct[0]!.answerIndex });
    const wrong = (pct[1]!.answerIndex + 1) % (pct[1]!.options as unknown[]).length;
    await w.call('POST', '/practice/aptitude/answer', { questionId: pct[1]!.id, chosenIndex: wrong });
    await w.call('POST', '/practice/aptitude/answer', { questionId: ratio.id, chosenIndex: ratio.answerIndex });

    const overview = await w.call('GET', '/practice/aptitude');
    expect(overview.body.totals).toEqual({ attempts: 3, accuracy: 67 });
    const quant = overview.body.sections.find((s: { section: string }) => s.section === 'QUANT');
    expect(quant.topics.find((t: { topic: string }) => t.topic === 'Percentages').accuracy).toBe(50);
    expect(overview.body.weakTopics[0].topic).toBe('Percentages');
    expect(overview.body.toRetry).toBe(1);

    const review = await w.call('POST', '/practice/aptitude/session', { mode: 'REVIEW' });
    expect(review.body.questions[0].id).toBe(pct[1]!.id);

    expect((await w.call('POST', '/practice/aptitude/answer', { questionId: pct[0]!.id, chosenIndex: 9 })).status).toBe(400);
  });

  it('never serves another institution’s own questions', async () => {
    const w = await studentWorld();
    const other = await makeTenant();
    const theirs = await db.aptitudeQuestion.create({
      data: { tenantId: other.id, section: 'QUANT', topic: 'Private', stem: 'Their question', options: ['a', 'b'], answerIndex: 0 },
    });
    expect((await w.call('POST', '/practice/aptitude/session', { mode: 'TOPIC', topic: 'Private' })).status).toBe(404);
    expect((await w.call('POST', '/practice/aptitude/answer', { questionId: theirs.id, chosenIndex: 0 })).status).toBe(404);
  });
});

describe('the college overview', () => {
  it('counts only the college’s own students, and says nothing about any one of them', async () => {
    const w = await studentWorld();
    await w.call('POST', '/practice/readiness', { answers: allAnswers(5) });
    // A second student at the same college who has not taken the check.
    await makeStudent(w.batch.id, { collegeId: w.college.id });
    // A student at another college of the same institution, with a check.
    const elsewhere = await makeCollege('Other College', w.tenant.id);
    const otherBatch = await makeBatch(elsewhere.id);
    const { candidate: stranger } = await makeStudent(otherBatch.id, { collegeId: elsewhere.id });
    await db.readinessCheck.create({ data: { candidateId: stranger.id, scores: scoreAnswers(allAnswers(1)) } });

    const tpo = await db.user.create({
      data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
    });
    await db.campusMember.create({
      data: { userId: tpo.id, collegeId: w.college.id, roleId: (await systemRole('campus.officer')).id },
    });
    const call = appFor({ userId: tpo.id, role: Role.CAMPUS, collegeId: w.college.id, tenantId: w.tenant.id });

    const res = await call('GET', '/practice/college');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ students: 2, checked: 1, checkedPct: 50, average: 100 });
    expect(res.body.distribution.find((d: { label: string }) => d.label === '80–100').count).toBe(1);
    expect(res.body.batches).toEqual([expect.objectContaining({ students: 2, checked: 1, average: 100 })]);
    expect(JSON.stringify(res.body)).not.toContain(w.candidate.id);
  });
});
