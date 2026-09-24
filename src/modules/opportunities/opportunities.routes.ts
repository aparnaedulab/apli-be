import { Router } from 'express';
import { MicroProjectStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireCompanyId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import {
  EVENT_KINDS,
  adjustEvent,
  applyToProject,
  collegesOffering,
  companyProjectDetail,
  companyJobsForEvents,
  companyWeekCollege,
  companyWeeks,
  completeApplication,
  completedMicroInternships,
  confirmPayment,
  createCollegeEvent,
  createProject,
  decideApplication,
  decideWeek,
  deleteCollegeEvent,
  deliver,
  finishWeek,
  inviteToEvent,
  listCompanyProjects,
  markAttendance,
  markPaid,
  proposeWeek,
  publishedSimulations,
  register,
  setProjectStatus,
  studentProjects,
  unregister,
  updateCollegeEvent,
  updateProject,
  updateProposedWeek,
  verifiedCompanyOrThrow,
  weeksForCollege,
  weeksForStudent,
  withdrawApplication,
  withdrawProposedWeek,
} from './opportunities.service.js';

/**
 * Micro-internships and campus weeks.
 *
 * Every route fences itself: account type, then - for students and colleges,
 * who belong to an institution - that institution's module, then the
 * capability. Companies are not inside an institution, so campus weeks check
 * the chosen college's institution instead, and both features ask that the
 * company is verified.
 */
export const opportunitiesRouter = Router();

const micro = requireModule('proof.microInternships');
const weeks = requireModule('showcase.campusWeeks');

/* ========================================================================== */
/* Micro-internships - companies                                               */
/* ========================================================================== */

const projectSchema = z.object({
  title: z.string().trim().min(4, 'Give the project a title.').max(140),
  brief: z.string().trim().min(40, 'Describe the work in a few sentences - what to make and what "done" looks like.').max(5000),
  // Micro means small: long enough to be real work, short enough to fit
  // round a student's classes.
  hours: z.number().int().min(10, 'At least 10 hours - shorter is a task, not a project.').max(40, 'At most 40 hours.'),
  // No unpaid work. A project that pays nothing is not offered here at all.
  stipend: z.number().positive('Every micro-internship is paid. Enter the stipend.').max(500_000),
  skills: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  slots: z.number().int().min(1).max(50).default(1),
  deadline: z.coerce.date(),
});

/** GET /api/opportunities/company/micro */
opportunitiesRouter.get(
  '/company/micro',
  requireRole('COMPANY'),
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    res.json({ projects: await listCompanyProjects(companyId) });
  }),
);

/** POST /api/opportunities/company/micro - a new project, as a draft. */
opportunitiesRouter.post(
  '/company/micro',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    res.status(201).json({ project: await createProject(companyId, projectSchema.parse(req.body)) });
  }),
);

/** GET /api/opportunities/company/micro/:id - the project and its applicants. */
opportunitiesRouter.get(
  '/company/micro/:id',
  requireRole('COMPANY'),
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    res.json(await companyProjectDetail(companyId, req.params.id!));
  }),
);

/** PUT /api/opportunities/company/micro/:id */
opportunitiesRouter.put(
  '/company/micro/:id',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    res.json({ project: await updateProject(companyId, req.params.id!, projectSchema.parse(req.body)) });
  }),
);

/** POST /api/opportunities/company/micro/:id/status - open, close or complete. */
opportunitiesRouter.post(
  '/company/micro/:id/status',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    const { status } = z
      .object({ status: z.enum([MicroProjectStatus.OPEN, MicroProjectStatus.CLOSED, MicroProjectStatus.COMPLETED]) })
      .parse(req.body);
    res.json({ project: await setProjectStatus(companyId, req.params.id!, status) });
  }),
);

/** POST /api/opportunities/company/micro/applications/:id/decision */
opportunitiesRouter.post(
  '/company/micro/applications/:id/decision',
  requireRole('COMPANY'),
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    const { action } = z.object({ action: z.enum(['SELECT', 'REJECT']) }).parse(req.body);
    res.json(await decideApplication(companyId, req.params.id!, action));
  }),
);

