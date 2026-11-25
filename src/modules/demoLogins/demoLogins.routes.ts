import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { forbidden } from '../../lib/errors.js';
import { requirePlatform } from '../tenants/tenant.context.js';
import { demoEnabled, describeDemoLogins, resetDemoPack } from './demoLogins.service.js';

/**
 * The super admin's demo logins: the list, and the button that puts every
 * demo login back to its starting situation.
 */
export const demoLoginsRouter = Router();

demoLoginsRouter.use(requireRole('ADMIN'), requirePlatform);

demoLoginsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await describeDemoLogins());
  }),
);

demoLoginsRouter.post(
  '/reset',
  asyncHandler(async (_req, res) => {
    if (!demoEnabled()) throw forbidden('Demo logins are switched off on this server. Set DEMO_LOGINS=true to use them.');
    const result = await resetDemoPack();
    res.json({ result, ...(await describeDemoLogins()) });
  }),
);
