import { Router } from 'express';
import { z } from 'zod';
import { CampusDriveStatus } from '@prisma/client';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireRole } from '../../middleware/auth.js';
import { forbidden } from '../../lib/errors.js';
import { can } from '../roles/can.js';
import {
  attachJob,
  close,
  companyJobs,
  confirmJob,
  createDrive,
  detachJob,
  driveRoster,
  eligibilityReport,
  invite,
  listForCollege,
  invitableCompanies,
  listForCompany,
  open,
  openDrivesFor,
  pendingInvitationCount,
  register,
  registrations,
  respond,
  schedule,
  setCriteria,
  unregister,
  withdrawInvite,
} from './drive.service.js';

/**
 * Three routers, because a drive means three different things.
 *
 * To the cell it is something being arranged. To the company it is an
 * invitation with numbers attached. To a student it is a day with a name on it
 * that they can put themselves down for. Each gets only what it should.
 */

/* --- the college ---------------------------------------------------------- */

export const campusDrivesRouter = Router();
campusDrivesRouter.use(requireRole('CAMPUS'));

/**
 * What a cell may set when arranging a visit: who, which season, and what to
 * call it. Not the bar - that is the company's, and it sets it on the
 * invitation. A schema that accepted criteria here would leave a way for a
 * college to decide who a recruiter may consider, which is the one thing
 * campus hiring is never confused about.
 */
const driveSchema = z.object({
  placementId: z.string().min(1),
  companyId: z.string().min(1),
  title: z.string().trim().min(3, 'Give the drive a name.').max(160),
  pitch: z.string().trim().max(4000).optional().nullable(),
});

campusDrivesRouter.get(
  '/',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const status = z.nativeEnum(CampusDriveStatus).optional().parse(req.query.status || undefined);
    res.json({ drives: await listForCollege(requireCollegeId(req), status) });
  }),
);

/** Who the cell can ask. Names and ids only - it is a picker, not a directory. */
campusDrivesRouter.get(
  '/companies',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const q = z.string().trim().max(100).optional().parse(req.query.q || undefined);
    res.json({ companies: await invitableCompanies(q) });
  }),
);

campusDrivesRouter.post(
  '/',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const drive = await createDrive(requireCollegeId(req), driveSchema.parse(req.body));
    res.status(201).json({ drive });
  }),
);

/**
 * The same report the company will see.
 *
 * The cell can read it too, and should: inviting a company to a campus where
 * four people clear the bar is a conversation worth having before the
 * invitation rather than after the refusal.
 */
campusDrivesRouter.get(
  '/:id/eligibility',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const drives = await listForCollege(requireCollegeId(req));
    if (!drives.some((d) => d.id === req.params.id)) throw forbidden('Not your drive.');
    res.json({ report: await eligibilityReport(req.params.id!) });
  }),
);

campusDrivesRouter.post(
  '/:id/invite',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    res.json({ drive: await invite(requireCollegeId(req), req.params.id!) });
  }),
);

campusDrivesRouter.post(
  '/:id/withdraw',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    res.json({ drive: await withdrawInvite(requireCollegeId(req), req.params.id!) });
  }),
);

campusDrivesRouter.post(
  '/:id/schedule',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        scheduledAt: z.string().datetime(),
        addressLine: z.string().trim().max(500).optional().nullable(),
        meetingLink: z.string().trim().max(500).optional().nullable(),
      })
      .parse(req.body);
    const drive = await schedule(requireCollegeId(req), req.params.id!, {
      scheduledAt: new Date(body.scheduledAt),
      addressLine: body.addressLine,
      meetingLink: body.meetingLink,
    });
    res.json({ drive });
  }),
);

campusDrivesRouter.post(
  '/:id/open',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    res.json({ drive: await open(requireCollegeId(req), req.params.id!) });
  }),
);

campusDrivesRouter.post(
  '/:id/close',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    res.json({ drive: await close(requireCollegeId(req), req.params.id!) });
  }),
);

/** This company's roles, to choose from when building the day. */
campusDrivesRouter.get(
  '/:id/company-jobs',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    res.json({ jobs: await companyJobs(requireCollegeId(req), req.params.id!) });
  }),
);

campusDrivesRouter.post(
  '/:id/jobs',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.body);
    res.json({ drive: await attachJob(requireCollegeId(req), req.params.id!, jobId) });
  }),
);

