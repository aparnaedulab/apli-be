import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { requireModule } from '../tenants/tenant.context.js';
import { can } from '../roles/can.js';
import {
  addLog,
  collegeSummary,
  complete,
  decide,
  editLog,
  editProposal,
  getForCollege,
  importable,
  importFromApplication,
  listForCollege,
  listMine,
  markAbc,
  propose,
  reissueMentorLink,
  reviewLog,
  reviewPreview,
  setCredits,
  submitReview,
  withdraw,
} from './internship.service.js';

/**
 * NEP internships.
 *
 * Three doors, fenced differently:
 *   /review/:token  - public: the mentor has no account, and the token is the
 *                     credential. Rate-limited, and each link works once.
 *   /mine           - the student, where their institution has the module.
 *   /college        - the placement cell, only ever its own college's rows.
 */
export const internshipRouter = Router();

/* --- the mentor's link (public) ---------------------------------------------- */

const reviewRouter = Router();

const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again shortly.' } },
});

reviewRouter.use(reviewLimiter);

/** GET /api/internships/review/:token - what the mentor is being asked about. */
reviewRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    res.json({ internship: await reviewPreview(req.params.token!) });
  }),
);

const evaluationSchema = z.object({
  score: z.number().int().min(1, 'Choose a score from 1 to 5.').max(5, 'Choose a score from 1 to 5.'),
  note: z.string().trim().min(10, 'A sentence or two, please - the college reads this.').max(2000),
});

/** POST /api/internships/review/:token - the one evaluation this link accepts. */
reviewRouter.post(
  '/:token',
  asyncHandler(async (req, res) => {
    await submitReview(req.params.token!, evaluationSchema.parse(req.body));
    res.status(201).json({ ok: true });
  }),
);

internshipRouter.use('/review', reviewRouter);

/* --- the student --------------------------------------------------------------- */

const mine = Router();
mine.use(requireRole('CANDIDATE'), requireModule('compliance.internships'));

const date = z.coerce.date({ invalid_type_error: 'Enter a date.' });
const blank = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const proposalSchema = z.object({
  organisation: z.string().trim().min(2, 'Where is the internship?').max(200),
  role: z.string().trim().min(2, 'What is the role?').max(200),
  mode: blank(40),
  startDate: date,
  endDate: date,
  hoursPerWeek: z.number().int().min(1).max(60).optional(),
  mentorName: blank(120),
  mentorEmail: z.string().trim().toLowerCase().email('Enter the mentor’s work email.').optional().or(z.literal('')),
});

const logSchema = z.object({
  weekOf: date,
  hours: z.number().int().min(1, 'At least an hour.').max(80, 'More than 80 hours in a week is not a log, it is a typo.'),
  summary: z.string().trim().min(20, 'Say what you did - two or three sentences.').max(3000),
});

async function studentScope(req: Request) {
  const candidateId = requireCandidateId(req);
  const c = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId }, select: { collegeId: true } });
  return { candidateId, collegeId: c.collegeId, tenantId: req.session.tenantId ?? null };
}

/** GET /api/internships/mine - my internships, and offers I could add as one. */
mine.get(
  '/',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const [internships, offers] = await Promise.all([listMine(candidateId), importable(candidateId)]);
    res.json({ internships, importable: offers });
  }),
);

/** POST /api/internships/mine - propose one. */
mine.post(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await studentScope(req);
    const i = await propose(scope.candidateId, scope, proposalSchema.parse(req.body));
    res.status(201).json({ internship: i.id });
  }),
);

/** POST /api/internships/mine/import/:applicationId - an accepted internship offer, in one click. */
mine.post(
  '/import/:applicationId',
  asyncHandler(async (req, res) => {
    const scope = await studentScope(req);
    const i = await importFromApplication(scope.candidateId, scope, req.params.applicationId!);
    res.status(201).json({ internship: i.id });
  }),
);

/** PUT /api/internships/mine/:id - change a proposal the college has not decided on. */
mine.put(
  '/:id',
  asyncHandler(async (req, res) => {
    await editProposal(requireCandidateId(req), req.params.id!, proposalSchema.parse(req.body));
    res.json({ internships: await listMine(requireCandidateId(req)) });
  }),
);

