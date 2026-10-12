import { Router } from 'express';
import { PartnerKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { requirePlatform } from '../tenants/tenant.context.js';

/**
 * The directory of universities and colleges behind "Where do you study?".
 *
 * Kept by the platform team, because a student may come from anywhere and
 * the list has to be there before they arrive - not built up from whatever
 * people type. Nothing here is deleted: a listing students already picked is
 * hidden instead, so it leaves the dropdown and stays on their records.
 */
export const listingsRouter = Router();

listingsRouter.use(requireRole('ADMIN'), requirePlatform);

const text = (label: string, min = 2) =>
  z.string().trim().min(min, `Enter the ${label}.`).max(191, `Keep the ${label} shorter.`);

const optional = z
  .string()
  .trim()
  .max(191)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const listingSchema = z.object({
  kind: z.nativeEnum(PartnerKind, { errorMap: () => ({ message: 'Choose university or college.' }) }),
  name: text('name', 3),
  city: text('city'),
  state: optional,
  affiliation: optional,
});

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  show: z.enum(['active', 'hidden', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/platform/listings */
listingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, show, page, pageSize } = listQuery.parse(req.query);

    const where: Prisma.CollegeListingWhereInput = {
      ...(show === 'all' ? {} : { isActive: show === 'active' }),
      ...(q
        ? {
            OR: [
              { name: { contains: q } },
              { city: { contains: q } },
              { state: { contains: q } },
              { affiliation: { contains: q } },
            ],
          }
        : {}),
    };

    const [rows, total, active, hidden] = await Promise.all([
      prisma.collegeListing.findMany({
        where,
        orderBy: [{ name: 'asc' }, { city: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { candidates: true } } },
      }),
      prisma.collegeListing.count({ where }),
      prisma.collegeListing.count({ where: { isActive: true } }),
      prisma.collegeListing.count({ where: { isActive: false } }),
    ]);

    res.json({
      listings: rows.map(({ _count, ...l }) => ({ ...l, students: _count.candidates })),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      counts: { active, hidden },
    });
  }),
);

/** POST /api/platform/listings */
listingsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = listingSchema.parse(req.body);

    const existing = await prisma.collegeListing.findUnique({
      where: { name_city: { name: body.name, city: body.city } },
    });
    if (existing) {
      if (!existing.isActive) {
        // Adding a hidden one again means "show it again".
        const listing = await prisma.collegeListing.update({
          where: { id: existing.id },
          data: { ...body, isActive: true },
        });
        res.json({ listing, revived: true });
        return;
      }
      throw conflict(`${existing.name}, ${existing.city} is already on the list.`);
    }

    res.status(201).json({ listing: await prisma.collegeListing.create({ data: body }) });
  }),
);

/**
 * POST /api/platform/listings/bulk
 *
 * Many at once, from a pasted list. Rows already on the list are skipped
 * rather than failing the batch, and the answer says how many of each.
 */
listingsRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const { rows } = z
      .object({ rows: z.array(listingSchema).min(1, 'Paste at least one row.').max(1000, 'Up to 1,000 rows at a time.') })
      .parse(req.body);

    // The same college twice in one paste is one college.
    const seen = new Set<string>();
    const unique = rows.filter((r) => {
      const key = `${r.name.toLowerCase()}|${r.city.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const { count } = await prisma.collegeListing.createMany({ data: unique, skipDuplicates: true });

    res.status(201).json({ added: count, skipped: rows.length - count });
  }),
);

/** PATCH /api/platform/listings/:id - correct it, or hide and show it */
listingsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = listingSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const listing = await prisma.collegeListing.findUnique({ where: { id: req.params.id } });
    if (!listing) throw notFound('No such college on the list.');

    const name = body.name ?? listing.name;
    const city = body.city ?? listing.city;
    if (name !== listing.name || city !== listing.city) {
      const clash = await prisma.collegeListing.findUnique({ where: { name_city: { name, city } } });
      if (clash && clash.id !== listing.id) throw conflict(`${name}, ${city} is already on the list.`);
    }

    res.json({ listing: await prisma.collegeListing.update({ where: { id: listing.id }, data: body }) });
  }),
);
