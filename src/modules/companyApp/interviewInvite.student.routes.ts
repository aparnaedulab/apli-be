import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { unauthorized } from '../../lib/errors.js';
import { listInvitesForStudent, respondToInvite } from './interviewInvite.service.js';

/**
 * Student-side interview invite routes: /api/candidate/interview-invites
 *
 * The student sees invites sent to them and accepts or declines.
 */
export const studentInterviewInviteRouter = Router();
studentInterviewInviteRouter.use(requireRole('CANDIDATE'));

async function myCandidateId(userId: string): Promise<string> {
  const c = await prisma.candidate.findUnique({ where: { userId }, select: { id: true } });
  if (!c) throw unauthorized('Candidate profile not found.');
  return c.id;
}

/** GET /api/candidate/interview-invites */
studentInterviewInviteRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const candidateId = await myCandidateId(req.session.userId!);
    res.json({ invites: await listInvitesForStudent(candidateId) });
  }),
);

/** POST /api/candidate/interview-invites/:id/respond  { decision: ACCEPTED | DECLINED } */
studentInterviewInviteRouter.post(
  '/:id/respond',
  asyncHandler(async (req, res) => {
    const candidateId = await myCandidateId(req.session.userId!);
    const { decision } = z
      .object({ decision: z.enum(['ACCEPTED', 'DECLINED']) })
      .parse(req.body);
    await respondToInvite(candidateId, req.params.id!, decision);
    res.json({ invites: await listInvitesForStudent(candidateId) });
  }),
);
