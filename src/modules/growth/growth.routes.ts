import { Router } from 'express';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { requireModule } from '../tenants/tenant.context.js';
import { claudeReviewer, feedbackFor } from '../mockInterview/ai.js';
import type { Feedback } from '../mockInterview/feedback.js';
import {
  discussionTurns,
  nextSpeaker,
  openingLine,
  PERSONAS,
  seeded,
  SUMMARY_PROMPT,
  topicById,
  TOPICS,
  TURNS_BEFORE_SUMMARY,
  type GdFeedback,
  type GdTopic,
  type Turn,
} from './gd.js';
import { scenarioById, SCENARIOS, type EmailFeedback } from './email.js';
import {
  aiEnabled,
  claudeEmailPolisher,
  claudeGdReviewer,
  claudeTurnWriter,
  emailFeedbackFor,
  gdFeedbackFor,
  personaTurn,
} from './growthAi.js';
import { LADDER } from './wellbeing.js';
import { dailyPrompt, PITCH_PROMPTS, pitchQuestion, pitchStructure, speakingQuestion, type PitchPart } from './softSkills.js';

/**
 * Deeper practice for students: group discussions (dev.gd), confidence and
 * wellbeing (dev.confidence) and the soft skills studio (dev.softSkills).
 *
 * Everything here is the student's own. There is deliberately no campus or
 * company endpoint in this module: nobody else can see a mood check-in, a win,
 * a practice ladder, a GD transcript or an email draft, and the only way to
 * read one is to be signed in as the student who wrote it. Each third has its
 * own module switch, so an institution can turn on GD practice without the
 * wellbeing space, or the reverse.
 */
export const growthRouter = Router();
growthRouter.use(requireRole(Role.CANDIDATE));
growthRouter.use('/gd', requireModule('dev.gd'));
growthRouter.use('/wellbeing', requireModule('dev.confidence'));
growthRouter.use('/soft-skills', requireModule('dev.softSkills'));

const json = (v: unknown) => v as Prisma.InputJsonValue;
const now = () => new Date().toISOString();

/* ========================================================================== */
/* Group discussion                                                           */
/* ========================================================================== */

/** A discussion ends up long enough to learn from, not so long it drags. */
const MAX_TURNS = 40;

async function ownGd(candidateId: string, id: string) {
  const s = await prisma.gdSession.findFirst({ where: { id, candidateId } });
  if (!s) throw notFound('That discussion does not exist.');
  return s;
}

type GdRow = Awaited<ReturnType<typeof ownGd>>;
const transcriptOf = (s: GdRow) => (s.transcript as unknown as Turn[]) ?? [];
const topicOf = (s: GdRow): GdTopic => topicById(s.topic) ?? TOPICS[0]!;
const summaryInvited = (t: Turn[]) => t.some((x) => x.speaker === 'moderator' && x.text === SUMMARY_PROMPT);

function gdView(s: GdRow) {
  const transcript = transcriptOf(s);
  const topic = topicOf(s);
  return {
    id: s.id,
    topic: { id: topic.id, title: topic.title, type: topic.type },
    transcript,
    phase: s.endedAt ? 'ended' : summaryInvited(transcript) ? 'summary' : 'discussion',
    feedback: (s.feedback as unknown as GdFeedback | null) ?? null,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
  };
}

/**
 * Adds participant turns to the discussion. Once it is long enough, the
 * moderator asks for a summary instead, and the participants stop.
 */
async function addPersonaTurns(sessionId: string, topic: GdTopic, transcript: Turn[], count: number): Promise<Turn[]> {
  const out = [...transcript];
  const writer = aiEnabled() ? claudeTurnWriter : null;
  for (let i = 0; i < count; i++) {
    if (summaryInvited(out)) break;
    if (discussionTurns(out).length >= TURNS_BEFORE_SUMMARY) {
      out.push({ speaker: 'moderator', text: SUMMARY_PROMPT, at: now() });
      break;
    }
    const persona = nextSpeaker(out);
    const { text } = await personaTurn({ topic, persona, transcript: out, seed: sessionId }, writer);
    out.push({ speaker: persona, text, at: now() });
  }
  if (!summaryInvited(out) && discussionTurns(out).length >= TURNS_BEFORE_SUMMARY) {
    out.push({ speaker: 'moderator', text: SUMMARY_PROMPT, at: now() });
  }
  return out;
}