campusDrivesRouter.delete(
  '/:id/jobs/:jobId',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    res.json({ drive: await detachJob(requireCollegeId(req), req.params.id!, req.params.jobId!) });
  }),
);

/** Who has put their name down. The cell's list, and nobody else's. */
campusDrivesRouter.get(
  '/:id/registrations',
  can('student:read'),
  asyncHandler(async (req, res) => {
    res.json({ registrations: await registrations(requireCollegeId(req), req.params.id!) });
  }),
);

/* --- the company ---------------------------------------------------------- */

export const companyDrivesRouter = Router();
companyDrivesRouter.use(requireRole('COMPANY'));

function companyOf(req: { session: { companyId?: string } }): string {
  const id = req.session.companyId;
  if (!id) throw forbidden('This account is not attached to a company.');
  return id;
}

companyDrivesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ drives: await listForCompany(companyOf(req)) });
  }),
);

/** Just the number, for the badge. Cheap enough to ask for on every page. */
companyDrivesRouter.get(
  '/pending-count',
  asyncHandler(async (req, res) => {
    res.json({ count: await pendingInvitationCount(companyOf(req)) });
  }),
);

/**
 * The numbers behind an invitation.
 *
 * Counts only, and only for an invitation addressed to this company. There is
 * no route anywhere that hands a company the students themselves.
 */
companyDrivesRouter.get(
  '/:id/eligibility',
  asyncHandler(async (req, res) => {
    const mine = await listForCompany(companyOf(req));
    if (!mine.some((d) => d.id === req.params.id)) throw forbidden('Not your invitation.');
    res.json({ report: await eligibilityReport(req.params.id!) });
  }),
);

/** The company setting the bar it actually wants. Only while it is undecided. */
companyDrivesRouter.patch(
  '/:id/criteria',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        minCgpa: z.coerce.number().min(0).max(10).nullable().optional(),
        minDegreePct: z.coerce.number().min(0).max(100).nullable().optional(),
        maxBacklogs: z.coerce.number().int().min(0).max(50).nullable().optional(),
        maxActiveBacklogs: z.coerce.number().int().min(0).max(50).nullable().optional(),
        courses: z.array(z.string().trim().min(1)).max(50).optional(),
        branches: z.array(z.string().trim().min(1)).max(100).optional(),
        gradYears: z.array(z.coerce.number().int().min(2000).max(2100)).max(20).optional(),
      })
      .parse(req.body);
    const drive = await setCriteria(companyOf(req), req.params.id!, body);
    res.json({ drive, report: await eligibilityReport(drive.id) });
  }),
);

/**
 * Who the company will meet.
 *
 * Students who put their own name down for this drive and granted the consent
 * that shares their profile with companies. Anyone who has not is counted, not
 * named.
 */
companyDrivesRouter.get(
  '/:id/students',
  asyncHandler(async (req, res) => {
    res.json(await driveRoster(companyOf(req), req.params.id!));
  }),
);

/** Standing behind a role the college put on the day. */
companyDrivesRouter.post(
  '/:id/jobs/:jobId/confirm',
  asyncHandler(async (req, res) => {
    await confirmJob(companyOf(req), req.params.id!, req.params.jobId!);
    res.status(204).end();
  }),
);

companyDrivesRouter.post(
  '/:id/respond',
  asyncHandler(async (req, res) => {
    const body = z
      .object({ accept: z.boolean(), reason: z.string().trim().max(1000).optional() })
      .parse(req.body);
    const drive = await respond(companyOf(req), req.params.id!, body.accept, body.reason);
    res.json({ drive });
  }),
);

/* --- the student ---------------------------------------------------------- */

export const candidateDrivesRouter = Router();
candidateDrivesRouter.use(requireRole('CANDIDATE'));

candidateDrivesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ drives: await openDrivesFor(requireCandidateId(req)) });
  }),
);

candidateDrivesRouter.post(
  '/:id/register',
  asyncHandler(async (req, res) => {
    await register(requireCandidateId(req), req.params.id!);
    res.json({ drives: await openDrivesFor(requireCandidateId(req)) });
  }),
);

candidateDrivesRouter.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    await unregister(requireCandidateId(req), req.params.id!);
    res.json({ drives: await openDrivesFor(requireCandidateId(req)) });
  }),
);
