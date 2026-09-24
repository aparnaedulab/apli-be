import { Router } from 'express';
import { z } from 'zod';
import { CompanyStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { isAssetRef, saveTenantAsset } from '../tenants/assets.js';
import { postMediaUpload } from '../../lib/upload.js';
import { cleanPostHtml } from './postHtml.js';

/**
 * A company's posts: the part of its page that moves.
 *
 * The profile says what a company is; posts say what it has been doing. One
 * way on purpose - a company writes, students and placement cells read. There
 * are no likes, no comments and no follower counts, because none of them
 * would help a student decide where to apply, and each would be one more
 * thing for a company to game.
 */

export const companyPostsRouter = Router();

companyPostsRouter.use(requireRole('COMPANY'));

/** The most a post carries. Past four, a page stops being read and is scrolled. */
export const MAX_MEDIA = 4;

const mediaSchema = z
  .object({
    kind: z.enum(['image', 'video']),
    url: z
      .string()
      .trim()
      .refine((v) => isAssetRef(v) || /^https:\/\/\S+$/i.test(v), 'Upload the file, or give an https link to it.'),
    caption: z.string().trim().max(120, 'Keep a caption under 120 characters.').optional().or(z.literal('')),
  })
  .strict();

const postSchema = z.object({
  title: z.string().trim().max(140, 'Keep the title under 140 characters.').optional().or(z.literal('')),
  bodyHtml: z.string().max(200_000, 'That post is too long.'),
  media: z.array(mediaSchema).max(MAX_MEDIA, `A post carries up to ${MAX_MEDIA} pictures or videos.`).optional(),
  /** Absent on an edit means "leave it as it is" - a draft stays a draft. */
  publish: z.boolean().optional(),
});

/** Captions are dropped when blank: words worth reading, or none. */
function toMedia(media: z.infer<typeof mediaSchema>[] | undefined) {
  return media?.map((m) => ({ kind: m.kind, url: m.url, ...(m.caption ? { caption: m.caption } : {}) }));
}

export interface PostMedia {
  kind: 'image' | 'video';
  url: string;
  caption?: string;
}

/** Whatever the JSON column holds, as a list a screen can map over. */
export function mediaOf(value: unknown): PostMedia[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is PostMedia => Boolean(m) && typeof (m as PostMedia).url === 'string')
    .slice(0, MAX_MEDIA)
    .map((m) => ({
      kind: m.kind === 'video' ? 'video' : 'image',
      url: m.url,
      ...(m.caption ? { caption: String(m.caption) } : {}),
    }));
}

const POST_SELECT = {
  id: true,
  title: true,
  bodyHtml: true,
  media: true,
  publishedAt: true,
  pinned: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PostRow = Prisma.CompanyPostGetPayload<{ select: typeof POST_SELECT }>;

export function toPost(row: PostRow) {
  return { ...row, media: mediaOf(row.media) };
}

/**
 * The company's own post, by id.
 *
 * Another company's post answers exactly like one that never existed. A 403
 * would confirm the id is real, which is a small thing to leak and a free one
 * to avoid.
 */
async function ownPost(companyId: string, id: string) {
  const post = await prisma.companyPost.findFirst({
    where: { id, companyId, deletedAt: null },
    select: { ...POST_SELECT, companyId: true },
  });
  if (!post) throw notFound('No such post.');
  return post;
}

/** GET /api/company/posts - everything this company has written, drafts included. */
companyPostsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const posts = await prisma.companyPost.findMany({
      where: { companyId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      select: POST_SELECT,
    });
    res.json({ posts: posts.map(toPost) });
  }),
);

/**
 * POST /api/company/posts
 *
 * Saved as a draft unless `publish` says otherwise, so a half-written update
 * is never one stray click away from every student on the platform.
 */
companyPostsRouter.post(
  '/',
  can('company:profile'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const data = postSchema.parse(req.body);

    const post = await prisma.companyPost.create({
      data: {
        companyId,
        authorId: req.session.userId ?? null,
        title: data.title || null,
        bodyHtml: cleanPostHtml(data.bodyHtml),
        media: toMedia(data.media) ?? [],
        publishedAt: data.publish ? new Date() : null,
      },
      select: POST_SELECT,
    });

    res.status(201).json({ post: toPost(post) });
  }),
);

/**
 * PATCH /api/company/posts/:id
 *
 * `publishedAt` is set the first time a post is published and left alone
 * afterwards: the page shows when something was said, not when a typo in it
 * was fixed.
 */