/** POST /api/opportunities/company/micro/applications/:id/complete - rate the work. */
opportunitiesRouter.post(
  '/company/micro/applications/:id/complete',
  requireRole('COMPANY'),
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    const { rating, review } = z
      .object({
        rating: z.number().int().min(1).max(5),
        review: z.string().trim().min(10, 'A sentence or two - the student sees it and it becomes part of their proof.').max(1000),
      })
      .parse(req.body);
    await completeApplication(companyId, req.params.id!, rating, review);
    res.status(204).end();
  }),
);

/**
 * POST /api/opportunities/company/micro/applications/:id/paid
 * The company saying it has paid - paid outside the platform.
 */
opportunitiesRouter.post(
  '/company/micro/applications/:id/paid',
  requireRole('COMPANY'),
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    await markPaid(companyId, req.params.id!);
    res.status(204).end();
  }),
);

/* ========================================================================== */
/* Micro-internships - students                                                */
/* ========================================================================== */

/** GET /api/opportunities/micro - open projects and my applications. */
opportunitiesRouter.get(
  '/micro',
  requireRole('CANDIDATE'),
  micro,
  asyncHandler(async (req, res) => {
    res.json(await studentProjects(requireCandidateId(req)));
  }),
);

/** GET /api/opportunities/micro/completed - my completed ones, as proof of work. */
opportunitiesRouter.get(
  '/micro/completed',
  requireRole('CANDIDATE'),
  micro,
  asyncHandler(async (req, res) => {
    res.json({ completed: await completedMicroInternships(requireCandidateId(req)) });
  }),
);

/** POST /api/opportunities/micro/:id/apply */
opportunitiesRouter.post(
  '/micro/:id/apply',
  requireRole('CANDIDATE'),
  micro,
  asyncHandler(async (req, res) => {
    const { pitch } = z
      .object({ pitch: z.string().trim().min(40, 'Say in a few sentences why you are right for this.').max(800) })
      .parse(req.body);
    const app = await applyToProject(requireCandidateId(req), req.params.id!, pitch);
    res.status(201).json({ application: { id: app.id, status: app.status } });
  }),
);

/** POST /api/opportunities/micro/applications/:id/withdraw */
opportunitiesRouter.post(
  '/micro/applications/:id/withdraw',
  requireRole('CANDIDATE'),
  micro,
  asyncHandler(async (req, res) => {
    await withdrawApplication(requireCandidateId(req), req.params.id!);
    res.status(204).end();
  }),
);

/** POST /api/opportunities/micro/applications/:id/deliver - hand in the work. */
opportunitiesRouter.post(
  '/micro/applications/:id/deliver',
  requireRole('CANDIDATE'),
  micro,
  asyncHandler(async (req, res) => {
    const { deliverable } = z
      .object({ deliverable: z.string().trim().min(10, 'Link to your work, or describe what you handed over.').max(4000) })
      .parse(req.body);
    await deliver(requireCandidateId(req), req.params.id!, deliverable);
    res.status(204).end();
  }),
);

/** POST /api/opportunities/micro/applications/:id/confirm-paid */
opportunitiesRouter.post(
  '/micro/applications/:id/confirm-paid',
  requireRole('CANDIDATE'),
  micro,
  asyncHandler(async (req, res) => {
    await confirmPayment(requireCandidateId(req), req.params.id!);
    res.status(204).end();
  }),
);

/* ========================================================================== */
/* Campus weeks - companies                                                    */
/* ========================================================================== */

const eventSchema = z.object({
  kind: z.enum(EVENT_KINDS),
  title: z.string().trim().min(3).max(140),
  startsAt: z.coerce.date(),
  durationMin: z.number().int().min(15).max(480).default(60),
  where: z.string().trim().max(300).optional().or(z.literal('')),
  simulationId: z.string().trim().optional().or(z.literal('')),
  /** The role this session is about, where it is about one. */
  jobId: z.string().trim().optional().or(z.literal('')),
});

