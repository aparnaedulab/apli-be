import { Router } from 'express';
import { z } from 'zod';
import { AssessmentStatus as A } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCompanyId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { ASSIGNMENT_INCLUDE, assign, nextAttempt, serialise } from './assessment.service.js';

/* -------------------------------------------------------------------------- */
/* The company's side: set a test, assign it, record what came back            */
/* -------------------------------------------------------------------------- */

export const companyAssessmentRouter = Router();
companyAssessmentRouter.use(requireRole('COMPANY'));

/**
 * Layer 3 for an assessment: reachable only through the company that set it.
 */
async function owned(companyId: string, id: string) {
  const row = await prisma.assessment.findFirst({ where: { id, companyId } });
  if (!row) throw notFound('No such assessment.');
  return row;
}

const bodySchema = z.object({
  title: z.string().trim().min(2).max(160),
  instructions: z.string().trim().max(4000).optional().or(z.literal('')),
  /* Where it is actually taken. Apli does not host the questions yet, so
     this is the platform the company already uses. */
  url: z.string().trim().url().max(2000).optional().or(z.literal('')),
  durationMin: z.coerce.number().int().min(1).max(600).optional(),
  supervised: z.boolean().default(false),
  retakes: z.coerce.number().int().min(0).max(5).default(0),
});

/** GET /api/company/assessments */
companyAssessmentRouter.get(
  '/',
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const rows = await prisma.assessment.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { assignments: true } } },
    });

    // How many are still owed, so a recruiter can see what is outstanding
    // without opening each one.
    const owed = await prisma.assessmentAssignment.groupBy({
      by: ['assessmentId'],
      where: { assessment: { companyId }, status: A.ASSIGNED },
      _count: true,
    });
    const owedBy = new Map(owed.map((o) => [o.assessmentId, o._count]));

    res.json({
      assessments: rows.map((r) => ({
        id: r.id,
        title: r.title,
        instructions: r.instructions,
        url: r.url,
        durationMin: r.durationMin,
        supervised: r.supervised,
        retakes: r.retakes,
        createdAt: r.createdAt,
        assigned: r._count.assignments,
        outstanding: owedBy.get(r.id) ?? 0,
      })),
    });
  }),
);

/** POST /api/company/assessments */
companyAssessmentRouter.post(
  '/',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const body = bodySchema.parse(req.body);

    const row = await prisma.assessment.create({
      data: {
        companyId,
        title: body.title,
        instructions: body.instructions || null,
        url: body.url || null,
        durationMin: body.durationMin ?? null,
        supervised: body.supervised,
        retakes: body.retakes,
        createdById: req.session.userId!,
      },
    });

    res.status(201).json({ assessment: row });
  }),
);

/**
 * POST /api/company/assessments/:id/assign
 *
 * Assigning is the permission. There is no request-and-approve step: a
 * company does not publish tests and wait for volunteers, and an approval
 * inbox between the two is latency nobody benefits from.
 */
companyAssessmentRouter.post(
  '/:id/assign',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await owned(companyId, req.params.id!);

    const { applicationIds, dueAt } = z
      .object({
        applicationIds: z.array(z.string()).min(1).max(500),
        dueAt: z.string().datetime().optional().or(z.literal('')),
      })
      .parse(req.body);

    /* Only applicants to this company's own roles, whatever was posted. */
    const apps = await prisma.application.findMany({
      where: { id: { in: applicationIds }, job: { companyId } },
      select: { id: true, candidateId: true },
    });
    if (apps.length === 0) throw badRequest('None of those applicants are yours.');

    const result = await assign({
      assessmentId: req.params.id!,
      candidateIds: apps.map((a) => a.candidateId),
      applicationByCandidate: new Map(apps.map((a) => [a.candidateId, a.id])),
      dueAt: dueAt ? new Date(dueAt) : null,
    });

    res.json(result);
  }),
);

