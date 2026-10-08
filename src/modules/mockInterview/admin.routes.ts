import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireTenantId } from '../tenants/tenant.context.js';
import { adminRound, roundSchema, saveRound, saveRoundSchema } from './bank.js';
import { KINDS, QUESTION_TYPES, ROLES } from './questions.js';

/**
 * The institution's mock-interview questions, for its admins.
 *
 *   GET /api/admin/interview-questions?kind=HR&role=   one round's list
 *   PUT /api/admin/interview-questions                 replace one round's list
 */
export const interviewBankRouter = Router();
interviewBankRouter.use(requireRole('ADMIN'));

interviewBankRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const { kind, role } = roundSchema.parse(req.query);
    res.json({
      ...(await adminRound(requireTenantId(req), kind, role)),
      kinds: KINDS,
      roles: ROLES,
      types: QUESTION_TYPES,
    });
  }),
);

interviewBankRouter.put(
  '/',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { kind, role } = roundSchema.parse(req.body);
    const input = saveRoundSchema.parse(req.body);
    res.json(await saveRound(requireTenantId(req), kind, role, input));
  }),
);
