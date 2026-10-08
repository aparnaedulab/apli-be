import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { requireModule } from '../tenants/tenant.context.js';
import { aiEnabled, claudeReviewer, feedbackFor } from './ai.js';
import type { Feedback } from './feedback.js';
import { isRole, KINDS, questionsFor, ROLES, type InterviewKind, type Question, type RoleKey } from './questions.js';
import { questionsForNewSession } from './bank.js';

/**
 * Mock interviews with feedback (dev.mockInterview).
 *
 * Only text is kept: the question, what the student typed or what their
 * browser transcribed, and the feedback. No audio ever reaches the server.
 */
export const mockInterviewRouter = Router();
mockInterviewRouter.use(requireRole(Role.CANDIDATE), requireModule('dev.mockInterview'));

const startSchema = z.object({
  kind: z.enum(['HR', 'TECHNICAL', 'MANAGERIAL']),
  role: z.string().refine(isRole, 'Choose a role from the list.'),
});

const answerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().trim().min(3, 'Answer the question first.').max(6000, 'That answer is too long to review.'),
  durationSec: z.number().int().min(0).max(1800).optional(),
  mode: z.enum(['typed', 'voice']).default('typed'),
});

async function ownSession(candidateId: string, id: string) {
  const session = await prisma.mockInterviewSession.findFirst({
    where: { id, candidateId },
    include: { answers: { orderBy: { createdAt: 'asc' } } },
  });
  if (!session) throw notFound('That practice session does not exist.');
  return session;
}

type SessionRow = Awaited<ReturnType<typeof ownSession>>;

/**
 * The session's questions: the ones stored when it started, or - for a
 * session from before they were stored - the built-in ones it was seeded with.
 */
function askedIn(session: SessionRow): Question[] {
  const stored = session.questions as unknown as Question[] | null;
  if (Array.isArray(stored) && stored.length > 0) return stored;
  return questionsFor(session.kind as InterviewKind, session.role as RoleKey, session.id);
}

function view(session: SessionRow) {
  const questions = askedIn(session).map((q) => ({
    id: q.id,
    text: q.text,
    type: q.type,
    idealWords: q.ideal,
  }));
  const answers = session.answers.map((a) => ({
    id: a.id,
    question: a.question,
    answer: a.answer,
    durationSec: a.durationSec,
    feedback: a.feedback as unknown as Feedback,
    createdAt: a.createdAt,
  }));
  return {
    id: session.id,
    kind: session.kind,
    role: session.role,
    createdAt: session.createdAt,
    questions,
    answers,
    averageScore: average(answers.map((a) => a.feedback.score)),
  };
}

const average = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** GET /api/mock-interviews/options - what can be practised, and whether AI feedback is on. */
mockInterviewRouter.get(
  '/options',
  asyncHandler(async (_req, res) => {
    res.json({ kinds: KINDS, roles: ROLES, aiEnabled: aiEnabled() });
  }),
);

/** GET /api/mock-interviews/sessions - past sessions, newest first, with their average score. */
mockInterviewRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const sessions = await prisma.mockInterviewSession.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { answers: { select: { feedback: true } } },
    });
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        kind: s.kind,
        role: s.role,
        createdAt: s.createdAt,
        answered: s.answers.length,
        averageScore: average(s.answers.map((a) => (a.feedback as unknown as Feedback).score)),
      })),
    });
  }),
);

/** POST /api/mock-interviews/sessions - start one; its five questions come back with it. */
mockInterviewRouter.post(
  '/sessions',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { kind, role } = startSchema.parse(req.body);
    const created = await prisma.mockInterviewSession.create({ data: { candidateId, kind, role } });
    // Fixed now, from the institution's own bank (or the defaults), so later
    // edits to the bank cannot change a session in progress.
    const questions = await questionsForNewSession(req.session.tenantId, kind, role as RoleKey, created.id);
    await prisma.mockInterviewSession.update({
      where: { id: created.id },
      data: { questions: questions as unknown as object },
    });
    res.status(201).json({ session: view(await ownSession(candidateId, created.id)) });
  }),
);

/** GET /api/mock-interviews/sessions/:id */
mockInterviewRouter.get(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    res.json({ session: view(await ownSession(candidateId, req.params.id!)) });
  }),
);

/** POST /api/mock-interviews/sessions/:id/answers - answer one question, get feedback. */
mockInterviewRouter.post(
  '/sessions/:id/answers',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const session = await ownSession(candidateId, req.params.id!);
    const input = answerSchema.parse(req.body);

    const question = askedIn(session).find((q) => q.id === input.questionId);
    if (!question) throw badRequest('That question is not part of this session.');
    if (session.answers.some((a) => a.question === question.text)) {
      throw badRequest('You have already answered that one. Move on to the next question.');
    }

    const feedback = await feedbackFor(
      { question, answer: input.answer, durationSec: input.durationSec, mode: input.mode },
      aiEnabled() ? claudeReviewer : null,
    );

    await prisma.mockAnswer.create({
      data: {
        sessionId: session.id,
        question: question.text,
        answer: input.answer,
        durationSec: input.durationSec ?? null,
        feedback: feedback as unknown as object,
      },
    });

    res.status(201).json({ feedback, session: view(await ownSession(candidateId, session.id)) });
  }),
);