/** GET /api/growth/gd/topics - topics and the people in the room. */
growthRouter.get(
  '/gd/topics',
  asyncHandler(async (_req, res) => {
    res.json({
      topics: TOPICS.map((t) => ({ id: t.id, title: t.title, type: t.type })),
      personas: PERSONAS.map((p) => ({ key: p.key, name: p.name, trait: p.trait })),
      aiEnabled: aiEnabled(),
    });
  }),
);

/** GET /api/growth/gd/sessions - my past discussions, newest first. */
growthRouter.get(
  '/gd/sessions',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const rows = await prisma.gdSession.findMany({ where: { candidateId }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json({
      sessions: rows.map((s) => {
        const f = s.feedback as unknown as GdFeedback | null;
        return { id: s.id, topic: topicOf(s).title, createdAt: s.createdAt, endedAt: s.endedAt, score: f?.score ?? null };
      }),
    });
  }),
);

const startGd = z.object({ topicId: z.string().optional() });

/** POST /api/growth/gd/sessions - the moderator reads out the topic and someone jumps in. */
growthRouter.post(
  '/gd/sessions',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { topicId } = startGd.parse(req.body ?? {});
    let topic: GdTopic;
    if (topicId) {
      const found = topicById(topicId);
      if (!found) throw badRequest('Choose a topic from the list.');
      topic = found;
    } else {
      topic = TOPICS[Math.floor(Math.random() * TOPICS.length)]!;
    }
    const created = await prisma.gdSession.create({ data: { candidateId, topic: topic.id, transcript: json([]) } });
    // Arjun always gets in first - the student learns to come in second, early.
    const transcript = await addPersonaTurns(created.id, topic, [{ speaker: 'moderator', text: openingLine(topic), at: now() }], 1);
    const saved = await prisma.gdSession.update({ where: { id: created.id }, data: { transcript: json(transcript) } });
    res.status(201).json(gdView(saved));
  }),
);

/** GET /api/growth/gd/sessions/:id */
growthRouter.get(
  '/gd/sessions/:id',
  asyncHandler(async (req, res) => {
    res.json(gdView(await ownGd(requireCandidateId(req), req.params.id!)));
  }),
);

const turnSchema = z.object({
  text: z.string().trim().min(2, 'Say something first.').max(1500, 'Keep a GD point shorter than that - others need a turn.'),
});

function assertOpen(s: GdRow) {
  if (s.endedAt) throw badRequest('This discussion has ended. Start a new one to practise again.');
  if (transcriptOf(s).length >= MAX_TURNS) throw badRequest('This discussion is long enough - time to summarise.');
}

/** POST /api/growth/gd/sessions/:id/turns - the student speaks; one or two others respond. */
growthRouter.post(
  '/gd/sessions/:id/turns',
  asyncHandler(async (req, res) => {
    const s = await ownGd(requireCandidateId(req), req.params.id!);
    assertOpen(s);
    const { text } = turnSchema.parse(req.body);
    const transcript: Turn[] = [...transcriptOf(s), { speaker: 'you', text, at: now() }];
    // Usually one reply, sometimes two - a real room does not wait politely.
    const replies = seeded(`${s.id}:${transcript.length}`)() < 0.4 ? 2 : 1;
    const next = summaryInvited(transcript) ? transcript : await addPersonaTurns(s.id, topicOf(s), transcript, replies);
    const saved = await prisma.gdSession.update({ where: { id: s.id }, data: { transcript: json(next) } });
    res.json(gdView(saved));
  }),
);

/** POST /api/growth/gd/sessions/:id/pass - the student listens; the next person speaks. */
growthRouter.post(
  '/gd/sessions/:id/pass',
  asyncHandler(async (req, res) => {
    const s = await ownGd(requireCandidateId(req), req.params.id!);
    assertOpen(s);
    const next = await addPersonaTurns(s.id, topicOf(s), transcriptOf(s), 1);
    const saved = await prisma.gdSession.update({ where: { id: s.id }, data: { transcript: json(next) } });
    res.json(gdView(saved));
  }),
);

const finishSchema = z.object({ summary: z.string().trim().max(2000).optional() });

