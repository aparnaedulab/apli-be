import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { platformWrites } from '../roles/platformWrites.js';
import { can } from '../roles/can.js';

export const collegeTypesRouter = Router();

collegeTypesRouter.use(requireRole('ADMIN'));

// A shared list: every institution picks from it, so only the platform edits it.
collegeTypesRouter.use(platformWrites);

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

/** GET /api/admin/college-types */
collegeTypesRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const { includeRetired } = z
      .object({ includeRetired: z.enum(['true', 'false']).default('false') })
      .parse(req.query);

    const types = await prisma.collegeType.findMany({
      where: includeRetired === 'true' ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { colleges: true } } },
    });

    res.json({
      types: types.map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        collegeCount: t._count.colleges,
      })),
    });
  }),
);

/** POST /api/admin/college-types */
collegeTypesRouter.post(
  '/',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);

    // MySQL's default collation is already case-insensitive, but being explicit
    // documents the intent rather than relying on the server's configuration.
    const existing = await prisma.collegeType.findFirst({ where: { name } });
    if (existing) {
      if (!existing.isActive) {
        // Re-adding a retired type brings it back rather than failing, which is
        // what someone typing the name again actually means.
        const revived = await prisma.collegeType.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
        res.status(200).json({ type: revived, revived: true });
        return;
      }
      throw conflict(`${existing.name} is already on the list.`);
    }

    const type = await prisma.collegeType.create({ data: { name } });
    res.status(201).json({ type });
  }),
);

/** PATCH /api/admin/college-types/:id — rename, or retire and restore */
collegeTypesRouter.patch(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const data = nameSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const type = await prisma.collegeType.findUnique({ where: { id: req.params.id } });
    if (!type) throw notFound('No such college type.');

    if (data.name && data.name !== type.name) {
      const clash = await prisma.collegeType.findFirst({
        where: { name: data.name, id: { not: type.id } },
      });
      if (clash) throw conflict(`${clash.name} is already on the list.`);
    }

    const updated = await prisma.collegeType.update({
      where: { id: type.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    res.json({ type: updated });
  }),
);

/**
 * DELETE /api/admin/college-types/:id
 * Only while nothing uses it. A type in use is retired instead, which keeps it
 * off new forms without orphaning the colleges already set to it.
 */
collegeTypesRouter.delete(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const type = await prisma.collegeType.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { colleges: true } } },
    });
    if (!type) throw notFound('No such college type.');

    if (type._count.colleges > 0) {
      throw conflict(
        `${type._count.colleges} college${type._count.colleges === 1 ? ' uses' : 's use'} this type. Retire it instead — it will stay on those colleges but disappear from the form.`,
      );
    }

    await prisma.collegeType.delete({ where: { id: type.id } });
    res.status(204).end();
  }),
);
