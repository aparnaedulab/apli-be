import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent, makeTenant } from './factories.js';
import { mockInterviewRouter } from '../src/modules/mockInterview/mockInterview.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import {
  builtinFeedback,
  countFillers,
  detectStar,
  OFF_LIMITS,
  repeatedPhrase,
  specificsOf,
} from '../src/modules/mockInterview/feedback.js';
import { feedbackFor } from '../src/modules/mockInterview/ai.js';
import { questionById, questionsFor } from '../src/modules/mockInterview/questions.js';

/**
 * Mock interviews. The rules that matter are the ones a demo would not
 * catch: the feedback counts what it says it counts, it never strays onto
 * the person, and a misbehaving AI reviewer never leaves a student without
 * feedback.
 */

const STORY =
  'During my third year internship at a logistics start-up, my task was to cut the time the team spent on weekly reports. ' +
  'I analysed the old spreadsheet, I wrote a Python script that pulled the data from SQL, and I set up a simple dashboard in Power BI. ' +
  'As a result, the report went from six hours to forty minutes a week, which saved about 20 hours a month for three people. ' +
  'My manager then asked me to train two other interns on the script, and we used the same approach for the monthly finance summary. ' +
  'I learned that asking the people who use a report what they read matters more than adding more charts.';

const behavioural = questionById('hr-failure')!;
const intro = questionById('hr-intro')!;

describe('the built-in feedback', () => {
  it('counts filler words, and tells "like" the filler from "like" the verb', () => {
    const f = countFillers('Um, basically I, like, built it. You know, I like Java. Uh, actually it worked.');
    const by = Object.fromEntries(f.map((x) => [x.word, x.count]));
    expect(by).toEqual({ um: 1, uh: 1, basically: 1, actually: 1, 'you know': 1, like: 1 });
  });

  it('finds the parts of a story', () => {
    expect(detectStar(STORY)).toEqual({ situation: true, task: true, action: true, result: true });
    expect(detectStar('I think teamwork is important and I always try my best.')).toEqual({
      situation: false,
      task: false,
      action: false,
      result: false,
    });
  });

  it('notices concrete detail and going in circles', () => {
    expect(specificsOf(STORY)).toEqual(expect.arrayContaining(['python', 'sql', 'power bi']));
    expect(repeatedPhrase('it was good and it was good because it was good')).toBe('it was good');
    expect(repeatedPhrase(STORY)).toBeNull();
  });

  it('scores a full, specific story well and says so', () => {
    const f = builtinFeedback({ question: behavioural, answer: STORY });
    expect(f.source).toBe('builtin');
    expect(f.score).toBeGreaterThanOrEqual(80);
    expect(f.strengths.length).toBeGreaterThanOrEqual(2);
    expect(f.improvements.length).toBeLessThanOrEqual(2);
  });

  it('asks a thin answer for more, and a story without an ending for its result', () => {
    const thin = builtinFeedback({ question: behavioural, answer: 'I failed once in a group project but it was fine.' });
    expect(thin.improvements.map((i) => i.title)).toContain('End with the result');
    expect(thin.score).toBeLessThan(60);
    expect(thin.strengths.length).toBeGreaterThanOrEqual(1);
  });

  it('judges pace only for spoken answers', () => {
    const words = STORY.split(/\s+/).length;
    const spoken = builtinFeedback({ question: behavioural, answer: STORY, mode: 'voice', durationSec: Math.round((words / 130) * 60) });
    expect(spoken.metrics.wpm).toBeGreaterThanOrEqual(120);
    expect(spoken.metrics.wpm).toBeLessThanOrEqual(140);
    const rushed = builtinFeedback({ question: behavioural, answer: STORY, mode: 'voice', durationSec: 20 });
    expect(rushed.improvements.map((i) => i.title)).toContain('Slow down a little');
    expect(builtinFeedback({ question: behavioural, answer: STORY, durationSec: 20 }).metrics.wpm).toBeNull();
  });

  it('never talks about accent, pronunciation or grammar', () => {
    const answers = [STORY, 'um um um uh like, basically, you know', 'x '.repeat(600), 'Hello.'];
    for (const q of [intro, behavioural, questionById('sw-oop')!]) {
      for (const answer of answers) {
        for (const mode of ['typed', 'voice'] as const) {
          const f = builtinFeedback({ question: q, answer, mode, durationSec: 30 });
          const text = [...f.strengths, ...f.improvements.flatMap((i) => [i.title, i.tip])].join(' ');
          expect(OFF_LIMITS.test(text)).toBe(false);
        }
      }
    }
  });
});

