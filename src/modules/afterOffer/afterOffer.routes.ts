import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  requireCandidateId,
  requireCollegeId,
  requireCompanyId,
  requireRole,
} from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule, tenantHasModule } from '../tenants/tenant.context.js';
import {
  collegeCompanies,
  collegeNote,
  collegeOffers,
  collegeReliability,
  companyJoining,
  companyView,
  markReliability,
  rateProcess,
  studentJoining,
  studentOffers,
  studentRatings,
} from './afterOffer.service.js';

/**
 * Offer protection and two-way reputation.
 *
 * Students and colleges are inside an institution, so they see this only where
 * it is switched on. A company spans every institution and has no tenant, so
 * its side is never gated: a company updates joining dates and records
 * reliability whichever colleges have bought the screens that read them.
 */
export const afterOfferRouter = Router();

const note = (max: number) => z.string().trim().max(max).optional();
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-07-01.')
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

/* --- student ----------------------------------------------------------------- */

/** GET /api/after-offer/student/offers - accepted offers and where joining stands. */
afterOfferRouter.get(
  '/student/offers',
  requireRole('CANDIDATE'),
  requireModule('trust.offerProtection'),
  asyncHandler(async (req, res) => {
    res.json({ offers: await studentOffers(requireCandidateId(req)) });
  }),
);

const studentJoiningSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('CONFIRM') }),
  z.object({ action: z.literal('NO_NEWS'), note: note(500) }),
  z.object({ action: z.literal('REPORT_DELAY'), note: z.string().trim().min(3, 'Say what you were told.').max(500), date: dateSchema.optional() }),
  z.object({ action: z.literal('REPORT_REVOKED'), note: z.string().trim().min(3, 'Say what you were told.').max(500) }),
]);

/** POST /api/after-offer/student/offers/:id - confirm, "no news", or report a delay or withdrawal. */
afterOfferRouter.post(
  '/student/offers/:id',
  requireRole('CANDIDATE'),
  requireModule('trust.offerProtection'),
  asyncHandler(async (req, res) => {
    const input = studentJoiningSchema.parse(req.body);
    res.json({ tracker: await studentJoining(requireCandidateId(req), req.params.id!, input) });
  }),
);

/** GET /api/after-offer/student/ratings - closed applications, rated or not. */
afterOfferRouter.get(
  '/student/ratings',
  requireRole('CANDIDATE'),
  requireModule('trust.reputation'),
  asyncHandler(async (req, res) => {
    res.json({ applications: await studentRatings(requireCandidateId(req)) });
  }),
);

const score = z.number().int().min(1, 'Pick 1 to 5.').max(5, 'Pick 1 to 5.');
const ratingSchema = z.object({ communication: score, clarity: score, fairness: score, note: note(500) });

/** POST /api/after-offer/student/ratings/:id - rate how one hiring process was run, once. */
afterOfferRouter.post(
  '/student/ratings/:id',
  requireRole('CANDIDATE'),
  requireModule('trust.reputation'),
  asyncHandler(async (req, res) => {
    const input = ratingSchema.parse(req.body);
    res.status(201).json({ rating: await rateProcess(requireCandidateId(req), req.params.id!, input) });
  }),
);

/* --- company ----------------------------------------------------------------- */

/** GET /api/after-offer/company/applications/:id - joining and reliability for one applicant. */
afterOfferRouter.get(
  '/company/applications/:id',
  requireRole('COMPANY'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    res.json(await companyView(requireCompanyId(req), req.params.id!));
  }),
);

const companyJoiningSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('SET_DATE'), date: dateSchema, reason: note(500) }),
  z.object({ action: z.literal('JOINED') }),
  z.object({ action: z.literal('REVOKE'), reason: z.string().trim().min(3, 'Say why the offer is being withdrawn.').max(500) }),
]);

/** POST /api/after-offer/company/applications/:id/joining - set or move the date, mark joined, or withdraw. */
afterOfferRouter.post(
  '/company/applications/:id/joining',
  requireRole('COMPANY'),
  // Deciding about an offer is the offer-maker's call, not every recruiter's.
  can('offer:make'),
  asyncHandler(async (req, res) => {
    const input = companyJoiningSchema.parse(req.body);
    res.json({ tracker: await companyJoining(requireCompanyId(req), req.params.id!, input) });
  }),
);

const reliabilitySchema = z.object({
  kind: z.enum(['ON_TIME', 'NO_SHOW', 'RENEGED']),
  note: note(500),
});

/** POST /api/after-offer/company/applications/:id/reliability - did the candidate keep their word? */
afterOfferRouter.post(
  '/company/applications/:id/reliability',
  requireRole('COMPANY'),
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const input = reliabilitySchema.parse(req.body);
    res.json({ reliability: await markReliability(requireCompanyId(req), req.params.id!, input, req.session.userId!) });
  }),
);

/* --- college ------------------------------------------------------------------ */

/** GET /api/after-offer/college/offers?companyId= - every accepted offer at this college. */
afterOfferRouter.get(
  '/college/offers',
  requireRole('CAMPUS'),
  requireModule('trust.offerProtection'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    const { companyId } = z.object({ companyId: z.string().optional() }).parse(req.query);
    res.json(await collegeOffers(requireCollegeId(req), { companyId: companyId || undefined }));
  }),
);

/** POST /api/after-offer/college/offers/:id/note - the college's own line in the history. */
afterOfferRouter.post(
  '/college/offers/:id/note',
  requireRole('CAMPUS'),
  requireModule('trust.offerProtection'),
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const { note: text } = z.object({ note: z.string().trim().min(2, 'Write the note.').max(500) }).parse(req.body);
    res.json({ tracker: await collegeNote(requireCollegeId(req), req.params.id!, text) });
  }),
);

/**
 * GET /api/after-offer/college/companies - companies that made offers here,
 * with offer-honour rate and (where reputation is on) process ratings.
 */
afterOfferRouter.get(
  '/college/companies',
  requireRole('CAMPUS'),
  requireModule('trust.offerProtection'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    const withRatings = await tenantHasModule(req.session.tenantId, 'trust.reputation');
    res.json({ companies: await collegeCompanies(requireCollegeId(req), withRatings), ratingsShown: withRatings });
  }),
);

/** GET /api/after-offer/college/reliability - no-shows and reneged offers among this college's students. */
afterOfferRouter.get(
  '/college/reliability',
  requireRole('CAMPUS'),
  requireModule('trust.reputation'),
  can('student:read'),
  asyncHandler(async (req, res) => {
    res.json({ marks: await collegeReliability(requireCollegeId(req)) });
  }),
);
