import { Router } from 'express';
import { JobReportReason, JobReportStatus, JobStatus, PostingStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import { explainIneligibility, loadCandidateContext, visibleJobWhere } from '../jobs/visibility.js';
import { jobText, scanForFeeDemand } from './scam.js';

/**
 * Scam shield and "why can I not apply?" - the student-facing trust checks.
 *
 * Each route fences itself: the account type first, then the module the
 * institution bought, then the college or student the rows belong to. The
 * company-side scan is not fenced by module - a company writes for every
 * institution at once, and warning it costs nobody anything.
 */
export const trustRouter = Router();

/* -------------------------------------------------------------------------- */
/* Why can I not apply?                                                        */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/trust/not-eligible
 *
 * Roles the student's own college has let into one of the student's drives,
 * still open, that the student cannot see - each with the reasons. Only ever
 * roles already inside their own drives: nothing here tells a student about a
 * role at another college, or one their college declined.
 */
trustRouter.get(
  '/not-eligible',
  requireRole('CANDIDATE'),
  requireModule('trust.whyNot'),
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const ctx = await loadCandidateContext(candidateId);
    if (ctx.placementIds.length === 0) {
      res.json({ roles: [] });
      return;
    }

    const [visible, applied] = await Promise.all([
      prisma.job.findMany({ where: visibleJobWhere(ctx), select: { id: true } }),
      prisma.application.findMany({ where: { candidateId }, select: { jobId: true } }),
    ]);
    const skip = new Set([...visible.map((j) => j.id), ...applied.map((a) => a.jobId)]);

    const jobs = await prisma.job.findMany({
      where: {
        id: { notIn: [...skip] },
        status: JobStatus.PUBLISHED,
        deadline: { gte: new Date() },
        postings: { some: { status: PostingStatus.ACCEPTED, placementId: { in: ctx.placementIds } } },
      },
      orderBy: { deadline: 'asc' },
      include: {
        company: { select: { name: true } },
        courses: { select: { course: true } },
        specialisations: { select: { specialisation: true } },
        gradYears: { select: { year: true } },
        postings: {
          where: { status: PostingStatus.ACCEPTED, placementId: { in: ctx.placementIds } },
          select: {
            placementId: true,
            placement: { select: { name: true } },
            batches: { select: { batchId: true } },
          },
        },
      },
    });

    res.json({
      roles: jobs
        .map((j) => ({
          id: j.id,
          title: j.title,
          companyName: j.company.name,
          deadline: j.deadline,
          reasons: explainIneligibility(ctx, j),
        }))
        // A role that fails no stated rule is not something to explain; it
        // can only be a timing edge (a deadline passing mid-request).
        .filter((r) => r.reasons.length > 0),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Scam shield                                                                 */
/* -------------------------------------------------------------------------- */

const scanSchema = z.object({ text: z.string().max(40_000) });

/**
 * POST /api/trust/scan - does this text ask students to pay?
 *
 * For the company writing a role (warned while typing) and the college
 * reading one. Pure: nothing is stored.
 */
trustRouter.post(
  '/scan',
  requireRole('COMPANY', 'CAMPUS', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const { text } = scanSchema.parse(req.body);
    res.json({ hits: scanForFeeDemand(text) });
  }),
);

const reportSchema = z.object({
  reason: z.nativeEnum(JobReportReason),
  note: z.string().trim().max(1000).optional().or(z.literal('')),
});

/**
 * POST /api/trust/jobs/:id/report - a student flags a role.
 *
 * Only a role the student can actually reach - one in their own drives - may
 * be reported, and a second report from the same student updates the first
 * rather than piling up. It goes to their own college.
 */
trustRouter.post(
  '/jobs/:id/report',
  requireRole('CANDIDATE'),
  requireModule('trust.scamShield'),
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const body = reportSchema.parse(req.body);
    const ctx = await loadCandidateContext(candidateId);

    const job = await prisma.job.findFirst({
      where: {
        id: req.params.id,
        postings: { some: { status: PostingStatus.ACCEPTED, placementId: { in: ctx.placementIds } } },
      },
      select: { id: true },
    });
    if (!job) throw notFound('This role is not available to you.');

    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
      select: { collegeId: true },
    });

    const report = await prisma.jobReport.upsert({
      where: { jobId_candidateId: { jobId: job.id, candidateId } },
      update: {
        reason: body.reason,
        note: body.note || null,
        // A fresh report reopens one the college had closed: something new is
        // being said about it.
        status: JobReportStatus.OPEN,
        reviewedAt: null,
        reviewedById: null,
      },
      create: {
        jobId: job.id,
        candidateId,
        collegeId: candidate.collegeId,
        reason: body.reason,
        note: body.note || null,
      },
      select: { id: true, reason: true, status: true, createdAt: true },
    });

    res.status(201).json({ report });
  }),
);