describe('AI feedback', () => {
  const good = {
    score: 82,
    strengths: ['You named the tool and the time saved.'],
    improvements: [{ title: 'Open with the result', tip: 'Start with "I cut a six-hour report to forty minutes".' }],
    betterOpening: 'I cut our weekly report from six hours to forty minutes.',
  };

  it('uses the reviewer when it behaves, keeping the measured numbers', async () => {
    const f = await feedbackFor({ question: behavioural, answer: STORY }, async () => good);
    expect(f.source).toBe('ai');
    expect(f.score).toBe(82);
    expect(f.betterOpening).toMatch(/six hours/);
    expect(f.metrics.words).toBeGreaterThan(50);
  });

  it('falls back to the built-in feedback on malformed output, errors, or off-limits comments', async () => {
    const malformed = await feedbackFor({ question: behavioural, answer: STORY }, async () => ({ score: 'high' }));
    expect(malformed).toMatchObject({ source: 'builtin', fellBack: true });

    const thrown = await feedbackFor({ question: behavioural, answer: STORY }, async () => {
      throw new Error('network');
    });
    expect(thrown).toMatchObject({ source: 'builtin', fellBack: true });

    const personal = await feedbackFor({ question: behavioural, answer: STORY }, async () => ({
      ...good,
      improvements: [{ title: 'Work on your accent', tip: 'Practise pronunciation.' }],
    }));
    expect(personal).toMatchObject({ source: 'builtin', fellBack: true });
  });
});

/* -------------------------------------------------------------------------- */
/* The routes                                                                  */
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
  app.use('/mock', mockInterviewRouter);
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

async function student(moduleOn = true) {
  const tenant = await makeTenant();
  if (moduleOn) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'dev.mockInterview', enabled: true } });
  }
  const college = await makeCollege('Interview College', tenant.id);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  return { candidate, call: appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id }) };
}

describe('a practice session', () => {
  it('asks five questions, reviews an answer, and keeps only text', async () => {
    const { call } = await student();

    const options = await call('GET', '/mock/options');
    expect(options.body.aiEnabled).toBe(false);

    const started = await call('POST', '/mock/sessions', { kind: 'HR', role: 'software' });
    expect(started.status).toBe(201);
    const s = started.body.session;
    expect(s.questions).toHaveLength(5);
    expect(s.questions[0].text).toBe('Tell me about yourself.');
    // The same session always asks the same questions.
    expect(questionsFor('HR', 'software', s.id).map((q) => q.id)).toEqual(s.questions.map((q: { id: string }) => q.id));

    const answered = await call('POST', `/mock/sessions/${s.id}/answers`, {
      questionId: s.questions[1].id,
      answer: STORY,
      durationSec: 90,
      mode: 'voice',
    });
    expect(answered.status).toBe(201);
    expect(answered.body.feedback.source).toBe('builtin');
    expect(answered.body.session.answers).toHaveLength(1);

    const again = await call('POST', `/mock/sessions/${s.id}/answers`, { questionId: s.questions[1].id, answer: STORY });
    expect(again.status).toBe(400);

    const stray = await call('POST', `/mock/sessions/${s.id}/answers`, { questionId: 'fn-gst', answer: STORY });
    expect(stray.status).toBe(400);

    const list = await call('GET', '/mock/sessions');
    expect(list.body.sessions[0]).toMatchObject({ answered: 1 });
    expect(list.body.sessions[0].averageScore).toBeGreaterThan(0);
  });

  it('keeps each student’s sessions to themselves', async () => {
    const a = await student();
    const b = await student();
    const started = await a.call('POST', '/mock/sessions', { kind: 'MANAGERIAL', role: 'sales' });
    expect((await b.call('GET', `/mock/sessions/${started.body.session.id}`)).status).toBe(404);
  });

  it('is closed where the institution has not switched it on', async () => {
    const { call } = await student(false);
    expect((await call('GET', '/mock/options')).status).toBe(403);
  });
});
