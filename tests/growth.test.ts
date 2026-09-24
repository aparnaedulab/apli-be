import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent, makeTenant } from './factories.js';
import { growthRouter } from '../src/modules/growth/growth.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { OFF_LIMITS } from '../src/modules/mockInterview/feedback.js';
import { builtinTurn, gdFeedback, nextSpeaker, PERSONAS, topicById, TOPICS, type Turn } from '../src/modules/growth/gd.js';
import { checkEmail, emailFeedback, scenarioById } from '../src/modules/growth/email.js';
import { emailFeedbackFor, gdFeedbackFor, personaTurn } from '../src/modules/growth/growthAi.js';
import { pitchStructure } from '../src/modules/growth/softSkills.js';

/**
 * Group discussion practice, confidence and wellbeing, and the soft skills
 * studio. What matters: the simulated room behaves like a room, feedback
 * notices the things a GD panel notices and never the person's English, a
 * misbehaving AI never leaves the student without an answer, and wellbeing
 * entries are readable by their owner and nobody else.
 */

const at = '2026-09-18T10:00:00.000Z';
const t = (speaker: string, text: string, kind?: 'summary'): Turn => ({ speaker, text, at, ...(kind ? { kind } : {}) });

/* -------------------------------------------------------------------------- */
/* The simulated room                                                          */
/* -------------------------------------------------------------------------- */

