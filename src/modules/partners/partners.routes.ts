import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PartnerKind, PartnerRequestStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { requirePlatform } from '../tenants/tenant.context.js';

/**
 * Universities and colleges asking to bring Apli.ai to their students.
 *
 * They are free partners, onboarded by the platform team through the
 * onboarding wizard - so the public side is a request form, not an account.
 * The platform console lists the requests and records whether somebody has
 * been in touch.
 */

/** POST /api/public/partner-requests - anyone may ask; a person reads every one. */
export const partnerPublicRouter = Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests from here. Try again in an hour.' },
  },
});

const requestSchema = z.object({
  kind: z.nativeEnum(PartnerKind, { errorMap: () => ({ message: 'Choose university or college.' }) }),
  institutionName: z.string().trim().min(3, 'Enter the name of your institution.').max(191),
  city: z.string().trim().min(2, 'Enter the city.').max(120),
  state: z.string().trim().max(120).optional().or(z.literal('')),
  contactName: z.string().trim().min(2, 'Enter your full name.').max(120),
  contactRole: z.string().trim().min(2, 'Tell us your role.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number.')
    .optional()
    .or(z.literal('')),
  students: z.coerce.number().int().min(1).max(5_000_000).optional(),
  message: z.string().trim().max(2000).optional().or(z.literal('')),
});

partnerPublicRouter.post(
  '/partner-requests',
  limiter,
  asyncHandler(async (req, res) => {
    const b = requestSchema.parse(req.body);
    const saved = await prisma.partnerRequest.create({
      data: {
        kind: b.kind,
        institutionName: b.institutionName,
        city: b.city,
        state: b.state || null,
        contactName: b.contactName,
        contactRole: b.contactRole,
        email: b.email,
        phone: b.phone || null,
        students: b.students ?? null,
        message: b.message || null,
      },
      select: { id: true },
    });
    res.status(201).json({ request: saved });
  }),
);

/** /api/platform/partner-requests - the platform team's list. */
export const partnerAdminRouter = Router();
partnerAdminRouter.use(requireRole('ADMIN'), requirePlatform);

partnerAdminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const requests = await prisma.partnerRequest.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
    res.json({ requests });
  }),
);

partnerAdminRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.nativeEnum(PartnerRequestStatus) }).parse(req.body);
    const id = String(req.params.id);
    if (!(await prisma.partnerRequest.findUnique({ where: { id }, select: { id: true } }))) {
      throw notFound('No such request.');
    }
    const request = await prisma.partnerRequest.update({ where: { id }, data: { status } });
    res.json({ request });
  }),
);
