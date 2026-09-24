import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The query behind the colleges screen.
 *
 * Search, filters, sort and page all resolve to one SQL statement. Nothing is
 * filtered in JavaScript, so the page stays the same speed at three hundred
 * colleges as at seven, and the count in "1-25 of 312" is the real one rather
 * than the length of whatever happened to be fetched.
 */
export const collegeQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  typeId: z.string().trim().optional(),
  city: z.string().trim().max(120).optional(),
  affiliated: z.enum(['yes', 'no']).optional(),
  hasTeam: z.enum(['yes', 'no']).optional(),
  sort: z.enum(['name', 'code', 'city', 'students', 'newest']).default('name'),
  page: z.coerce.number().int().min(1).default(1),
  // A floor of 1 rather than something arbitrary: the guard here is against
  // zero and against a page big enough to be a denial of service, not against
  // a caller wanting three rows.
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type CollegeQuery = z.infer<typeof collegeQuerySchema>;

/**
 * One tenant's colleges. The tenant is a required argument rather than an
 * optional filter, so no caller can list the whole platform by forgetting it.
 */
export async function listColleges(query: CollegeQuery, tenantId: string) {
  const where: Prisma.CollegeWhereInput = {
    tenantId,
    // One box searching the three things anyone actually knows: the name,
    // the code they call it by, and the city.
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q } },
            { code: { contains: query.q } },
            { city: { contains: query.q } },
          ],
        }
      : {}),
    ...(query.typeId ? { collegeTypeId: query.typeId } : {}),
    ...(query.city ? { city: query.city } : {}),
    ...(query.affiliated === 'yes' ? { NOT: { affiliation: null } } : {}),
    ...(query.affiliated === 'no' ? { affiliation: null } : {}),
    // A college with nobody who can sign in cannot do anything yet, which is
    // the one piece of operational state worth filtering on.
    ...(query.hasTeam === 'yes' ? { members: { some: {} } } : {}),
    ...(query.hasTeam === 'no' ? { members: { none: {} } } : {}),
  };

  const orderBy: Prisma.CollegeOrderByWithRelationInput =
    query.sort === 'newest'
      ? { createdAt: 'desc' }
      : query.sort === 'students'
        ? { candidates: { _count: 'desc' } }
        : query.sort === 'code'
          ? { code: 'asc' }
          : query.sort === 'city'
            ? { city: 'asc' }
            : { name: 'asc' };

  const [total, colleges, types, cities, students, batches, withoutTeam] = await Promise.all([
    prisma.college.count({ where }),
    prisma.college.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        collegeType: { select: { id: true, name: true } },
        _count: {
          select: { members: true, batches: true, placements: true, candidates: true },
        },
      },
    }),
    // The filter dropdowns are built from what exists rather than from a
    // hard-coded list, so they cannot offer a choice that returns nothing.
    prisma.collegeType.findMany({
      where: { colleges: { some: { tenantId } } },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        _count: { select: { colleges: { where: { tenantId } } } },
      },
    }),
    prisma.college.groupBy({
      by: ['city'],
      where: { tenantId },
      _count: true,
      orderBy: { city: 'asc' },
    }),

    // Totals for what is being looked at, not for the portal - filter to
    // Engineering and the numbers answer "how are the engineering colleges
    // doing", which is the question that made you filter.
    prisma.candidate.count({ where: { college: where } }),
    prisma.batch.count({ where: { college: where } }),
    prisma.college.count({ where: { ...where, members: { none: {} } } }),
  ]);

return {
  colleges: colleges.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      city: c.city,
      state: c.state,
      collegeTypeId: c.collegeType?.id ?? null,
      type: c.collegeType?.name ?? null,
      affiliation: c.affiliation,
      naacGrade: c.naacGrade,
      isVerified: c.isVerified,
      createdAt: c.createdAt,
      memberCount: c._count.members,
      batchCount: c._count.batches,
      placementCount: c._count.placements,
      studentCount: c._count.candidates,
    })),
    page: query.page,
    limit: query.limit,
    total,
    summary: { colleges: total, students, batches, withoutTeam },
    pages: Math.max(1, Math.ceil(total / query.limit)),
    filters: {
      types: types.map((t) => ({ id: t.id, name: t.name, count: t._count.colleges })),
      cities: cities.map((c) => ({ name: c.city, count: c._count })),
    },
  };
}