/** POST /api/internships/mine/:id/withdraw */
mine.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    await withdraw(requireCandidateId(req), req.params.id!);
    res.json({ internships: await listMine(requireCandidateId(req)) });
  }),
);

/** POST /api/internships/mine/:id/logs - one week's work. */
mine.post(
  '/:id/logs',
  asyncHandler(async (req, res) => {
    await addLog(requireCandidateId(req), req.params.id!, logSchema.parse(req.body));
    res.status(201).json({ internships: await listMine(requireCandidateId(req)) });
  }),
);

/** PUT /api/internships/mine/:id/logs/:logId - correct a week the college has not read yet. */
mine.put(
  '/:id/logs/:logId',
  asyncHandler(async (req, res) => {
    await editLog(requireCandidateId(req), req.params.id!, req.params.logId!, logSchema.omit({ weekOf: true }).parse(req.body));
    res.json({ internships: await listMine(requireCandidateId(req)) });
  }),
);

internshipRouter.use('/mine', mine);

/* --- the college ------------------------------------------------------------------ */

const college = Router();
college.use(requireRole('CAMPUS'), requireModule('compliance.internships'));

const queueSchema = z.enum(['to_approve', 'ongoing', 'to_evaluate', 'completed', 'closed', 'all']).default('all');
const credits = z.number().min(0.5, 'At least half a credit.').max(40).multipleOf(0.5, 'Use whole or half credits.');

/** GET /api/internships/college?queue= - the queue, and the numbers above it. */
college.get(
  '/',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const queue = queueSchema.parse(req.query.queue || undefined);
    const [internships, summary] = await Promise.all([listForCollege(collegeId, queue), collegeSummary(collegeId)]);
    res.json({ internships, summary });
  }),
);

/** GET /api/internships/college/:id */
college.get(
  '/:id',
  can('student:read'),
  asyncHandler(async (req, res) => {
    res.json({ internship: await getForCollege(requireCollegeId(req), req.params.id!) });
  }),
);

/** POST /api/internships/college/:id/decision - approve (with credits) or reject (with a reason). */
college.post(
  '/:id/decision',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({ approve: z.boolean(), note: z.string().trim().max(1000).optional(), credits: credits.optional() })
      .parse(req.body);
    res.json(await decide(requireCollegeId(req), req.params.id!, input));
  }),
);

/** POST /api/internships/college/:id/mentor-link - a fresh evaluation link; the old one stops working. */
college.post(
  '/:id/mentor-link',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    res.json({ mentor: await reissueMentorLink(requireCollegeId(req), req.params.id!) });
  }),
);

/** POST /api/internships/college/:id/logs/:logId/review */
college.post(
  '/:id/logs/:logId/review',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body);
    res.json({ internship: await reviewLog(requireCollegeId(req), req.params.id!, req.params.logId!, note) });
  }),
);

/** PUT /api/internships/college/:id/credits */
college.put(
  '/:id/credits',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const input = z.object({ credits }).parse(req.body);
    res.json({ internship: await setCredits(requireCollegeId(req), req.params.id!, input.credits) });
  }),
);

/** POST /api/internships/college/:id/complete */
college.post(
  '/:id/complete',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        certificateUrl: z
          .string()
          .trim()
          .max(500)
          .regex(/^https:\/\/\S+$/i, 'Paste a link starting with https://')
          .optional()
          .or(z.literal('')),
      })
      .parse(req.body);
    res.json({ internship: await complete(requireCollegeId(req), req.params.id!, input) });
  }),
);

/** POST /api/internships/college/:id/abc - the college confirming it sent the credits to ABC. */
college.post(
  '/:id/abc',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const input = z.object({ at: z.coerce.date().optional() }).parse(req.body);
    res.json({ internship: await markAbc(requireCollegeId(req), req.params.id!, input.at ?? new Date()) });
  }),
);

internshipRouter.use('/college', college);

