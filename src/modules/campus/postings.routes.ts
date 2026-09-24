import { Router } from 'express';
import { z } from 'zod';
import { JobStatus, PostingStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { eligibilityOf } from '../jobs/job.service.js';
import { labelsFor } from '../jobs/job.options.js';
import { canPublish } from '../company/verification.js';
import { can } from '../roles/can.js';

export const postingsRouter = Router();

postingsRouter.use(requireRole('CAMPUS'));

/**
 * Layer 3, as a query. A posting belongs to this college only through its
 * drive, so the scope check reaches two levels down rather than trusting an id.
 *
 * Drafts are excluded everywhere: a company targets colleges while still
 * editing, and those PENDING rows must not surface until the job is published.
 */
async function ownedPosting(collegeId: string, postingId: string) {
  const posting = await prisma.jobPosting.findFirst({
    where: {
      id: postingId,
      placement: { collegeId },
      job: { status: { not: JobStatus.DRAFT } },
    },
  });
  if (!posting) throw notFound('No such job request.');
  return posting;
}

const declineSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Tell the recruiter why, so they can fix it or try elsewhere.')
    .max(500),
});

/**
 * GET /api/campus/postings
 * The placement officer's inbox. Defaults to what still needs a decision.
 */
postingsRouter.get(
  '/',
  can('posting:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const status = z
      .enum(['PENDING', 'ACCEPTED', 'DECLINED', 'ALL'])
      .default('PENDING')
      .parse(req.query.status ?? 'PENDING');

    const postings = await prisma.jobPosting.findMany({
      where: {
        placement: { collegeId },
        job: { status: { not: JobStatus.DRAFT } },
        ...(status === 'ALL' ? {} : { status: status as PostingStatus }),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        placement: { select: { id: true, name: true, year: true } },
        job: {
          select: {
            id: true,
            title: true,
            jobType: true,
            workMode: true,
            location: true,
            openings: true,
            payPeriod: true,
            ctcMin: true,
            ctcMax: true,
            ctcFixed: true,
            stipendPerMonth: true,
            deadline: true,
            status: true,
            company: { select: { name: true, status: true } },
            _count: { select: { rounds: true } },
          },
        },
      },
    });

    res.json({
      postings: postings.map((p) => ({
        id: p.id,
        status: p.status,
        decidedAt: p.decidedAt,
        declineReason: p.declineReason,
        placementName: p.placement.name,
        placementYear: p.placement.year,
        jobId: p.job.id,
        title: p.job.title,
        jobType: p.job.jobType,
        workMode: p.job.workMode,
        location: p.job.location,
        openings: p.job.openings,
        payPeriod: p.job.payPeriod,
        ctcMin: p.job.ctcMin,
        ctcMax: p.job.ctcMax,
        ctcFixed: p.job.ctcFixed,
        stipendPerMonth: p.job.stipendPerMonth,
        deadline: p.job.deadline,
        jobStatus: p.job.status,
        companyName: p.job.company.name,
        companyVerified: canPublish(p.job.company.status),
        roundCount: p.job._count.rounds,
      })),
    });
  }),
);

/** GET /api/campus/postings/:id — everything needed to make the call */
postingsRouter.get(
  '/:id',
  can('posting:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    await ownedPosting(collegeId, req.params.id!);

    const posting = await prisma.jobPosting.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        placement: {
          select: {
            id: true,
            name: true,
            year: true,
            batches: {
              select: {
                id: true,
                name: true,
                course: true,
                graduationYear: true,
                _count: { select: { memberships: true } },
              },
            },
          },
        },
        decidedBy: { select: { fullName: true } },
        job: {
          include: {
            company: { select: { name: true, website: true, about: true, status: true } },
            rounds: { orderBy: { order: 'asc' } },
            courses: true,
            specialisations: true,
            gradYears: true,
            skills: { include: { skill: { select: { id: true, name: true } } } },
            // The college fields the complaints about these, so it sees them
            // before it accepts anything.
            terms: { orderBy: { order: 'asc' } },
          },
        },
      },
    });

    // How many students in this drive would actually see the role, so the
    // officer knows whether accepting it is worth anything.
    const gradYears = posting.job.gradYears.map((g) => g.year);
    const batchIds = posting.placement.batches.map((b) => b.id);
    const eligible = batchIds.length
      ? await prisma.batchMembership.count({
          where: {
            batchId: { in: batchIds },
            isFrozen: true,
            batch: gradYears.length ? { graduationYear: { in: gradYears } } : undefined,
          },
        })
      : 0;

    // What the company calls its own round kinds, which it may have renamed
    // or invented - the college reads the words, not the stored keys.
    const label = await labelsFor(posting.job.companyId);

    res.json({
      posting: {
        id: posting.id,
        status: posting.status,
        decidedAt: posting.decidedAt,
        decidedBy: posting.decidedBy?.fullName ?? null,
        declineReason: posting.declineReason,
        placement: {
          id: posting.placement.id,
          name: posting.placement.name,
          year: posting.placement.year,
          batches: posting.placement.batches.map((b) => ({
            id: b.id,
            name: b.name,
            course: b.course,
            graduationYear: b.graduationYear,
            studentCount: b._count.memberships,
          })),
        },
        eligibleCount: eligible,
        job: {
          ...posting.job,
          ...eligibilityOf(posting.job),
          terms: posting.job.terms.map((t) => t.text),
          jobTypeLabel: label('EMPLOYMENT_TYPE', posting.job.jobType),
          workModeLabel: label('WORK_MODE', posting.job.workMode),
          rounds: posting.job.rounds.map((r) => ({
            ...r,
            typeLabel: label('ROUND_TYPE', r.type),
            modeLabel: label('ROUND_MODE', r.mode),
          })),
        },
      },
    });
  }),
);

/** POST /api/campus/postings/:id/accept */
postingsRouter.post(
  '/:id/accept',
  can('posting:decide'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const posting = await ownedPosting(collegeId, req.params.id!);

    if (posting.status !== PostingStatus.PENDING) {
      throw conflict(`You have already ${posting.status.toLowerCase()} this role.`);
    }

    const updated = await prisma.jobPosting.update({
      where: { id: posting.id },
      data: {
        status: PostingStatus.ACCEPTED,
        decidedById: req.session.userId!,
        decidedAt: new Date(),
        declineReason: null,
      },
    });

    res.json({ posting: updated });
  }),
);

/** POST /api/campus/postings/:id/decline — a reason is required */
postingsRouter.post(
  '/:id/decline',
  can('posting:decide'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const posting = await ownedPosting(collegeId, req.params.id!);

    if (posting.status !== PostingStatus.PENDING) {
      throw conflict(`You have already ${posting.status.toLowerCase()} this role.`);
    }

    const { reason } = declineSchema.parse(req.body);

    const updated = await prisma.jobPosting.update({
      where: { id: posting.id },
      data: {
        status: PostingStatus.DECLINED,
        decidedById: req.session.userId!,
        decidedAt: new Date(),
        declineReason: reason,
      },
    });

    res.json({ posting: updated });
  }),
);
