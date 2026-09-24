import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  requireCandidateId,
  requireCollegeId,
  requireCompanyId,
  requireRole,
} from '../../middleware/auth.js';
import { notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import {
  TRACKED_INCLUDE,
  collegeOverdue,
  companyOverdue,
  studentApplications,
  track,
} from './tracker.service.js';

/**
 * The live application tracker: every stage, and who is overdue.
 *
 * Three readers, three fences. The student and the college are inside an
 * institution, so they see this only where the institution has trust.tracker
 * switched on. A company spans every institution and has no tenant of its
 * own, so its view is not gated - a recruiter is held to each college's
 * response time whether or not that college bought the student screen.
 */
export const trackerRouter = Router();

/** GET /api/tracker/applications - the student's own applications, with stages and timeline. */
trackerRouter.get(
  '/applications',
  requireRole('CANDIDATE'),
  requireModule('trust.tracker'),
  asyncHandler(async (req, res) => {
    res.json({ applications: await studentApplications(requireCandidateId(req)) });
  }),
);

/** GET /api/tracker/company - overdue applications on this company's roles, by role. */
trackerRouter.get(
  '/company',
  requireRole('COMPANY'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    res.json(await companyOverdue(requireCompanyId(req)));
  }),
);

/** GET /api/tracker/company/applications/:id - one applicant's stages and timeline, for the company. */
trackerRouter.get(
  '/company/applications/:id',
  requireRole('COMPANY'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await prisma.application.findFirst({
      // Another company's applicant answers exactly like one that does not exist.
      where: { id: req.params.id, job: { companyId } },
      include: TRACKED_INCLUDE,
    });
    if (!app) throw notFound('No such application.');
    res.json({ application: track(app, 'company') });
  }),
);

/** GET /api/tracker/college - companies keeping this college's students waiting. */
trackerRouter.get(
  '/college',
  requireRole('CAMPUS'),
  requireModule('trust.tracker'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    res.json(await collegeOverdue(requireCollegeId(req)));
  }),
);
