import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { platformWrites } from '../roles/platformWrites.js';
import { can } from '../roles/can.js';

export const industriesRouter = Router();

industriesRouter.use(requireRole('ADMIN'));

// A shared list: every institution picks from it, so only the platform edits it.
industriesRouter.use(platformWrites);

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Enter a name.')
    .max(60, 'Keep it short.')
    // Stored as typed but compared case-insensitively below, so "engineering"
    // cannot be added alongside "Engineering".
    .regex(/^[A-Za-z0-9 &.\-/]+$/, 'Letters, numbers, spaces and & . - / only.'),
});

/** GET /api/admin/industries */
industriesRouter.get(
  '/',
  can('company:read'),
  asyncHandler(async (req, res) => {
    const { includeRetired } = z
      .object({ includeRetired: z.enum(['true', 'false']).default('false') })
      .parse(req.query);

    const industries = await prisma.industry.findMany({
      where: includeRetired === 'true' ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { companies: true } } },
    });

    res.json({
      industries: industries.map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        companyCount: t._count.companies,
      })),
    });
  }),
);

/** POST /api/admin/industries */
industriesRouter.post(
  '/',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);

    // MySQL's default collation is already case-insensitive, but being explicit
    // documents the intent rather than relying on the server's configuration.
    const existing = await prisma.industry.findFirst({ where: { name } });
    if (existing) {
      if (!existing.isActive) {
        // Re-adding a retired industry brings it back rather than failing, which is
        // what someone typing the name again actually means.
        const revived = await prisma.industry.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
        res.status(200).json({ type: revived, revived: true });
        return;
      }
      throw conflict(`${existing.name} is already on the list.`);
    }

    const type = await prisma.industry.create({ data: { name } });
    res.status(201).json({ industry: type });
  }),
);

/** PATCH /api/admin/industries/:id — rename, or retire and restore */
industriesRouter.patch(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const data = nameSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const type = await prisma.industry.findUnique({ where: { id: req.params.id } });
    if (!type) throw notFound('No such industry.');

    if (data.name && data.name !== type.name) {
      const clash = await prisma.industry.findFirst({
        where: { name: data.name, id: { not: type.id } },
      });
      if (clash) throw conflict(`${clash.name} is already on the list.`);
    }

    const updated = await prisma.industry.update({
      where: { id: type.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    res.json({ industry: updated });
  }),
);

/**
 * DELETE /api/admin/industries/:id
 * Only while nothing uses it. An industry in use is retired instead, which
 * keeps it off new forms without orphaning the companies already set to it.
 */
industriesRouter.delete(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const type = await prisma.industry.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { companies: true } } },
    });
    if (!type) throw notFound('No such industry.');

    if (type._count.companies > 0) {
      throw conflict(
        `${type._count.companies} compan${type._count.companies === 1 ? 'y uses' : 'ies use'} this industry. Retire it instead — it will stay on those companies but disappear from the form.`,
      );
    }

    await prisma.industry.delete({ where: { id: type.id } });
    res.status(204).end();
  }),
);

/**
 * POST /api/admin/industries/resolve
 *
 * A company that found nothing fitting typed its own industry. Two honest
 * answers to that: the list was missing one, or the company used a different
 * word for something already there. Both end with the company pointing at a
 * real industry and the typed text gone, so nobody is asked about it twice.
 */
industriesRouter.post(
  '/resolve',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ companyId: z.string().trim().min(1), industryId: z.string().trim().min(1).optional() })
      .parse(req.body);

    const company = await prisma.company.findUnique({
      where: { id: body.companyId },
      select: { id: true, industryOther: true },
    });
    if (!company) throw notFound('No such company.');

    let industryId = body.industryId;

    if (!industryId) {
      // Adding what they typed. The same name in another case is the same
      // industry, and a retired one comes back rather than being duplicated.
      const name = nameSchema.parse({ name: company.industryOther ?? '' }).name;
      const existing = await prisma.industry.findFirst({ where: { name } });
      industryId = existing
        ? (await prisma.industry.update({ where: { id: existing.id }, data: { isActive: true } })).id
        : (await prisma.industry.create({ data: { name } })).id;
    } else {
      const chosen = await prisma.industry.findUnique({ where: { id: industryId } });
      if (!chosen?.isActive) throw notFound('No such industry.');
    }

    const updated = await prisma.company.update({
      where: { id: company.id },
      data: { industryId, industryOther: null },
      select: { id: true, industry: { select: { id: true, name: true } } },
    });

    res.json({ company: updated });
  }),
);
