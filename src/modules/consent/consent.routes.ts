import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireRole } from '../../middleware/auth.js';
import { requireModule } from '../tenants/tenant.context.js';
import { can } from '../roles/can.js';
import {
  CONSENT_PURPOSES,
  collegeConsentCounts,
  consentOverview,
  recordConsents,
} from './consent.service.js';

/**
 * The DPDP consent centre.
 *
 * A student's own answers, one purpose at a time, and the college's view of
 * them - counts only. The college needs to know how many students cannot yet
 * be counted in a report or shared with a recruiter; it never needs to know
 * which student said what.
 */
export const consentRouter = Router();

consentRouter.use(requireModule('compliance.consent'));

const purposeSchema = z
  .string()
  .refine((p) => CONSENT_PURPOSES.some((c) => c.key === p), 'There is no such use of your data.');

/** GET /api/consent - every purpose, the current answer and its history. */
consentRouter.get(
  '/',
  requireRole('CANDIDATE'),
  asyncHandler(async (req, res) => {
    res.json({ purposes: await consentOverview(requireCandidateId(req)) });
  }),
);

/**
 * PUT /api/consent - one answer. Always appended, even when it repeats the
 * last one: the history is a record of what the student did, not a diff.
 */
consentRouter.put(
  '/',
  requireRole('CANDIDATE'),
  asyncHandler(async (req, res) => {
    const { purpose, granted } = z.object({ purpose: purposeSchema, granted: z.boolean() }).parse(req.body);
    const candidateId = requireCandidateId(req);
    await recordConsents(candidateId, { [purpose]: granted });
    res.json({ purposes: await consentOverview(candidateId) });
  }),
);

/** PUT /api/consent/bulk - several answers at once ("allow what applying needs"). */
consentRouter.put(
  '/bulk',
  requireRole('CANDIDATE'),
  asyncHandler(async (req, res) => {
    const { grants } = z
      .object({
        grants: z
          .record(z.string(), z.boolean())
          .refine((g) => Object.keys(g).length > 0, 'Say which uses you are answering.')
          .refine((g) => Object.keys(g).every((k) => CONSENT_PURPOSES.some((c) => c.key === k)), 'There is no such use of your data.'),
      })
      .parse(req.body);
    const candidateId = requireCandidateId(req);
    await recordConsents(candidateId, grants);
    res.json({ purposes: await consentOverview(candidateId) });
  }),
);

/** GET /api/consent/college - how the college's students have answered, as counts. */
consentRouter.get(
  '/college',
  requireRole('CAMPUS'),
  can('student:read'),
  asyncHandler(async (req, res) => {
    res.json({ purposes: await collegeConsentCounts(requireCollegeId(req)) });
  }),
);