/** A role the caller's college has a posting for, or nothing. */
async function jobAtCollege(jobId: string, collegeId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, postings: { some: { placement: { collegeId } } } },
    include: { terms: { orderBy: { order: 'asc' }, select: { text: true } } },
  });
  if (!job) throw notFound('No such role at your college.');
  return job;
}

const REPORT_SELECT = {
  id: true,
  jobId: true,
  reason: true,
  note: true,
  status: true,
  createdAt: true,
  reviewedAt: true,
  candidate: { select: { user: { select: { fullName: true } } } },
  job: { select: { title: true, company: { select: { name: true } } } },
} as const;

type ReportRow = {
  id: string;
  jobId: string;
  reason: JobReportReason;
  note: string | null;
  status: JobReportStatus;
  createdAt: Date;
  reviewedAt: Date | null;
  candidate: { user: { fullName: string } };
  job: { title: string; company: { name: string } };
};

const reportView = (r: ReportRow) => ({
  id: r.id,
  jobId: r.jobId,
  jobTitle: r.job.title,
  companyName: r.job.company.name,
  reason: r.reason,
  note: r.note,
  status: r.status,
  createdAt: r.createdAt,
  reviewedAt: r.reviewedAt,
  studentName: r.candidate.user.fullName,
});

/**
 * GET /api/trust/jobs/:id/signals - what the college should know before it
 * decides on a role: any sentence asking students to pay, and what its own
 * students have reported.
 */
trustRouter.get(
  '/jobs/:id/signals',
  requireRole('CAMPUS'),
  requireModule('trust.scamShield'),
  can('posting:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const job = await jobAtCollege(req.params.id!, collegeId);
    const reports = await prisma.jobReport.findMany({
      where: { jobId: job.id, collegeId },
      orderBy: { createdAt: 'desc' },
      select: REPORT_SELECT,
    });
    res.json({ hits: scanForFeeDemand(jobText(job)), reports: reports.map(reportView) });
  }),
);

/** GET /api/trust/reports?jobId= - the college's own students' reports. */
trustRouter.get(
  '/reports',
  requireRole('CAMPUS'),
  requireModule('trust.scamShield'),
  can('posting:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const { jobId, status } = z
      .object({ jobId: z.string().optional(), status: z.nativeEnum(JobReportStatus).optional() })
      .parse(req.query);
    const reports = await prisma.jobReport.findMany({
      where: { collegeId, ...(jobId ? { jobId } : {}), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      select: REPORT_SELECT,
    });
    res.json({ reports: reports.map(reportView) });
  }),
);

/** POST /api/trust/reports/:id/review - the college has looked at it. */
trustRouter.post(
  '/reports/:id/review',
  requireRole('CAMPUS'),
  requireModule('trust.scamShield'),
  can('posting:decide'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const { status } = z
      .object({ status: z.enum([JobReportStatus.REVIEWED, JobReportStatus.DISMISSED]) })
      .parse(req.body);

    const found = await prisma.jobReport.findFirst({ where: { id: req.params.id, collegeId }, select: { id: true } });
    if (!found) throw notFound('No such report at your college.');

    const report = await prisma.jobReport.update({
      where: { id: found.id },
      data: { status, reviewedAt: new Date(), reviewedById: req.session.userId! },
      select: REPORT_SELECT,
    });
    res.json({ report: reportView(report) });
  }),
);
