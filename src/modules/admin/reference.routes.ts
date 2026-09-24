import { Router } from 'express';
import { z } from 'zod';
import { RefKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { platformWrites } from '../roles/platformWrites.js';
import { can } from '../roles/can.js';

/**
 * The small vocabularies operations keeps: cities, states, NAAC grades,
 * genders.
 *
 * One router for all of them because they behave identically - a list of
 * names, added to and retired, with nothing hanging off any entry. Courses,
 * college types and industries have their own routers precisely because they
 * do have things hanging off them.
 *
 * Nothing is ever deleted while records carry it. A city on twelve colleges
 * is retired: it leaves the forms and stays on the colleges, because the
 * alternative is twelve colleges in a city the portal no longer recognises.
 */

export const referenceRouter = Router();

referenceRouter.use(requireRole('ADMIN'));

// A shared list: every institution picks from it, so only the platform edits it.
referenceRouter.use(platformWrites);

const valueSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, 'Enter a value.')
    .max(80, 'Keep it short enough to read in a dropdown.'),
  position: z.coerce.number().int().min(0).max(999).optional(),
});

/** How many records would be left pointing at a name nobody lists. */
async function usageOf(kind: RefKind, value: string): Promise<number> {
  switch (kind) {
    case RefKind.CITY:
      return (
        (await prisma.college.count({ where: { city: value } })) +
        (await prisma.company.count({ where: { city: value } }))
      );
    case RefKind.STATE:
      return (
        (await prisma.college.count({ where: { state: value } })) +
        (await prisma.company.count({ where: { state: value } }))
      );
    case RefKind.NAAC_GRADE:
      return prisma.college.count({ where: { naacGrade: value } });
    case RefKind.GENDER:
      return prisma.candidate.count({ where: { gender: value } });
  }
}

/** GET /api/admin/reference?kind=CITY */
referenceRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const { kind, includeRetired } = z
      .object({
        kind: z.nativeEnum(RefKind).optional(),
        includeRetired: z.enum(['true', 'false']).default('false'),
      })
      .parse(req.query);

    const values = await prisma.refValue.findMany({
      where: {
        ...(kind ? { kind } : {}),
        ...(includeRetired === 'true' ? {} : { isActive: true }),
      },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }, { value: 'asc' }],
    });

    const usage = await Promise.all(values.map((v) => usageOf(v.kind, v.value)));

    res.json({
      values: values.map((v, i) => ({
        id: v.id,
        kind: v.kind,
        value: v.value,
        isActive: v.isActive,
        position: v.position,
        inUse: usage[i]!,
      })),
    });
  }),
);

/** POST /api/admin/reference/:kind */
referenceRouter.post(
  '/:kind',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { kind } = z.object({ kind: z.nativeEnum(RefKind) }).parse(req.params);
    const { value, position } = valueSchema.parse(req.body);

    const existing = await prisma.refValue.findFirst({ where: { kind, value } });
    if (existing) {
      if (!existing.isActive) {
        // Adding a retired name back brings it back, which is what somebody
        // typing it again actually means.
        const revived = await prisma.refValue.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
        res.json({ value: revived, revived: true });
        return;
      }
      throw conflict(`${existing.value} is already on that list.`);
    }

    res.status(201).json({
      value: await prisma.refValue.create({ data: { kind, value, position: position ?? 0 } }),
    });
  }),
);

/** PATCH /api/admin/reference/:id — rename, reorder, retire or restore */
referenceRouter.patch(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const data = valueSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const row = await prisma.refValue.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('No such value.');

    if (data.value && data.value !== row.value) {
      const clash = await prisma.refValue.findFirst({
        where: { kind: row.kind, value: data.value, id: { not: row.id } },
      });
      if (clash) throw conflict(`${clash.value} is already on that list.`);

      /*
       * Renaming carries the records with it.
       *
       * These are matched as plain strings on colleges, companies and
       * students, so a rename that changed only this row would leave every
       * one of them pointing at a name the portal no longer lists.
       */
      const to = data.value;

      if (row.kind === RefKind.CITY) {
        await prisma.$transaction([
          prisma.college.updateMany({ where: { city: row.value }, data: { city: to } }),
          prisma.company.updateMany({ where: { city: row.value }, data: { city: to } }),
        ]);
      } else if (row.kind === RefKind.STATE) {
        await prisma.$transaction([
          prisma.college.updateMany({ where: { state: row.value }, data: { state: to } }),
          prisma.company.updateMany({ where: { state: row.value }, data: { state: to } }),
        ]);
      } else if (row.kind === RefKind.NAAC_GRADE) {
        await prisma.college.updateMany({
          where: { naacGrade: row.value },
          data: { naacGrade: to },
        });
      } else {
        await prisma.candidate.updateMany({ where: { gender: row.value }, data: { gender: to } });
      }
    }

    res.json({
      value: await prisma.refValue.update({
        where: { id: row.id },
        data: {
          ...(data.value ? { value: data.value } : {}),
          ...(data.position !== undefined ? { position: data.position } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      }),
    });
  }),
);

/** DELETE /api/admin/reference/:id — only while nothing carries it */
referenceRouter.delete(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const row = await prisma.refValue.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('No such value.');

    const inUse = await usageOf(row.kind, row.value);
    if (inUse > 0) {
      throw conflict(
        `${inUse} record${inUse === 1 ? '' : 's'} still use ${row.value}. Retire it instead — it stays on those and disappears from the forms.`,
      );
    }

    await prisma.refValue.delete({ where: { id: row.id } });
    res.status(204).end();
  }),
);