const weekSchema = z.object({
  collegeId: z.string().min(1),
  title: z.string().trim().min(4, 'Give the week a title.').max(140),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  events: z.array(eventSchema).min(1, 'Plan at least one session.').max(20),
});

function toWeekInput(d: z.infer<typeof weekSchema>) {
  return {
    ...d,
    message: d.message || undefined,
    events: d.events.map((e) => ({
      ...e,
      where: e.where || undefined,
      simulationId: e.simulationId || undefined,
      jobId: e.jobId || undefined,
    })),
  };
}

/** GET /api/opportunities/company/weeks - my weeks, with counts only. */
opportunitiesRouter.get(
  '/company/weeks',
  requireRole('COMPANY'),
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    const [list, colleges, simulations, jobs] = await Promise.all([
      companyWeeks(companyId),
      collegesOffering(),
      publishedSimulations(companyId),
      companyJobsForEvents(companyId),
    ]);
    res.json({ weeks: list, colleges, simulations, jobs });
  }),
);

/** POST /api/opportunities/company/weeks - propose a week to a college. */
opportunitiesRouter.post(
  '/company/weeks',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const company = await verifiedCompanyOrThrow(companyId);
    res.status(201).json({ week: await proposeWeek(companyId, company.name, toWeekInput(weekSchema.parse(req.body))) });
  }),
);

/** PUT /api/opportunities/company/weeks/:id - change it while the college has not decided. */
opportunitiesRouter.put(
  '/company/weeks/:id',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    res.json({ week: await updateProposedWeek(companyId, req.params.id!, toWeekInput(weekSchema.parse(req.body))) });
  }),
);

/** DELETE /api/opportunities/company/weeks/:id - withdraw a proposal. */
opportunitiesRouter.delete(
  '/company/weeks/:id',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompanyOrThrow(companyId);
    await withdrawProposedWeek(companyId, req.params.id!);
    res.status(204).end();
  }),
);

/* ========================================================================== */
/* Campus weeks - the college                                                  */
/* ========================================================================== */

/** GET /api/opportunities/college/weeks */
opportunitiesRouter.get(
  '/college/weeks',
  requireRole('CAMPUS'),
  weeks,
  can('drive:read'),
  asyncHandler(async (req, res) => {
    res.json({ weeks: await weeksForCollege(requireCollegeId(req)) });
  }),
);

/** POST /api/opportunities/college/weeks/:id/decision */
opportunitiesRouter.post(
  '/college/weeks/:id/decision',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const { status, note } = z
      .object({
        status: z.enum(['APPROVED', 'DECLINED']),
        note: z.string().trim().max(1000).optional().or(z.literal('')),
      })
      .parse(req.body);
    await decideWeek(requireCollegeId(req), req.params.id!, status, note || undefined);
    res.json({ weeks: await weeksForCollege(requireCollegeId(req)) });
  }),
);

/** PATCH /api/opportunities/college/weeks/:id/events/:eventId - move a session. */
opportunitiesRouter.patch(
  '/college/weeks/:id/events/:eventId',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        startsAt: z.coerce.date().optional(),
        durationMin: z.number().int().min(15).max(480).optional(),
        where: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    await adjustEvent(requireCollegeId(req), req.params.id!, req.params.eventId!, input);
    res.json({ weeks: await weeksForCollege(requireCollegeId(req)) });
  }),
);

/** POST /api/opportunities/college/weeks/:id/events/:eventId/attendance */
opportunitiesRouter.post(
  '/college/weeks/:id/events/:eventId/attendance',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const { candidateId, attended } = z.object({ candidateId: z.string().min(1), attended: z.boolean() }).parse(req.body);
    await markAttendance(requireCollegeId(req), req.params.id!, req.params.eventId!, candidateId, attended);
    res.status(204).end();
  }),
);

