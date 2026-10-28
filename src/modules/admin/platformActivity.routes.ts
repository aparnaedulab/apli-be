import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { requirePlatform } from '../tenants/tenant.context.js';
import {
  activityQuery,
  activityStats,
  listInterviews,
  listOffers,
  listRuns,
  listSimulations,
  listStudents,
  studentDetail,
  unattached,
} from './studentActivity.js';

/**
 * The platform team's read of every student: /api/platform/activity.
 *
 * Unlike an institution's admin, the platform sees students whose college is
 * not on Apli.ai yet - they signed up on their own and belong to no
 * institution, so this is the only place anybody can see them.
 */
export const platformActivityRouter = Router();

platformActivityRouter.use(requireRole('ADMIN'), requirePlatform);

const everyone = {};

platformActivityRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [all, onTheirOwn] = await Promise.all([activityStats(everyone), activityStats(unattached)]);
    res.json({ ...all, unattachedStudents: onTheirOwn.students });
  }),
);

platformActivityRouter.get(
  '/students',
  asyncHandler(async (req, res) => {
    res.json(await listStudents(everyone, activityQuery.parse(req.query)));
  }),
);

platformActivityRouter.get(
  '/students/:id',
  asyncHandler(async (req, res) => {
    res.json(await studentDetail(everyone, z.string().trim().min(1).max(40).parse(req.params.id)));
  }),
);

platformActivityRouter.get(
  '/simulations',
  asyncHandler(async (req, res) => {
    res.json(await listSimulations(everyone, activityQuery.parse(req.query)));
  }),
);

platformActivityRouter.get(
  '/work',
  asyncHandler(async (req, res) => {
    res.json(await listRuns(everyone, activityQuery.parse(req.query)));
  }),
);

platformActivityRouter.get(
  '/offers',
  asyncHandler(async (req, res) => {
    res.json(await listOffers(everyone, activityQuery.parse(req.query)));
  }),
);

platformActivityRouter.get(
  '/interviews',
  asyncHandler(async (req, res) => {
    res.json(await listInterviews(everyone, activityQuery.parse(req.query)));
  }),
);
