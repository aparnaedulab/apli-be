import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import {
  sendInterviewInvite,
  listInvitesForCompany,
  getInviteForCompany,
  recordRoundFeedback,
  withdrawInvite,
} from './interviewInvite.service.js';

/**
 * Company-side interview invite routes: /api/company/interview-invites
 *
 * The company invites a candidate (seen via shared work) to an interview
 * process, tracks which round they are on, and records feedback per round.
 */
export const interviewInviteRouter = Router();
interviewInviteRouter.use(requireRole('COMPANY'));

const inviteSchema = z.object({
  candidateId: z.string().trim().min(1),
  processId: z.string().trim().min(1),
  role: z.string().trim().min(2, 'Enter the role name.').max(120),
  message: z.string().trim().max(1000).optional(),
});

const feedbackSchema = z.object({
  roundOrder: z.coerce.number().int().min(1),
  outcome: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  score: z.coerce.number().min(0).max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/** GET /api/company/interview-invites */
interviewInviteRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ invites: await listInvitesForCompany(requireCompanyId(req)) });
  }),
);

/** POST /api/company/interview-invites */
interviewInviteRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = inviteSchema.parse(req.body);
    const invite = await sendInterviewInvite(requireCompanyId(req), req.session.userId!, data);
    res.status(201).json({ invite });
  }),
);

/** GET /api/company/interview-invites/:id */
interviewInviteRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ invite: await getInviteForCompany(requireCompanyId(req), req.params.id!) });
  }),
);

/** POST /api/company/interview-invites/:id/feedback */
interviewInviteRouter.post(
  '/:id/feedback',
  asyncHandler(async (req, res) => {
    const data = feedbackSchema.parse(req.body);
    const invite = await recordRoundFeedback(requireCompanyId(req), req.params.id!, data);
    res.json({ invite });
  }),
);

/** POST /api/company/interview-invites/:id/withdraw */
interviewInviteRouter.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    await withdrawInvite(requireCompanyId(req), req.params.id!);
    res.json({ ok: true });
  }),
);