/** POST /api/opportunities/college/weeks/:id/done - close the week. */
opportunitiesRouter.post(
  '/college/weeks/:id/done',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    await finishWeek(requireCollegeId(req), req.params.id!);
    res.json({ weeks: await weeksForCollege(requireCollegeId(req)) });
  }),
);

/* --- the college's own events ---------------------------------------------- */

/**
 * The placement cell's own event: the prep session before a drive, the resume
 * clinic. No proposal and no decision - it is on when it is saved.
 */
opportunitiesRouter.post(
  '/college/events',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const input = toWeekInput(weekSchema.parse({ ...req.body, collegeId }));
    const id = await createCollegeEvent(collegeId, input);
    res.status(201).json({ id, weeks: await weeksForCollege(collegeId) });
  }),
);

/** PUT /api/opportunities/college/events/:id - change one the college owns. */
opportunitiesRouter.put(
  '/college/events/:id',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const input = toWeekInput(weekSchema.parse({ ...req.body, collegeId }));
    await updateCollegeEvent(collegeId, req.params.id!, input);
    res.json({ weeks: await weeksForCollege(collegeId) });
  }),
);

/** DELETE /api/opportunities/college/events/:id */
opportunitiesRouter.delete(
  '/college/events/:id',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    await deleteCollegeEvent(collegeId, req.params.id!);
    res.json({ weeks: await weeksForCollege(collegeId) });
  }),
);

const inviteSchema = z
  .object({
    candidateIds: z.array(z.string().min(1)).max(2000).optional(),
    batchId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.candidateIds?.length || v.batchId || v.jobId), {
    message: 'Say who to invite.',
  });

/** POST /api/opportunities/college/weeks/:id/events/:eventId/invite */
opportunitiesRouter.post(
  '/college/weeks/:id/events/:eventId/invite',
  requireRole('CAMPUS'),
  weeks,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const result = await inviteToEvent(collegeId, req.params.id!, req.params.eventId!, inviteSchema.parse(req.body), {
      companyId: null,
      label: 'Your placement cell',
    });
    res.json({ ...result, weeks: await weeksForCollege(collegeId) });
  }),
);

/**
 * POST /api/opportunities/company/weeks/:id/events/:eventId/invite
 *
 * A company invites by role only - the people who applied to one of its own
 * jobs, whom it already sees. It never receives the list, only the count.
 */
opportunitiesRouter.post(
  '/company/weeks/:id/events/:eventId/invite',
  requireRole('COMPANY'),
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const company = await verifiedCompanyOrThrow(companyId);
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.body);
    const week = await companyWeekCollege(companyId, req.params.id!);
    const result = await inviteToEvent(week.collegeId, req.params.id!, req.params.eventId!, { jobId }, {
      companyId,
      label: company.name,
    });
    res.json({ ...result, weeks: await companyWeeks(companyId) });
  }),
);

/* ========================================================================== */
/* Campus weeks - students                                                     */
/* ========================================================================== */

/** GET /api/opportunities/weeks - approved weeks at my college. */
opportunitiesRouter.get(
  '/weeks',
  requireRole('CANDIDATE'),
  weeks,
  asyncHandler(async (req, res) => {
    res.json({ weeks: await weeksForStudent(requireCandidateId(req)) });
  }),
);

/** POST /api/opportunities/weeks/events/:eventId/register */
opportunitiesRouter.post(
  '/weeks/events/:eventId/register',
  requireRole('CANDIDATE'),
  weeks,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    await register(candidateId, req.params.eventId!);
    res.json({ weeks: await weeksForStudent(candidateId) });
  }),
);

/** DELETE /api/opportunities/weeks/events/:eventId/register */
opportunitiesRouter.delete(
  '/weeks/events/:eventId/register',
  requireRole('CANDIDATE'),
  weeks,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    await unregister(candidateId, req.params.eventId!);
    res.json({ weeks: await weeksForStudent(candidateId) });
  }),
);