companyPostsRouter.patch(
  '/:id',
  can('company:profile'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const existing = await ownPost(companyId, req.params.id!);
    const data = postSchema.partial().parse(req.body);

    const post = await prisma.companyPost.update({
      where: { id: existing.id },
      data: {
        ...(data.title !== undefined ? { title: data.title || null } : {}),
        ...(data.bodyHtml !== undefined ? { bodyHtml: cleanPostHtml(data.bodyHtml) } : {}),
        ...(data.media !== undefined ? { media: toMedia(data.media) ?? [] } : {}),
        ...(data.publish === true && !existing.publishedAt ? { publishedAt: new Date() } : {}),
        // Unpublishing takes it off the page but keeps what was written.
        ...(data.publish === false ? { publishedAt: null, pinned: false } : {}),
      },
      select: POST_SELECT,
    });

    res.json({ post: toPost(post) });
  }),
);

/** DELETE /api/company/posts/:id - kept, but off every page from now on. */
companyPostsRouter.delete(
  '/:id',
  can('company:profile'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const existing = await ownPost(companyId, req.params.id!);

    await prisma.companyPost.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), pinned: false },
    });

    res.status(204).end();
  }),
);

/**
 * POST /api/company/posts/:id/pin - the one thing they want read first.
 *
 * At most one, and pinning another releases the last, so a page cannot end up
 * with four "most important" posts at the top of it.
 */
companyPostsRouter.post(
  '/:id/pin',
  can('company:profile'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const existing = await ownPost(companyId, req.params.id!);
    const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);

    if (pinned && !existing.publishedAt) {
      throw badRequest('Post it first: a draft cannot be pinned to your page.');
    }

    const post = await prisma.$transaction(async (tx) => {
      if (pinned) {
        await tx.companyPost.updateMany({ where: { companyId, pinned: true }, data: { pinned: false } });
      }
      return tx.companyPost.update({ where: { id: existing.id }, data: { pinned }, select: POST_SELECT });
    });

    res.json({ post: toPost(post) });
  }),
);

/**
 * POST /api/company/posts/media - a picture or a video for a post.
 *
 * Its own ceiling, well above the profile's: a video is worth fifty megabytes
 * and a logo is not. What the file actually is is decided from its bytes.
 */
companyPostsRouter.post(
  '/media',
  can('company:profile'),
  postMediaUpload.single('file'),
  asyncHandler(async (req, res) => {
    const kind = z.enum(['image', 'video']).parse(req.query.kind ?? 'image');
    if (!req.file) throw badRequest('Choose a file to upload.');

    const url = await saveTenantAsset(kind === 'video' ? 'video' : 'photo', req.file.buffer);
    res.status(201).json({ kind, url });
  }),
);

/* -------------------------------------------------------------------------- */
/* What everybody else reads                                                  */
/* -------------------------------------------------------------------------- */

/** The page shows this many without being asked; the rest come on request. */
export const PAGE_SIZE = 10;

/** Latest first, with whatever is pinned held at the top of the first page. */
export async function publishedPosts(companyId: string, opts: { before?: Date; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
  const live = { companyId, deletedAt: null, publishedAt: { not: null } } as const;

  // Only on the first page: a pinned post belongs at the top of the feed, not
  // repeated part-way down it.
  const pinned = opts.before
    ? null
    : await prisma.companyPost.findFirst({ where: { ...live, pinned: true }, select: POST_SELECT });

  const rest = await prisma.companyPost.findMany({
    where: {
      ...live,
      ...(pinned ? { id: { not: pinned.id } } : {}),
      ...(opts.before ? { publishedAt: { lt: opts.before } } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: POST_SELECT,
  });

  const posts = [...(pinned ? [pinned] : []), ...rest].map(toPost);
  const last = rest.at(-1);
  return {
    posts,
    // Null means there is nothing after this - the screen stops offering more.
    nextCursor: rest.length === limit && last?.publishedAt ? last.publishedAt.toISOString() : null,
  };
}

/** A verified company only, the same rule the page itself applies. */
export async function assertPageOwner(companyId: string) {
  const company = await prisma.company.findFirst({
    where: { id: companyId, status: CompanyStatus.VERIFIED },
    select: { id: true },
  });
  if (!company) throw notFound('No such company.');
}

export const postsCursorSchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE).optional(),
});
