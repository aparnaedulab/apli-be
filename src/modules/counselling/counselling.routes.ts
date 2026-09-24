import { Router } from 'express';
import { z } from 'zod';
import { CounsellingReason, CounsellingStatus as C } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';

/**
 * Career counselling.
 *
 * The portal already knows when a student has stalled: `atRisk` works it out
 * and tells the college. What it has never had is the other direction - a way
 * for the student to say they need a conversation, about the two decisions
 * that actually need one.
 *
 * Choosing between offers is the first. The one-offer rule means answering
 * closes the others, which makes it irreversible and often the largest
 * decision this person has made. The second is a long run of rejections,
 * which the risk engine sees and the student is deliberately never shown in
 * those words.
 *
 * So the asking is theirs. Nothing here flags anybody.
 */

/** How many conversations one student may have open at once. */
const MAX_OPEN = 2;

const shape = {
  id: true,
  reason: true,
  note: true,
  status: true,
  meetAt: true,
  meetWhere: true,
  outcome: true,
  createdAt: true,
  counsellor: { select: { fullName: true } },
} as const;

/* -------------------------------------------------------------------------- */
/* The student: asking, and reading what was agreed                            */
/* -------------------------------------------------------------------------- */

export const counsellingRouter = Router();
counsellingRouter.use(requireRole('CANDIDATE'));

/** GET /api/candidate/counselling */
counsellingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const requests = await prisma.counsellingRequest.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      select: shape,
    });
    res.json({ requests });
  }),
);

/** POST /api/candidate/counselling */
counsellingRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const body = z
      .object({
        reason: z.nativeEnum(CounsellingReason),
        note: z.string().trim().max(2000).optional().or(z.literal('')),
      })
      .parse(req.body);

    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
      select: { collegeId: true },
    });
    if (!candidate.collegeId) {
      throw badRequest('You are not on a college roster yet, so there is nobody to ask.');
    }

    /* Two at once is enough. More is a queue nobody works through, and it is
       usually the same conversation asked three ways. */
    const open = await prisma.counsellingRequest.count({
      where: { candidateId, status: { in: [C.OPEN, C.BOOKED] } },
    });
    if (open >= MAX_OPEN) {
      throw badRequest(
        'You already have two conversations open. Close one, or wait for it to happen.',
      );
    }

    const request = await prisma.counsellingRequest.create({
      data: {
        candidateId,
        collegeId: candidate.collegeId,
        reason: body.reason,
        note: body.note || null,
      },
      select: shape,
    });

    res.status(201).json({ request });
  }),
);

/** DELETE /api/candidate/counselling/:id — changed their mind. */
counsellingRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const row = await prisma.counsellingRequest.findFirst({
      where: { id: req.params.id!, candidateId, status: { in: [C.OPEN, C.BOOKED] } },
    });
    if (!row) throw notFound('No such request.');

    await prisma.counsellingRequest.update({
      where: { id: row.id },
      data: { status: C.CLOSED },
    });
    res.json({ closed: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* The placement cell: the queue                                               */
/* -------------------------------------------------------------------------- */

export const campusCounsellingRouter = Router();
campusCounsellingRouter.use(requireRole('CAMPUS'));

/** The cell's own college, and nobody else's. */
function collegeOf(req: { session: { collegeId?: string } }): string {
  const id = req.session.collegeId;
  if (!id) throw forbidden('This account is not attached to a college.');
  return id;
}

/** GET /api/campus/counselling */
campusCounsellingRouter.get(
  '/',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = collegeOf(req);
    const requests = await prisma.counsellingRequest.findMany({
      where: { collegeId },
      // Waiting first, then by how long they have waited.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: {
        ...shape,
        candidate: {
          select: {
            id: true,
            user: { select: { fullName: true, email: true } },
            batchMemberships: {
              select: { batch: { select: { name: true } } },
              take: 1,
            },
          },
        },
      },
    });

    res.json({
      requests: requests.map((r) => ({
        ...r,
        candidate: {
          id: r.candidate.id,
          name: r.candidate.user.fullName,
          email: r.candidate.user.email,
          batch: r.candidate.batchMemberships[0]?.batch.name ?? null,
        },
      })),
    });
  }),
);

/**
 * PATCH /api/campus/counselling/:id
 *
 * Pick it up, set a time, or write down what was agreed. The outcome is
 * written for the student to read rather than as a note about them - a
 * conversation that leaves no record cannot be followed up, and the student
 * cannot hold anybody to what was said in it.
 */
campusCounsellingRouter.patch(
  '/:id',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const collegeId = collegeOf(req);
    const body = z
      .object({
        status: z.enum([C.BOOKED, C.DONE, C.CLOSED]).optional(),
        meetAt: z.string().datetime().optional().or(z.literal('')),
        meetWhere: z.string().trim().max(191).optional().or(z.literal('')),
        outcome: z.string().trim().max(4000).optional().or(z.literal('')),
      })
      .parse(req.body);

    const row = await prisma.counsellingRequest.findFirst({
      where: { id: req.params.id!, collegeId },
    });
    if (!row) throw notFound('No such request.');

    if (body.status === C.DONE && !(body.outcome || row.outcome)) {
      throw badRequest('Write down what was agreed, so the student has it too.');
    }

    const request = await prisma.counsellingRequest.update({
      where: { id: row.id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.meetAt !== undefined ? { meetAt: body.meetAt ? new Date(body.meetAt) : null } : {}),
        ...(body.meetWhere !== undefined ? { meetWhere: body.meetWhere || null } : {}),
        ...(body.outcome !== undefined ? { outcome: body.outcome || null } : {}),
        // Whoever touches it owns it.
        counsellorId: req.session.userId!,
      },
      select: shape,
    });

    /*
     * Tell them something happened.
     *
     * A student who asked for help and heard nothing has been told something
     * by the silence, and it is not the thing anybody meant.
     */
    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: row.candidateId },
      select: { userId: true },
    });

    const said =
      request.status === C.BOOKED
        ? {
            title: 'Your placement cell has a time for you',
            body: request.meetAt
              ? `${new Date(request.meetAt).toLocaleString('en-IN')}${
                  request.meetWhere ? ` · ${request.meetWhere}` : ''
                }`
              : 'They will be in touch with a time.',
          }
        : request.status === C.DONE
          ? { title: 'What you agreed is written down', body: 'Open it whenever you need it.' }
          : null;

    if (said) {
      await prisma.notification.create({
        data: {
          userId: candidate.userId,
          type: `counselling.${request.status.toLowerCase()}`,
          title: said.title,
          body: said.body,
          link: '/student/counselling',
          payload: { requestId: request.id },
        },
      });
    }

    res.json({ request });
  }),
);
