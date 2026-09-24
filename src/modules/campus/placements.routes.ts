import { Router } from 'express';
import { z } from 'zod';
import { PlacementType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';

export const placementsRouter = Router();

placementsRouter.use(requireRole('CAMPUS'));

const createSchema = z.object({
  name: z.string().trim().min(2, 'Give the season a name.').max(140),
  type: z.nativeEnum(PlacementType).default(PlacementType.FINAL),
  year: z.coerce.number().int().min(2000).max(2100),
  oneOfferRule: z.boolean().default(true),
  batchIds: z.array(z.string()).default([]),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  isOpen: z.boolean().optional(),
  oneOfferRule: z.boolean().optional(),
});

/** Layer 3, as a query. A drive from another college simply does not match. */
async function ownedPlacement(collegeId: string, id: string) {
  const placement = await prisma.placement.findFirst({ where: { id, collegeId } });
  if (!placement) throw notFound('No such placement season.');
  return placement;
}

/** GET /api/campus/placements */
placementsRouter.get(
  '/',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    const placements = await prisma.placement.findMany({
      where: { collegeId },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
      include: {
        batches: { select: { id: true, name: true, _count: { select: { memberships: true } } } },
        _count: { select: { jobPostings: true, applications: true } },
      },
    });

    res.json({
      placements: placements.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        year: p.year,
        isOpen: p.isOpen,
        oneOfferRule: p.oneOfferRule,
        batchCount: p.batches.length,
        studentCount: p.batches.reduce((n, b) => n + b._count.memberships, 0),
        jobCount: p._count.jobPostings,
        applicationCount: p._count.applications,
      })),
    });
  }),
);

/** POST /api/campus/placements */
placementsRouter.post(
  '/',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const data = createSchema.parse(req.body);

    const clash = await prisma.placement.findFirst({
      where: { collegeId, name: data.name, year: data.year },
    });
    if (clash) throw conflict('A season with that name already exists for that year.');

    // Only this college's batches may be attached, whatever ids were sent.
    const validBatches = await prisma.batch.findMany({
      where: { collegeId, id: { in: data.batchIds } },
      select: { id: true },
    });

    const placement = await prisma.placement.create({
      data: {
        collegeId,
        name: data.name,
        type: data.type,
        year: data.year,
        oneOfferRule: data.oneOfferRule,
        batches: { connect: validBatches.map((b) => ({ id: b.id })) },
      },
    });

    res.status(201).json({ placement });
  }),
);

/** GET /api/campus/placements/:id */
placementsRouter.get(
  '/:id',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    await ownedPlacement(collegeId, req.params.id!);

    const [placement, allBatches] = await Promise.all([
      prisma.placement.findUniqueOrThrow({
        where: { id: req.params.id },
        include: {
          batches: {
            orderBy: [{ graduationYear: 'desc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              course: true,
              graduationYear: true,
              _count: { select: { memberships: true } },
            },
          },
          _count: { select: { jobPostings: true, applications: true } },
        },
      }),
      prisma.batch.findMany({
        where: { collegeId },
        orderBy: [{ graduationYear: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, course: true, graduationYear: true },
      }),
    ]);

    const batchIds = placement.batches.map((b) => b.id);

    // How many of the students in this drive are actually eligible to apply.
    const verified = batchIds.length
      ? await prisma.batchMembership.count({
          where: { batchId: { in: batchIds }, isFrozen: true },
        })
      : 0;

    const studentCount = placement.batches.reduce((n, b) => n + b._count.memberships, 0);

    res.json({
      placement: {
        id: placement.id,
        name: placement.name,
        type: placement.type,
        year: placement.year,
        isOpen: placement.isOpen,
        oneOfferRule: placement.oneOfferRule,
        batches: placement.batches.map((b) => ({
          id: b.id,
          name: b.name,
          course: b.course,
          graduationYear: b.graduationYear,
          studentCount: b._count.memberships,
        })),
        studentCount,
        verifiedCount: verified,
        jobCount: placement._count.jobPostings,
        applicationCount: placement._count.applications,
      },
      allBatches,
    });
  }),
);

