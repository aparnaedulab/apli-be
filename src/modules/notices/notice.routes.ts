import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireTenantId } from '../tenants/tenant.context.js';
import { can } from '../roles/can.js';
import {
  createNotice,
  deleteNotice,
  listNotices,
  noticesFor,
  retractNotice,
} from './notice.service.js';

export const noticeRouter = Router();

const noticeSchema = z.object({
  title: z.string().trim().min(3, 'Give the notice a title.').max(160),
  body: z.string().trim().min(3, 'Say something in the notice.').max(8000),
  toStudents: z.boolean().default(false),
  toCompanies: z.boolean().default(false),
  toColleges: z.boolean().default(false),
  /** Blank means it stands until somebody takes it down. */
  expiresAt: z
    .union([z.string().datetime(), z.string().length(0), z.null()])
    .optional()
    .transform((v) => (v ? new Date(v) : null)),
});

/**
 * GET /api/notices - what the signed-in person has been sent.
 *
 * Open to every role on purpose: a notice is addressed to somebody, and the
 * service decides who that is from the session. It reads, it never writes.
 */
noticeRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      notices: await noticesFor({
        role: req.session.role,
        tenantId: req.session.tenantId,
        companyId: req.session.companyId,
      }),
    });
  }),
);

/**
 * Everything below is the institution's own desk: posting a notice, seeing
 * the ones it has posted, and taking one down.
 */
noticeRouter.use(requireRole('ADMIN'));

noticeRouter.get(
  '/all',
  can('report:read'),
  asyncHandler(async (req, res) => {
    res.json({ notices: await listNotices(requireTenantId(req)) });
  }),
);

noticeRouter.post(
  '/',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const notice = await createNotice(
      requireTenantId(req),
      req.session.userId,
      noticeSchema.parse(req.body),
    );
    res.status(201).json({ notice });
  }),
);

/** Taken down, not destroyed: what was said stays on the record. */
noticeRouter.post(
  '/:id/retract',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    await retractNotice(requireTenantId(req), req.params.id!);
    res.status(204).end();
  }),
);

/** For a notice posted by mistake, where there is nothing worth keeping. */
noticeRouter.delete(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    await deleteNotice(requireTenantId(req), req.params.id!);
    res.status(204).end();
  }),
);