describe('built-in participants', () => {
  const topic = topicById('wfh')!;

  it('take turns, progress without repeating, and stay on the topic type', () => {
    let transcript: Turn[] = [t('moderator', 'Your topic is WFH.')];
    for (let i = 0; i < 8; i++) {
      const persona = nextSpeaker(transcript);
      transcript.push(t(persona, builtinTurn(topic, transcript, 'session-1', persona)));
    }
    const speakers = transcript.slice(1).map((x) => x.speaker);
    expect(new Set(speakers).size).toBe(4);
    // The loud one speaks most - the imbalance is part of the practice.
    const count = (k: string) => speakers.filter((s) => s === k).length;
    expect(count('dominant')).toBeGreaterThanOrEqual(count('quiet'));
    // No line is said twice.
    const lines = transcript.slice(1).map((x) => x.text);
    expect(new Set(lines).size).toBe(lines.length);
    // Every line carries one of this topic's own points - even Kabir comes back round.
    const points = [...topic.pro, ...topic.con];
    for (const line of lines) expect(points.some((p) => line.includes(p))).toBe(true);
    // The tangent Kabir drifts to belongs to this topic's type.
    const kabir = transcript.find((x) => x.speaker === 'offtopic')!;
    expect(kabir.text).toMatch(/uncle|product|cricket|shop|company/i);
  });

  it('are deterministic for a session and respond to what the student said', () => {
    const base = [t('moderator', 'Topic.'), t('dominant', 'Opening.'), t('you', 'I think mentorship matters most for freshers.')];
    const a = builtinTurn(topic, base, 'seed', 'data');
    expect(builtinTurn(topic, base, 'seed', 'data')).toBe(a);
    expect(a).toMatch(/mentorship/);
    // The data-minded one asks for evidence rather than inventing numbers.
    expect(a).toMatch(/what would actually settle this/i);
    expect(a).not.toMatch(/\d+\s?%/);
  });

  it('every topic has material for every persona', () => {
    expect(TOPICS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(TOPICS.map((x) => x.type))).toEqual(new Set(['TECH', 'SOCIAL', 'BUSINESS', 'ABSTRACT']));
    for (const topic of TOPICS) {
      for (const p of PERSONAS) expect(builtinTurn(topic, [], 'x', p.key).length).toBeGreaterThan(20);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* GD feedback                                                                 */
/* -------------------------------------------------------------------------- */

describe('GD feedback', () => {
  const good: Turn[] = [
    t('moderator', 'Topic.'),
    t('dominant', 'Look, WFH is obviously better and anyone who disagrees is wrong about everything here.'),
    t('you', 'Building on Arjun’s point, commuting time matters, but for example in my internship I learned most by sitting near seniors.'),
    t('offtopic', 'This reminds me of cricket sponsorship money these days.'),
    t('you', 'Let’s come back to the topic - the real question is what helps a fresher learn fastest.'),
    t('data', 'What would settle this is data on ramp-up time.'),
    t('quiet', 'I feel mentoring matters, but I am not sure.'),
    t('you', 'I agree with Meera - mentoring is the key, and a hybrid start could give both.'),
    t('dominant', 'Fine, but home is still better.'),
    t(
      'you',
      'To summarise, we heard both sides: working from home saves commuting and widens hiring, while the office helps freshers learn from seniors. The group leaned towards a hybrid start for new joiners, with mentoring built in.',
      'summary',
    ),
  ];

  it('notices referencing, bringing it back on topic, examples and the summary - strengths first', () => {
    const f = gdFeedback(good);
    expect(f.metrics.referencedOthers).toBeGreaterThanOrEqual(2);
    expect(f.metrics.broughtBackOnTopic).toBe(true);
    expect(f.metrics.usedExamples).toBe(true);
    expect(f.metrics.summarised).toBe(true);
    expect(f.metrics.enteredAt).toBe(2);
    expect(f.strengths.join(' ')).toMatch(/built on/);
    expect(f.strengths.join(' ')).toMatch(/summarised/);
    expect(f.improvements.length).toBeLessThanOrEqual(2);
    expect(OFF_LIMITS.test(JSON.stringify(f))).toBe(false);
  });

  it('notices dominating, a late entry and a missing summary', () => {
    const long = 'I strongly believe working from home is better for everyone because it saves time and money and effort and energy every single day of the week. '.repeat(3);
    const dominated: Turn[] = [
      t('moderator', 'Topic.'),
      t('dominant', 'Opening point here.'),
      t('data', 'Evidence please.'),
      t('offtopic', 'Cricket.'),
      t('quiet', 'Maybe.'),
      t('dominant', 'Again me.'),
      t('data', 'Data again.'),
      t('you', long),
      t('you', long),
    ];
    const f = gdFeedback(dominated);
    expect(f.metrics.share).toBeGreaterThan(45);
    expect(f.metrics.enteredAt).toBe(7);
    expect(f.metrics.summarised).toBe(false);
    const titles = f.improvements.map((i) => i.title);
    expect(titles).toContain('Come in earlier');
    expect(titles).toContain('Leave room for others');
    expect(f.improvements).toHaveLength(2);
    expect(f.strengths.length).toBeGreaterThan(0);
  });

  it('is kind when the student never spoke', () => {
    const f = gdFeedback([t('moderator', 'Topic.'), t('dominant', 'Me.'), t('data', 'Data.')]);
    expect(f.metrics.contributions).toBe(0);
    expect(f.improvements[0]!.title).toBe('Get in early');
  });
});

/* -------------------------------------------------------------------------- */
/* Email checks                                                                */
/* -------------------------------------------------------------------------- */

describe('email checks', () => {
  const scenario = scenarioById('reschedule')!;
  const good = {
    subject: 'Request to reschedule interview - Demo Student',
    body:
      'Dear Ms Demo Rao,\n\nThank you for scheduling my interview for Tuesday at 11 am. Unfortunately I have a university examination at that time.\n\n' +
      'Would it be possible to reschedule to another slot? I am available on Wednesday afternoon or Thursday morning.\n\nI apologise for the inconvenience.\n\nRegards,\nDemo Student',
  };

  it('passes a well-formed email on every check', () => {
    const checks = checkEmail(scenario, good.subject, good.body);
    expect(checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
    expect(emailFeedback(scenario, good.subject, good.body).score).toBe(100);
  });

  it('catches a missing subject, greeting, ask and sign-off, shorthand and shouting', () => {
    const checks = checkEmail(scenario, 'hi', 'pls tell me if u can do smthing abt my intrvw time, i have exam THAT DAY!!');
    const failed = checks.filter((c) => !c.ok).map((c) => c.key);
    expect(failed).toEqual(expect.arrayContaining(['subject', 'greeting', 'ask', 'length', 'signoff', 'shorthand', 'tone']));
    expect(checks.find((c) => c.key === 'shorthand')!.tip).toMatch(/pls/);
    const f = emailFeedback(scenario, 'hi', 'pls help');
    expect(f.improvements).toHaveLength(2);
    // Without AI, the better version is the scenario's template, placeholders and all.
    expect(f.improved.from).toBe('template');
    expect(f.improved.body).toMatch(/\[Your name\]/);
  });

  it('does not flag ordinary words or degree names', () => {
    const body = good.body.replace('Thank you', 'Thank you. I am a BTECH student and I know R and SQL.');
    expect(checkEmail(scenario, good.subject, body).every((c) => c.ok)).toBe(true);
  });
});

describe('pitch structure', () => {
  it('finds the four beats', () => {
    const parts = pitchStructure(
      'Hi, I am Demo Student, a final year BCom student at Demo College. I built a GST reconciliation sheet in Excel during my internship that cut month-end work by 2 days. ' +
        'I enjoy finance operations, which is why your analyst role interests me. I would love a chance to interview for it.',
    );
    expect(parts.every((p) => p.ok)).toBe(true);
    expect(pitchStructure('Hello everyone.').filter((p) => p.ok)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* AI paths, mocked                                                            */
/* -------------------------------------------------------------------------- */

describe('AI paths fall back safely', () => {
  const topic = topicById('ai-jobs')!;
  const transcript = [t('moderator', 'Topic.'), t('dominant', 'Opening.'), t('you', 'Building on that, for example in my town shops now use AI billing.')];

  it('uses a well-behaved participant writer, and falls back on anything else', async () => {
    const ok = await personaTurn({ topic, persona: 'quiet', transcript, seed: 's' }, async () => ({ text: 'Sorry, can I add - billing tools helped my uncle hire one more person.' }));
    expect(ok.source).toBe('ai');
    for (const bad of [
      async () => ({ words: 'wrong shape' }),
      async () => {
        throw new Error('network');
      },
      async () => ({ text: 'Your accent makes it hard to follow.' }),
      async () => ({ text: 'word '.repeat(200) }),
    ]) {
      const r = await personaTurn({ topic, persona: 'quiet', transcript, seed: 's' }, bad);
      expect(r.source).toBe('builtin');
      expect(r.text.length).toBeGreaterThan(10);
    }
  });

  it('uses a GD review when it behaves, keeping the measured numbers', async () => {
    const good = { score: 71, strengths: ['You linked your point to Arjun’s.'], improvements: [{ title: 'Summarise', tip: 'Offer the summary.' }] };
    const f = await gdFeedbackFor(topic, transcript, async () => good);
    expect(f.source).toBe('ai');
    expect(f.metrics.referencedOthers).toBe(1);

    const bad = await gdFeedbackFor(topic, transcript, async () => ({ ...good, strengths: ['Work on your grammar.'] }));
    expect(bad.source).toBe('builtin');
    expect(bad.fellBack).toBe(true);
    const thrown = await gdFeedbackFor(topic, transcript, async () => {
      throw new Error('refused');
    });
    expect(thrown.fellBack).toBe(true);
  });

  it('shows an AI polish only when it behaves; the checks stay rule-based', async () => {
    const scenario = scenarioById('thank-you')!;
    const polished = await emailFeedbackFor(scenario, 'thx', 'thx for the interview', async () => ({
      subject: 'Thank you - Analyst interview',
      body: 'Dear [Interviewer name],\n\nThank you for your time today.\n\nRegards,\n[Your name]',
      notes: ['Added a greeting and sign-off.'],
    }));
    expect(polished.source).toBe('ai');
    expect(polished.improved.from).toBe('ai');
    expect(polished.checks.find((c) => c.key === 'shorthand')!.ok).toBe(false);

    const failed = await emailFeedbackFor(scenario, 'thx', 'thx', async () => ({ subject: 'x' }));
    expect(failed.fellBack).toBe(true);
    expect(failed.improved.from).toBe('template');
  });
});

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
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
  app.use('/growth', growthRouter);
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

const ALL = ['dev.gd', 'dev.confidence', 'dev.softSkills'];

async function tenantWith(modules: string[]) {
  const tenant = await makeTenant();
  for (const moduleKey of modules) await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey, enabled: true } });
  const college = await makeCollege('Growth College', tenant.id);
  const batch = await makeBatch(college.id);
  return { tenant, college, batch };
}

async function studentIn(ctx: Awaited<ReturnType<typeof tenantWith>>) {
  const { user, candidate } = await makeStudent(ctx.batch.id, { collegeId: ctx.college.id });
  return { candidate, call: appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: ctx.tenant.id }) };
}

describe('a group discussion, end to end', () => {
  it('opens, responds, invites a summary, and gives feedback', async () => {
    const { call } = await studentIn(await tenantWith(ALL));
    const topics = await call('GET', '/growth/gd/topics');
    expect(topics.body.aiEnabled).toBe(false);
    expect(topics.body.personas).toHaveLength(4);

    const started = await call('POST', '/growth/gd/sessions', { topicId: 'cashless' });
    expect(started.status).toBe(201);
    expect(started.body.transcript.map((x: Turn) => x.speaker)).toEqual(['moderator', 'dominant']);
    const id = started.body.id;

    let view = await call('POST', `/growth/gd/sessions/${id}/turns`, { text: 'Building on Arjun’s point, UPI helps, but for example my grandmother still uses cash.' });
    expect(view.status).toBe(200);
    expect(view.body.transcript.at(-1).speaker).not.toBe('you');
    for (let i = 0; i < 12 && view.body.phase === 'discussion'; i++) {
      view = await call('POST', `/growth/gd/sessions/${id}/pass`);
    }
    expect(view.body.phase).toBe('summary');

    const done = await call('POST', `/growth/gd/sessions/${id}/finish`, {
      summary: 'To summarise, both sides agreed digital payments are faster and leave a record, but the group felt people without smartphones or signal must not be left out, so cash should stay as a fallback.',
    });
    expect(done.body.phase).toBe('ended');
    expect(done.body.feedback.source).toBe('builtin');
    expect(done.body.feedback.metrics.summarised).toBe(true);
    expect(done.body.feedback.metrics.referencedOthers).toBe(1);

    expect((await call('POST', `/growth/gd/sessions/${id}/turns`, { text: 'One more thing' })).status).toBe(400);
    const list = await call('GET', '/growth/gd/sessions');
    expect(list.body.sessions[0].score).toBe(done.body.feedback.score);
  });
});

describe('wellbeing', () => {
  it('keeps a student’s entries to that student', async () => {
    const ctx = await tenantWith(ALL);
    const a = await studentIn(ctx);
    const b = await studentIn(ctx);

    expect((await a.call('POST', '/growth/wellbeing/mood', { score: 2, note: 'nervous about Friday' })).status).toBe(201);
    await a.call('POST', '/growth/wellbeing/mood', { score: 4 });
    const win = await a.call('POST', '/growth/wellbeing/wins', { text: 'Cleared the aptitude round at Demo Tech' });
    await a.call('POST', '/growth/wellbeing/ladder', { step: 'aptitude', done: true });
    await a.call('POST', '/growth/wellbeing/ladder', { step: 'gd', done: true });
    await a.call('POST', '/growth/wellbeing/ladder', { step: 'gd', done: false });

    const mine = await a.call('GET', '/growth/wellbeing');
    expect(mine.body.moods.map((m: { score: number }) => m.score)).toEqual([2, 4]);
    expect(mine.body.wins).toHaveLength(1);
    const ladder = Object.fromEntries(mine.body.ladder.map((s: { key: string; done: boolean }) => [s.key, s.done]));
    expect(ladder).toMatchObject({ aptitude: true, gd: false });
    expect(mine.body.recentRejection).toBeNull();

    const theirs = await b.call('GET', '/growth/wellbeing');
    expect(theirs.body.moods).toEqual([]);
    expect(theirs.body.wins).toEqual([]);
    expect(theirs.body.ladder.every((s: { done: boolean }) => !s.done)).toBe(true);
    expect((await b.call('DELETE', `/growth/wellbeing/wins/${win.body.id}`)).status).toBe(404);
    expect((await a.call('DELETE', `/growth/wellbeing/wins/${win.body.id}`)).status).toBe(204);

    expect((await a.call('POST', '/growth/wellbeing/mood', { score: 9 })).status).toBe(400);
  });

  it('has no endpoint for anyone but the student', async () => {
    const ctx = await tenantWith(ALL);
    const a = await studentIn(ctx);
    await a.call('POST', '/growth/wellbeing/mood', { score: 3 });
    for (const role of [Role.CAMPUS, Role.COMPANY, Role.ADMIN]) {
      const other = appFor({ userId: 'someone', role, tenantId: ctx.tenant.id });
      for (const path of ['/growth/wellbeing', '/growth/gd/sessions', '/growth/soft-skills']) {
        expect((await other('GET', path)).status).toBe(403);
      }
    }
    // Nothing in the router is mounted for a campus or company path.
    const paths = (growthRouter.stack as { route?: { path: string } }[]).flatMap((l) => (l.route ? [l.route.path] : []));
    expect(paths.every((p) => p.startsWith('/gd') || p.startsWith('/wellbeing') || p.startsWith('/soft-skills'))).toBe(true);
    expect(paths.some((p) => /campus|college|company|batch|student\//.test(p))).toBe(false);
  });
});

describe('soft skills studio', () => {
  it('reviews speaking, pitch and email, and keeps history per kind', async () => {
    const { call } = await studentIn(await tenantWith(ALL));
    const home = await call('GET', '/growth/soft-skills');
    expect(home.body.dailyPrompt).toBeTruthy();
    expect(home.body.scenarios.length).toBeGreaterThanOrEqual(6);

    const speak = await call('POST', '/growth/soft-skills/speaking', {
      prompt: home.body.dailyPrompt,
      response: 'I would show a visitor the old market in my town because it has sold the same spices for a hundred years, and the stall owners tell you stories about every one.',
      mode: 'typed',
    });
    expect(speak.status).toBe(201);
    expect(speak.body.feedback.source).toBe('builtin');

    const pitch = await call('POST', '/growth/soft-skills/pitch', {
      prompt: home.body.pitchPrompts[0],
      response: 'Hi, I am Demo Student, a final year BCA student. I built an attendance app used by 200 students. I enjoy building tools people use daily, which is why your developer role interests me. I would love a chance to interview.',
      mode: 'voice',
      durationSec: 70,
    });
    expect(pitch.body.feedback.structure.every((p: { ok: boolean }) => p.ok)).toBe(true);
    expect(pitch.body.feedback.seconds).toBe(70);

    const email = await call('POST', '/growth/soft-skills/email', { scenarioId: 'status', subject: 'status', body: 'any update on my interview?? pls reply' });
    expect(email.status).toBe(201);
    expect(email.body.feedback.checks.find((c: { key: string }) => c.key === 'shorthand').ok).toBe(false);
    expect((await call('POST', '/growth/soft-skills/email', { scenarioId: 'nope', subject: 'x', body: 'hello there' })).status).toBe(400);

    const after = await call('GET', '/growth/soft-skills');
    expect(after.body.history.SPEAKING).toHaveLength(1);
    expect(after.body.history.PITCH).toHaveLength(1);
    expect(after.body.history.EMAIL).toHaveLength(1);
  });
});

describe('module switches', () => {
  it('each third is off until its module is on', async () => {
    const { call } = await studentIn(await tenantWith(['dev.gd']));
    expect((await call('GET', '/growth/gd/topics')).status).toBe(200);
    expect((await call('GET', '/growth/wellbeing')).status).toBe(403);
    expect((await call('GET', '/growth/soft-skills')).status).toBe(403);

    const none = await studentIn(await tenantWith([]));
    expect((await none.call('GET', '/growth/gd/topics')).status).toBe(403);
    expect((await none.call('POST', '/growth/wellbeing/mood', { score: 3 })).status).toBe(403);
    expect((await none.call('POST', '/growth/soft-skills/email', { scenarioId: 'status', subject: 'x', body: 'hello' })).status).toBe(403);
  });
});