/** GET /api/company/assessments/:id/assignments */
companyAssessmentRouter.get(
  '/:id/assignments',
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await owned(companyId, req.params.id!);

    const rows = await prisma.assessmentAssignment.findMany({
      where: { assessmentId: req.params.id! },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      include: {
        ...ASSIGNMENT_INCLUDE,
        candidate: { select: { id: true, user: { select: { fullName: true, email: true } } } },
      },
    });

    res.json({
      assignments: rows.map((r) => ({
        ...serialise(r),
        candidate: { id: r.candidate.id, name: r.candidate.user.fullName, email: r.candidate.user.email },
      })),
    });
  }),
);

/**
 * PATCH /api/company/assessments/assignments/:id
 *
 * What came back. A score on its own is a number nobody can argue with, so
 * feedback rides alongside it and reaches the student with the result.
 */
companyAssessmentRouter.patch(
  '/assignments/:id',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const body = z
      .object({
        status: z.enum([A.PASSED, A.FAILED, A.SUBMITTED]),
        score: z.coerce.number().min(0).max(100000).optional(),
        maxScore: z.coerce.number().min(1).max(100000).optional(),
        feedback: z.string().trim().max(2000).optional().or(z.literal('')),
      })
      .parse(req.body);

    const row = await prisma.assessmentAssignment.findFirst({
      where: { id: req.params.id!, assessment: { companyId } },
    });
    if (!row) throw notFound('No such assignment.');

    const updated = await prisma.assessmentAssignment.update({
      where: { id: row.id },
      data: {
        status: body.status,
        score: body.score ?? null,
        maxScore: body.maxScore ?? null,
        feedback: body.feedback || null,
        reviewedById: req.session.userId!,
        reviewedAt: new Date(),
      },
      include: ASSIGNMENT_INCLUDE,
    });

    res.json({ assignment: serialise(updated) });
  }),
);

/* -------------------------------------------------------------------------- */
/* The student's side: what they owe, and sending it back                      */
/* -------------------------------------------------------------------------- */

export const candidateAssessmentRouter = Router();
candidateAssessmentRouter.use(requireRole('CANDIDATE'));

/** GET /api/candidate/assessments */
candidateAssessmentRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);

    const rows = await prisma.assessmentAssignment.findMany({
      where: { candidateId },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      include: ASSIGNMENT_INCLUDE,
    });

    res.json({ assessments: rows.map(serialise) });
  }),
);

/**
 * POST /api/candidate/assessments/:id/submit
 *
 * The student says they have sat it, and gives whatever the platform gave
 * them back - a reference number, a link, a score slip. Free text, because
 * every external platform names its own differently.
 */
candidateAssessmentRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { ref } = z
      .object({ ref: z.string().trim().min(1).max(191) })
      .parse(req.body);

    const row = await prisma.assessmentAssignment.findFirst({
      where: { id: req.params.id!, candidateId },
    });
    if (!row) throw notFound('No such assessment.');
    if (row.status !== A.ASSIGNED) {
      throw badRequest('This one has already been sent back.');
    }

    const updated = await prisma.assessmentAssignment.update({
      where: { id: row.id },
      data: { status: A.SUBMITTED, submittedRef: ref, submittedAt: new Date() },
      include: ASSIGNMENT_INCLUDE,
    });

    res.json({ assessment: serialise(updated) });
  }),
);

/**
 * POST /api/candidate/assessments/:id/retake
 *
 * The one place an approval genuinely belongs, settled by a rule on the
 * assessment rather than by an inbox somebody has to work through.
 */
candidateAssessmentRouter.post(
  '/:id/retake',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);

    const row = await prisma.assessmentAssignment.findFirst({
      where: { id: req.params.id!, candidateId },
    });
    if (!row) throw notFound('No such assessment.');
    if (row.status === A.ASSIGNED) throw badRequest('You have not sat this one yet.');
    if (row.status === A.PASSED) throw forbidden('You have already cleared this one.');

    const attempt = await nextAttempt(row.id);

    const created = await prisma.assessmentAssignment.create({
      data: {
        assessmentId: row.assessmentId,
        candidateId,
        applicationId: row.applicationId,
        dueAt: row.dueAt,
        attempt,
      },
      include: ASSIGNMENT_INCLUDE,
    });

    res.status(201).json({ assessment: serialise(created) });
  }),
);
