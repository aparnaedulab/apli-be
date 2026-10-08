import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { studentHelp } from './help.service.js';

/**
 * GET /api/help/faq - the questions and answers for the signed-in person's
 * institution, or the platform's defaults when it has none.
 */
export const helpRouter = Router();

helpRouter.get(
  '/faq',
  asyncHandler(async (req, res) => {
    res.json({ questions: await studentHelp(req.session.tenantId) });
  }),
);
