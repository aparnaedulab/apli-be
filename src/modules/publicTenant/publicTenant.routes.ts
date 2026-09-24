import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { TenantStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

/**
 * An institution's public face: its branded sign-in page and Contact us.
 *
 * This is the one tenant read that needs no session, so it answers with the
 * least it can: what the sign-in page paints (name, logo, colour) and what the
 * institution chose to publish as its Contact us. The onboarding contact - the
 * person the platform team deals with - is never part of it.
 */
export const publicTenantRouter = Router();

/**
 * Generous for a person, tight for a script walking slugs to list every
 * institution on the platform.
 */
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Try again in a minute.' },
  },
});

/** Exactly the fields the page may show. A new column stays private until added here. */
export const PUBLIC_TENANT_FIELDS = {
  name: true,
  shortName: true,
  slug: true,
  tagline: true,
  logoUrl: true,
  faviconUrl: true,
  brandColor: true,
  supportEmail: true,
  supportPhone: true,
  supportAltPhone: true,
  supportWhatsapp: true,
  officeHours: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
} as const;

/** The same answer for "no such address" and "not live yet": a draft is nobody's business. */
const NOT_HERE = 'There is no placement portal at this address. Check the link you were given.';

/**
 * GET /api/public/tenants/:slug
 *
 * Live institutions only. A suspended one says so - the people who use it
 * deserve to know it is paused rather than gone.
 */
publicTenantRouter.get(
  '/tenants/:slug',
  lookupLimiter,
  asyncHandler(async (req, res) => {
    const slug = String(req.params.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw notFound(NOT_HERE);

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { ...PUBLIC_TENANT_FIELDS, status: true },
    });
    if (!tenant || tenant.status === TenantStatus.DRAFT) throw notFound(NOT_HERE);
    if (tenant.status === TenantStatus.SUSPENDED) {
      throw new AppError(
        503,
        'TENANT_UNAVAILABLE',
        `The ${tenant.name} placement portal is temporarily unavailable. Please try again later.`,
      );
    }

    const { status: _status, ...rest } = tenant;
    res.json({ tenant: rest });
  }),
);