/** POST /api/growth/gd/sessions/:id/finish - an optional closing summary, then feedback. */
growthRouter.post(
  '/gd/sessions/:id/finish',
  asyncHandler(async (req, res) => {
    const s = await ownGd(requireCandidateId(req), req.params.id!);
    if (s.endedAt) throw badRequest('This discussion has already ended.');
    const { summary } = finishSchema.parse(req.body ?? {});
    const transcript = [...transcriptOf(s)];
    if (summary && summary.length >= 2) transcript.push({ speaker: 'you', text: summary, at: now(), kind: 'summary' });
    const feedback = await gdFeedbackFor(topicOf(s), transcript, aiEnabled() ? claudeGdReviewer : null);
    const saved = await prisma.gdSession.update({
      where: { id: s.id },
      data: { transcript: json(transcript), feedback: json(feedback), endedAt: new Date() },
    });
    res.json(gdView(saved));
  }),
);

/* ========================================================================== */
/* Confidence & wellbeing                                                     */
/* ========================================================================== */

type LadderKey = (typeof LADDER)[number]['key'];
const ladderKeys = LADDER.map((s) => s.key) as [LadderKey, ...LadderKey[]];

const DAY = 86_400_000;

/** GET /api/growth/wellbeing - everything on the page, for this student only. */
growthRouter.get(
  '/wellbeing',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const since = new Date(Date.now() - 30 * DAY);
    const [ladderRows, wins, moods, rejection] = await Promise.all([
      prisma.wellbeingEntry.findMany({ where: { candidateId, kind: 'LADDER' }, orderBy: { createdAt: 'asc' } }),
      prisma.wellbeingEntry.findMany({ where: { candidateId, kind: 'WIN' }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.wellbeingEntry.findMany({ where: { candidateId, kind: 'MOOD', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } }),
      prisma.application.findFirst({
        where: { candidateId, status: 'REJECTED', updatedAt: { gte: new Date(Date.now() - 14 * DAY) } },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true, job: { select: { title: true, company: { select: { name: true } } } } },
      }),
    ]);

    // Later rows win: the latest tick or untick of each step is its state.
    const done = new Map<string, boolean>();
    for (const r of ladderRows) {
      const v = r.value as { step?: string; done?: boolean };
      if (v.step) done.set(v.step, Boolean(v.done));
    }

    res.json({
      ladder: LADDER.map((s) => ({ ...s, done: done.get(s.key) ?? false })),
      wins: wins.map((w) => ({ id: w.id, text: (w.value as { text: string }).text, createdAt: w.createdAt })),
      moods: moods.map((m) => {
        const v = m.value as { score: number; note?: string };
        return { id: m.id, score: v.score, note: v.note ?? null, createdAt: m.createdAt };
      }),
      recentRejection: rejection ? { role: rejection.job.title, company: rejection.job.company.name, at: rejection.updatedAt } : null,
    });
  }),
);

const ladderSchema = z.object({ step: z.enum(ladderKeys), done: z.boolean() });

/** POST /api/growth/wellbeing/ladder - tick (or untick) a step. */
growthRouter.post(
  '/wellbeing/ladder',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const value = ladderSchema.parse(req.body);
    await prisma.wellbeingEntry.create({ data: { candidateId, kind: 'LADDER', value: json(value) } });
    res.status(201).json(value);
  }),
);

const winSchema = z.object({ text: z.string().trim().min(2, 'Write a few words about it.').max(500) });

/** POST /api/growth/wellbeing/wins - something that went well, however small. */
growthRouter.post(
  '/wellbeing/wins',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { text } = winSchema.parse(req.body);
    const row = await prisma.wellbeingEntry.create({ data: { candidateId, kind: 'WIN', value: json({ text }) } });
    res.status(201).json({ id: row.id, text, createdAt: row.createdAt });
  }),
);

/** DELETE /api/growth/wellbeing/wins/:id - a student can always take one back. */
growthRouter.delete(
  '/wellbeing/wins/:id',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const gone = await prisma.wellbeingEntry.deleteMany({ where: { id: req.params.id!, candidateId, kind: 'WIN' } });
    if (gone.count === 0) throw notFound('That entry does not exist.');
    res.status(204).end();
  }),
);

const moodSchema = z.object({
  score: z.number().int().min(1).max(5),
  note: z.string().trim().max(300).optional(),
});