/** PATCH /api/campus/placements/:id */
placementsRouter.patch(
  '/:id',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const placement = await ownedPlacement(collegeId, req.params.id!);
    const data = updateSchema.parse(req.body);

    const updated = await prisma.placement.update({
      where: { id: placement.id },
      data,
    });

    res.json({ placement: updated });
  }),
);

/** PUT /api/campus/placements/:id/batches — replace the whole set */
placementsRouter.put(
  '/:id/batches',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const placement = await ownedPlacement(collegeId, req.params.id!);
    const { batchIds } = z.object({ batchIds: z.array(z.string()) }).parse(req.body);

    const valid = await prisma.batch.findMany({
      where: { collegeId, id: { in: batchIds } },
      select: { id: true },
    });

    await prisma.placement.update({
      where: { id: placement.id },
      data: { batches: { set: valid.map((b) => ({ id: b.id })) } },
    });

    res.json({ batchCount: valid.length });
  }),
);

/** DELETE /api/campus/placements/:id — only while nothing depends on it */
placementsRouter.delete(
  '/:id',
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const placement = await ownedPlacement(collegeId, req.params.id!);

    const [postings, applications] = await Promise.all([
      prisma.jobPosting.count({ where: { placementId: placement.id } }),
      prisma.application.count({ where: { placementId: placement.id } }),
    ]);

    if (postings > 0 || applications > 0) {
      throw conflict(
        'This season already has jobs or applications against it. Close it instead of deleting it.',
      );
    }

    await prisma.placement.delete({ where: { id: placement.id } });
    res.status(204).end();
  }),
);

/**
 * GET /api/campus/placements/:id/summary
 * What a placement cell is actually judged on: how many of its students got
 * placed, by whom, and what the offers looked like.
 */
placementsRouter.get(
  '/:id/summary',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const placement = await ownedPlacement(collegeId, req.params.id!);

    const [batches, byStatus, companies, offers] = await Promise.all([
      prisma.batch.findMany({
        where: { placements: { some: { id: placement.id } } },
        select: { id: true, _count: { select: { memberships: true } } },
      }),
      prisma.application.groupBy({
        by: ['status'],
        where: { placementId: placement.id },
        _count: { _all: true },
      }),
      prisma.jobPosting.findMany({
        where: { placementId: placement.id, status: 'ACCEPTED' },
        select: { job: { select: { companyId: true, ctcMin: true, ctcMax: true } } },
      }),
      prisma.application.findMany({
        where: {
          placementId: placement.id,
          status: { in: ['OFFERED', 'ACCEPTED', 'HIRED'] },
        },
        select: {
          status: true,
          candidateId: true,
          job: { select: { title: true, ctcMax: true, company: { select: { name: true } } } },
        },
      }),
    ]);

    const studentCount = batches.reduce((n, b) => n + b._count.memberships, 0);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    // A student is "placed" once they have committed, not merely been offered.
    const placedIds = new Set(
      offers.filter((o) => o.status === 'ACCEPTED' || o.status === 'HIRED').map((o) => o.candidateId),
    );

    const ctcs = offers
      .map((o) => (o.job.ctcMax ? Number(o.job.ctcMax) : null))
      .filter((v): v is number => v !== null);

    res.json({
      summary: {
        studentCount,
        placed: placedIds.size,
        placedPercent: studentCount ? Math.round((placedIds.size / studentCount) * 100) : 0,
        companiesVisiting: new Set(companies.map((c) => c.job.companyId)).size,
        applications: byStatus.reduce((n, r) => n + r._count._all, 0),
        byStatus: counts,
        highestCtc: ctcs.length ? Math.max(...ctcs) : null,
        averageCtc: ctcs.length ? Math.round(ctcs.reduce((a, b) => a + b, 0) / ctcs.length) : null,
        recentOffers: offers.slice(0, 10).map((o) => ({
          company: o.job.company.name,
          role: o.job.title,
          status: o.status,
        })),
      },
    });
  }),
);
