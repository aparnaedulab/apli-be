import { Router } from 'express';
import { AptitudeSection } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import {
  aptitudeOverview,
  answerQuestion,
  collegeOverview,
  readinessView,
  saveReadiness,
  startSession,
} from './practice.service.js';

/**
 * Readiness score and plan, and aptitude practice.
 *
 * Student routes are fenced by the module their screen belongs to - an
 * institution can buy practice without the readiness plan, or the other way
 * round. The college overview rides on readiness: it summarises readiness
 * checks, and is counts only.
 */
export const practiceRouter = Router();

/* --- readiness ----------------------------------------------------------- */

/** GET /api/practice/readiness - the check, the latest score, the plan, upcoming rounds. */
practiceRouter.get(
  '/readiness',
  requireRole('CANDIDATE'),
  requireModule('dev.readiness'),
  asyncHandler(async (req, res) => {
    res.json(await readinessView(requireCandidateId(req)));
  }),
);

const answersSchema = z.object({
  answers: z.record(z.string(), z.number().int().min(1).max(5)),
});

/** POST /api/practice/readiness - take (or retake) the check. */
practiceRouter.post(
  '/readiness',
  requireRole('CANDIDATE'),
  requireModule('dev.readiness'),
  asyncHandler(async (req, res) => {
    const { answers } = answersSchema.parse(req.body);
    res.status(201).json(await saveReadiness(requireCandidateId(req), answers));
  }),
);

/* --- aptitude ------------------------------------------------------------ */

/** GET /api/practice/aptitude - topics, own accuracy per topic, weak topics. */
practiceRouter.get(
  '/aptitude',
  requireRole('CANDIDATE'),
  requireModule('dev.aptitude'),
  asyncHandler(async (req, res) => {
    res.json(await aptitudeOverview(requireCandidateId(req), req.session.tenantId));
  }),
);

const sessionSchema = z.object({
  mode: z.enum(['TOPIC', 'MIXED', 'REVIEW']),
  section: z.nativeEnum(AptitudeSection).optional(),
  topic: z.string().trim().max(80).optional(),
});

/** POST /api/practice/aptitude/session - a set of questions, without their answers. */
practiceRouter.post(
  '/aptitude/session',
  requireRole('CANDIDATE'),
  requireModule('dev.aptitude'),
  asyncHandler(async (req, res) => {
    res.json(await startSession(requireCandidateId(req), req.session.tenantId, sessionSchema.parse(req.body)));
  }),
);

const answerSchema = z.object({
  questionId: z.string().min(1),
  chosenIndex: z.number().int().min(0).max(9),
  timeMs: z.number().int().min(0).max(60 * 60 * 1000).optional(),
});

/** POST /api/practice/aptitude/answer - checks one answer and returns the explanation. */
practiceRouter.post(
  '/aptitude/answer',
  requireRole('CANDIDATE'),
  requireModule('dev.aptitude'),
  asyncHandler(async (req, res) => {
    res.json(await answerQuestion(requireCandidateId(req), req.session.tenantId, answerSchema.parse(req.body)));
  }),
);

/* --- the college's view ---------------------------------------------------- */

/** GET /api/practice/college - readiness across the college: counts and averages only. */
practiceRouter.get(
  '/college',
  requireRole('CAMPUS'),
  requireModule('dev.readiness'),
  can('student:read'),
  asyncHandler(async (req, res) => {
    res.json(await collegeOverview(requireCollegeId(req)));
  }),
);
