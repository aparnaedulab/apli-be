import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireTenantId } from '../tenants/tenant.context.js';
import {
  ACCESS_STATUSES,
  decide,
  institutionsForCompany,
  requestAccess,
  requestsForTenant,
} from './companyAccess.service.js';

/**
 * Institutions approving companies, when they choose to.
 *
 * Two halves that never overlap: a company sees only its own standing, and a
 * tenant admin sees only requests to their own institution - the tenant comes
 * from the session, never from the URL, so one institution cannot answer for
 * another. Platform staff reach the admin half by stepping into a tenant.
 */
export const companyAccessRouter = Router();

const noteSchema = z.object({ note: z.string().trim().max(500).optional() });
const decisionSchema = z.object({
  status: z.enum(ACCESS_STATUSES),
  note: z.string().trim().max(500).optional(),
});

/* ---------------------------------- company ---------------------------------- */

/** GET /api/company-access/company - institutions that ask for approval, and where we stand. */
companyAccessRouter.get(
  '/company',
  requireRole('COMPANY'),
  can('posting:target'),
  asyncHandler(async (req, res) => {
    res.json({ institutions: await institutionsForCompany(requireCompanyId(req)) });
  }),
);

/** POST /api/company-access/company/:tenantId/request - ask an institution to let us in. */
companyAccessRouter.post(
  '/company/:tenantId/request',
  requireRole('COMPANY'),
  can('posting:target'),
  asyncHandler(async (req, res) => {
    const { note } = noteSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { id: req.session.userId! }, select: { fullName: true } });
    const result = await requestAccess(requireCompanyId(req), String(req.params.tenantId), note || undefined, user?.fullName ?? 'A recruiter');
    res.json(result);
  }),
);

/* ---------------------------------- institution ---------------------------------- */

/** GET /api/company-access/tenant - requests to this institution, waiting ones first. */
companyAccessRouter.get(
  '/tenant',
  requireRole('ADMIN'),
  can('company:verify'),
  asyncHandler(async (req, res) => {
    res.json(await requestsForTenant(requireTenantId(req)));
  }),
);

/** POST /api/company-access/tenant/:companyId/decision - approve, block, or send back to pending. */
companyAccessRouter.post(
  '/tenant/:companyId/decision',
  requireRole('ADMIN'),
  can('company:verify'),
  asyncHandler(async (req, res) => {
    const { status, note } = decisionSchema.parse(req.body ?? {});
    res.json(await decide(requireTenantId(req), String(req.params.companyId), status, note || undefined, req.session.userId!));
  }),
);