/** POST /api/growth/wellbeing/mood - a one-tap check-in. */
growthRouter.post(
  '/wellbeing/mood',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { score, note } = moodSchema.parse(req.body);
    const row = await prisma.wellbeingEntry.create({
      data: { candidateId, kind: 'MOOD', value: json(note ? { score, note } : { score }) },
    });
    res.status(201).json({ id: row.id, score, note: note ?? null, createdAt: row.createdAt });
  }),
);

/* ========================================================================== */
/* Soft skills studio                                                         */
/* ========================================================================== */

type SoftKind = 'SPEAKING' | 'PITCH' | 'EMAIL';

/** GET /api/growth/soft-skills - today's prompts, email scenarios, and my history per kind. */
growthRouter.get(
  '/soft-skills',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const rows = await prisma.softSkillAttempt.findMany({ where: { candidateId }, orderBy: { createdAt: 'desc' }, take: 90 });
    const history = (kind: SoftKind) =>
      rows
        .filter((r) => r.kind === kind)
        .slice(0, 20)
        .map((r) => ({ id: r.id, prompt: r.prompt, response: r.response, feedback: r.feedback, createdAt: r.createdAt }));
    res.json({
      dailyPrompt: dailyPrompt(),
      pitchPrompts: PITCH_PROMPTS,
      scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, brief: s.brief })),
      history: { SPEAKING: history('SPEAKING'), PITCH: history('PITCH'), EMAIL: history('EMAIL') },
      aiEnabled: aiEnabled(),
    });
  }),
);

const spokenSchema = z.object({
  prompt: z.string().trim().min(3).max(300),
  response: z.string().trim().min(3, 'Say or type your answer first.').max(6000, 'That is too long to review.'),
  durationSec: z.number().int().min(0).max(1800).optional(),
  mode: z.enum(['typed', 'voice']).default('typed'),
});

/** POST /api/growth/soft-skills/speaking - feedback from the mock-interview engine. */
growthRouter.post(
  '/soft-skills/speaking',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const b = spokenSchema.parse(req.body);
    const feedback = await feedbackFor(
      { question: speakingQuestion(b.prompt), answer: b.response, durationSec: b.durationSec ?? null, mode: b.mode },
      aiEnabled() ? claudeReviewer : null,
    );
    const row = await prisma.softSkillAttempt.create({
      data: { candidateId, kind: 'SPEAKING', prompt: b.prompt, response: b.response, feedback: json(feedback) },
    });
    res.status(201).json({ id: row.id, feedback });
  }),
);

export interface PitchFeedback extends Feedback {
  structure: PitchPart[];
  seconds: number | null;
}

/** POST /api/growth/soft-skills/pitch - the interview engine, plus the four beats of a pitch. */
growthRouter.post(
  '/soft-skills/pitch',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const b = spokenSchema.parse(req.body);
    const base = await feedbackFor(
      { question: pitchQuestion(b.prompt), answer: b.response, durationSec: b.durationSec ?? null, mode: b.mode },
      aiEnabled() ? claudeReviewer : null,
    );
    const structure = pitchStructure(b.response);
    const feedback: PitchFeedback = { ...base, structure, seconds: b.mode === 'voice' ? (b.durationSec ?? null) : null };
    const row = await prisma.softSkillAttempt.create({
      data: { candidateId, kind: 'PITCH', prompt: b.prompt, response: b.response, feedback: json(feedback) },
    });
    res.status(201).json({ id: row.id, feedback });
  }),
);

const emailSchema = z.object({
  scenarioId: z.string(),
  subject: z.string().trim().max(200).default(''),
  body: z.string().trim().min(5, 'Write the email first.').max(5000, 'That is too long for this practice.'),
});

/** POST /api/growth/soft-skills/email - rule checks, and a better version to compare with. */
growthRouter.post(
  '/soft-skills/email',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const b = emailSchema.parse(req.body);
    const scenario = scenarioById(b.scenarioId);
    if (!scenario) throw badRequest('Choose a situation from the list.');
    const feedback: EmailFeedback = await emailFeedbackFor(scenario, b.subject, b.body, aiEnabled() ? claudeEmailPolisher : null);
    const row = await prisma.softSkillAttempt.create({
      data: {
        candidateId,
        kind: 'EMAIL',
        prompt: scenario.title,
        response: `Subject: ${b.subject}\n\n${b.body}`,
        feedback: json(feedback),
      },
    });
    res.status(201).json({ id: row.id, feedback });
  }),
);
