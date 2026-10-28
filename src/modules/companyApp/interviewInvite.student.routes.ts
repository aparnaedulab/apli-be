import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../lib/errors.js';
import { postMediaUpload } from '../../lib/upload.js';
import { saveTenantAsset } from '../tenants/assets.js';
import { listInvitesForStudent, respondToInvite, saveVideoAnswer } from './interviewInvite.service.js';

/**
 * Student-side interview invite routes: /api/candidate/interview-invites
 *
 * The student sees invites sent to them, accepts or declines, and records
 * their answers to a recorded-interview round.
 */
export const studentInterviewInviteRouter = Router();
studentInterviewInviteRouter.use(requireRole('CANDIDATE'));

const id = z.string().trim().min(1).max(40);

/** GET /api/candidate/interview-invites */
studentInterviewInviteRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ invites: await listInvitesForStudent(requireCandidateId(req)) });
  }),
);

/** POST /api/candidate/interview-invites/:id/respond  { decision: ACCEPTED | DECLINED } */
studentInterviewInviteRouter.post(
  '/:id/respond',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { decision } = z.object({ decision: z.enum(['ACCEPTED', 'DECLINED']) }).parse(req.body);
    await respondToInvite(candidateId, id.parse(req.params.id), decision);
    res.json({ invites: await listInvitesForStudent(candidateId) });
  }),
);

/**
 * POST /api/candidate/interview-invites/:id/answers/:questionId  (multipart: file, seconds)
 * A recorded answer - WebM or MP4, up to 50 MB. Recording again replaces it.
 */
studentInterviewInviteRouter.post(
  '/:id/answers/:questionId',
  postMediaUpload.single('file'),
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    if (!req.file) throw badRequest('Record your answer first.');
    const seconds = z.coerce.number().int().min(0).max(3600).optional().parse(req.body?.seconds || undefined);
    const url = await saveTenantAsset('video', req.file.buffer);
    res.json({
      invites: await saveVideoAnswer(candidateId, id.parse(req.params.id), id.parse(req.params.questionId), url, seconds ?? null),
    });
  }),
);
