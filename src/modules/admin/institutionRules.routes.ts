import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireTenantId } from '../tenants/tenant.context.js';

/**
 * The institution's own rules, after onboarding.
 *
 * Onboarding step two sets these once; an institution changes its mind later -
 * a new placement head wants a longer response window, or self-join turns out
 * to let in the wrong people. This is the same four settings, editable by the
 * institution's own admins, always for the session's tenant and never another.
 */

export const institutionRulesRouter = Router();

institutionRulesRouter.use(requireRole('ADMIN'));

const RULES = {
  oneOfferDefault: true,
  allowSelfJoin: true,
  responseDays: true,
  companyApprovalRequired: true,
  unverifiedCompanyAccess: true,
} as const;

const rulesSchema = z
  .object({
    oneOfferDefault: z.boolean(),
    allowSelfJoin: z.boolean(),
    responseDays: z
      .number({ invalid_type_error: 'Choose a number of days.' })
      .int('Choose a whole number of days.')
      .min(1, 'At least one day.')
      .max(30, 'No more than 30 days.'),
    companyApprovalRequired: z.boolean(),
    unverifiedCompanyAccess: z.boolean(),
  })
  .partial()
  .strict();

/** GET /api/admin/institution-rules */
institutionRulesRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const rules = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: RULES });
    res.json({ rules });
  }),
);

/** PUT /api/admin/institution-rules - any subset of the four; the rest stay. */
institutionRulesRouter.put(
  '/',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const input = rulesSchema.parse(req.body ?? {});
    if (Object.keys(input).length === 0) throw badRequest('Nothing to change.');

    // Already-running drives keep the one-offer setting they were created
    // with; this only changes what new drives start from.
    const rules = await prisma.tenant.update({ where: { id: tenantId }, data: input, select: RULES });
    res.json({ rules });
  }),
);
