import { Router } from 'express';
import { CompanyStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCompanyId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import { loadCandidateContext, visibleJobWhere } from '../jobs/visibility.js';
import { companyFacts } from './companyFacts.js';
import { photosOf } from '../company/company.schemas.js';
import { assertPageOwner, postsCursorSchema, publishedPosts } from './companyPosts.routes.js';

/**
 * The company page: what the company says, what the platform measures, what
 * seniors say.
 *
 * Two audiences. A student reads a verified company's page - only where their
 * institution has the company page switched on. A company edits its own
 * words; the measured layer is shown to it read-only, because the only way to
 * change a measurement is to change what is being measured.
 */
export const companyPageRouter = Router();

/** The words a company writes about itself - never the facts beside them. */
const SAYS_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  coverUrl: true,
  headline: true,
  photos: true,
  about: true,
  whyJoin: true,
  howWeHire: true,
  website: true,
  careersUrl: true,
  linkedinUrl: true,
  sizeBand: true,
  city: true,
  foundedYear: true,
  industry: { select: { name: true } },
} as const;

/** Campus stories arrive in Phase 2; until then the layer says so plainly. */
const SENIORS = {
  stories: [] as unknown[],
  note: 'Interview experiences and intern diaries from your seniors arrive with Campus stories.',
};

/**
 * GET /api/showcase/companies/:id - a student reading a company's page.
 *
 * Only a verified company has a page: one still under review, rejected or
 * suspended answers exactly like one that does not exist.
 */
companyPageRouter.get(
  '/companies/:id',
  requireRole('CANDIDATE'),
  requireModule('showcase.company'),
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);

    const company = await prisma.company.findFirst({
      where: { id: req.params.id, status: CompanyStatus.VERIFIED },
      select: SAYS_SELECT,
    });
    if (!company) throw notFound('No such company.');

    // Only roles this student could open anyway - the page is no back door
    // into another college's postings.
    const ctx = await loadCandidateContext(candidateId);
    const [measured, roles, feed] = await Promise.all([
      companyFacts(company.id),
      prisma.job.findMany({
        where: { AND: [visibleJobWhere(ctx), { companyId: company.id }] },
        orderBy: { deadline: 'asc' },
        select: { id: true, title: true, location: true, deadline: true, jobType: true },
      }),
      // The newest few travel with the page; the rest are asked for only if
      // somebody scrolls that far.
      publishedPosts(company.id, { limit: 3 }),
    ]);

    const { industry, photos, ...says } = company;
    res.json({
      says: { ...says, industry: industry?.name ?? null, photos: photosOf(photos) },
      measured,
      seniors: SENIORS,
      roles,
      posts: feed.posts,
      postsCursor: feed.nextCursor,
    });
  }),
);

/**
 * GET /api/showcase/companies/:id/posts - the rest of a company's feed.
 *
 * Read by students and by placement cells: a college deciding whether to
 * accept a role from a company is exactly who should be able to see what that
 * company has been saying.
 */
companyPageRouter.get(
  '/companies/:id/posts',
  requireRole('CANDIDATE', 'CAMPUS'),
  requireModule('showcase.company'),
  asyncHandler(async (req, res) => {
    const companyId = req.params.id!;
    await assertPageOwner(companyId);

    const { before, limit } = postsCursorSchema.parse(req.query);
    const feed = await publishedPosts(companyId, {
      ...(before ? { before: new Date(before) } : {}),
      ...(limit ? { limit } : {}),
    });

    res.json({ posts: feed.posts, nextCursor: feed.nextCursor });
  }),
);

/** GET /api/showcase/mine - a company's own page, as its editor sees it. */
companyPageRouter.get(
  '/mine',
  requireRole('COMPANY'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { ...SAYS_SELECT, status: true },
    });
    const { industry, photos, ...says } = company;
    const feed = await publishedPosts(companyId, { limit: 3 });
    res.json({
      says: { ...says, industry: industry?.name ?? null, photos: photosOf(photos) },
      measured: await companyFacts(companyId),
      seniors: SENIORS,
      posts: feed.posts,
      postsCursor: feed.nextCursor,
    });
  }),
);

const pageSchema = z.object({
  whyJoin: z.string().trim().max(2000, 'Keep it under 2,000 characters.').optional().or(z.literal('')),
  howWeHire: z.string().trim().max(2000, 'Keep it under 2,000 characters.').optional().or(z.literal('')),
});

/**
 * PUT /api/showcase/mine - the company's own words.
 *
 * Accepts only the two text fields. Anything else in the body - a measured
 * figure, a status - is ignored by the schema, so no request can reach the
 * layer the company does not write.
 */
companyPageRouter.put(
  '/mine',
  requireRole('COMPANY'),
  can('company:profile'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const data = pageSchema.parse(req.body);
    const company = await prisma.company.update({
      where: { id: companyId },
      data: { whyJoin: data.whyJoin || null, howWeHire: data.howWeHire || null },
      select: { ...SAYS_SELECT, status: true },
    });
    const { industry, photos, ...says } = company;
    res.json({
      says: { ...says, industry: industry?.name ?? null, photos: photosOf(photos) },
      measured: await companyFacts(companyId),
      seniors: SENIORS,
    });
  }),
);
