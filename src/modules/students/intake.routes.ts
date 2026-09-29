import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireTenantId } from '../tenants/tenant.context.js';
import { describeIntake, intakePolicySchema, policyFor, savePolicy } from './policy.js';

/**
 * The institution's answer to three questions, asked before anybody uploads
 * a roster:
 *
 *   what do we record about a student
 *   which of those do we insist on
 *   who puts them on the roster - us, our colleges, or the students
 *
 * Set during onboarding by the platform team and editable afterwards by the
 * institution, the same way its other rules work. Both doors land here.
 */

export const intakeRouter = Router();

intakeRouter.use(requireRole('ADMIN'));

/** GET /api/admin/student-intake */
intakeRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    res.json(describeIntake(await policyFor(requireTenantId(req))));
  }),
);

/** PUT /api/admin/student-intake */
intakeRouter.put(
  '/',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const saved = await savePolicy(tenantId, intakePolicySchema.parse(req.body));
    res.json(describeIntake(saved));
  }),
);
