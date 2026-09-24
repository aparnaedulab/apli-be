import { Router } from 'express';
import { z } from 'zod';
import { PostAuthorKind, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { hasPermission } from '../roles/can.js';
import { imageUpload } from '../../lib/upload.js';
import { saveTenantAsset } from '../tenants/assets.js';
import { MAX_BODY, cleanPostHtml, textOf } from '../showcase/postHtml.js';
import { MAX_MEDIA, collegeFor, feedFor, mediaOf, POST_INCLUDE, serialise } from './feed.service.js';

/**
 * The campus feed.
 *
 * Students and their own placement cell, on one college's feed. Every handler
 * starts from the reader's college rather than filtering down to it, so there
 * is no path through this router that reaches another college's posts.
 *
 * Companies are not here yet. They can already speak on their own company
 * page, and letting them onto a campus feed needs its own answer to which
 * college and on whose say-so - the accepted posting is the rule, but it is
 * worth building deliberately rather than as a fifth branch in this file.
 */
export const feedRouter = Router();

/** Both roles read the same feed; neither can reach another college's. */
const anyReader = requireRole('CANDIDATE', 'CAMPUS');

/** GET /api/feed */
feedRouter.get(
  '/',
  anyReader,
  asyncHandler(async (req, res) => {
    const collegeId = await collegeFor(req.session);
    const { before } = z.object({ before: z.string().datetime().optional() }).parse(req.query);

    res.json({
      posts: await feedFor(collegeId, req.session.userId!, 30, before ? new Date(before) : undefined),
      /* Whether this reader may speak as the college, so the composer can
         offer it rather than the student discovering a refusal. */
      canPostAsCollege: await hasPermission(req, 'feed:moderate'),
    });
  }),
);

/**
 * POST /api/feed/media
 *
 * A photograph or a clip, sniffed by its actual bytes and stored under a
 * random name. What comes back is a reference this server issued, which is
 * the only thing a post will accept.
 */
feedRouter.post(
  '/media',
  anyReader,
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    await collegeFor(req.session);
    if (!req.file) throw badRequest('No file came through.');

    const kind = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const url = await saveTenantAsset(kind, req.file.buffer);
    res.status(201).json({ url, kind });
  }),
);

/** POST /api/feed */
feedRouter.post(
  '/',
  anyReader,
  asyncHandler(async (req, res) => {
    const collegeId = await collegeFor(req.session);
    const body = z
      .object({
        bodyHtml: z.string().max(MAX_BODY),
        media: z.array(z.object({ url: z.string(), kind: z.enum(['photo', 'video']) })).max(MAX_MEDIA).optional(),
        /** Speak as the college rather than as yourself. */
        asCollege: z.boolean().default(false),
      })
      .parse(req.body);

    if (body.asCollege && !(await hasPermission(req, 'feed:moderate'))) {
      throw forbidden('Only the placement cell can post as the college.');
    }

    /*
     * Sanitised on the way in, against the same allowlist a company post
     * goes through. What is judged empty is the words inside, not the
     * markup: a box holding only <p><br></p> is a box nobody wrote in.
     */
    const bodyHtml = cleanPostHtml(body.bodyHtml);
    if (textOf(bodyHtml).trim() === '' && (body.media ?? []).length === 0) {
      throw badRequest('Write something, or add a photo.');
    }

    const created = await prisma.post.create({
      data: {
        collegeId,
        authorId: req.session.userId!,
        authorKind: body.asCollege ? PostAuthorKind.COLLEGE : PostAuthorKind.STUDENT,
        bodyHtml,
        // Filtered rather than trusted: only references this server issued.
        media: mediaOf(body.media ?? []) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    /* Read back with everything a feed row carries, so the screen that just
       posted gets the same shape as the ones it already holds. */
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: created.id },
      include: POST_INCLUDE,
    });

    res.status(201).json({ post: serialise(post, req.session.userId!, false) });
  }),
);

/** One post on the reader's own college feed, or nothing. */
async function onMyFeed(req: { session: { userId?: string; candidateId?: string; collegeId?: string } }, id: string) {
  const collegeId = await collegeFor(req.session);
  const post = await prisma.post.findFirst({ where: { id, collegeId, removedAt: null } });
  if (!post) throw notFound('No such post.');
  return post;
}

/** POST /api/feed/:id/like — idempotent, because a double tap is one like. */
feedRouter.post(
  '/:id/like',
  anyReader,
  asyncHandler(async (req, res) => {
    const post = await onMyFeed(req, req.params.id!);
    await prisma.postLike.upsert({
      where: { postId_userId: { postId: post.id, userId: req.session.userId! } },
      update: {},
      create: { postId: post.id, userId: req.session.userId! },
    });
    res.json({ likes: await prisma.postLike.count({ where: { postId: post.id } }), likedByMe: true });
  }),
);

/** DELETE /api/feed/:id/like */
feedRouter.delete(
  '/:id/like',
  anyReader,
  asyncHandler(async (req, res) => {
    const post = await onMyFeed(req, req.params.id!);
    await prisma.postLike.deleteMany({ where: { postId: post.id, userId: req.session.userId! } });
    res.json({ likes: await prisma.postLike.count({ where: { postId: post.id } }), likedByMe: false });
  }),
);

/** POST /api/feed/:id/comments */
feedRouter.post(
  '/:id/comments',
  anyReader,
  asyncHandler(async (req, res) => {
    const post = await onMyFeed(req, req.params.id!);
    const { body } = z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body);

    const comment = await prisma.postComment.create({
      data: { postId: post.id, authorId: req.session.userId!, body },
      include: { author: { select: { id: true, fullName: true } } },
    });

    res.status(201).json({
      comment: {
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        author: { id: comment.author.id, name: comment.author.fullName },
        mine: true,
      },
    });
  }),
);

/**
 * DELETE /api/feed/:id
 *
 * Your own, always. Anybody else's only with the cell's capability - and
 * taken down rather than deleted, so a cell that removes a student's post
 * leaves a record that it did and why.
 */
feedRouter.delete(
  '/:id',
  anyReader,
  asyncHandler(async (req, res) => {
    const post = await onMyFeed(req, req.params.id!);
    const mine = post.authorId === req.session.userId;

    if (!mine && !(await hasPermission(req, 'feed:moderate'))) {
      throw forbidden('You can only take down your own posts.');
    }

    const { why } = z.object({ why: z.string().trim().max(500).optional() }).parse(req.body ?? {});

    await prisma.post.update({
      where: { id: post.id },
      data: {
        removedAt: new Date(),
        removedById: req.session.userId!,
        removedWhy: mine ? null : why || 'Taken down by the placement cell.',
      },
    });

    res.json({ removed: true });
  }),
);

/** DELETE /api/feed/comments/:id */
feedRouter.delete(
  '/comments/:id',
  anyReader,
  asyncHandler(async (req, res) => {
    const collegeId = await collegeFor(req.session);
    const comment = await prisma.postComment.findFirst({
      where: { id: req.params.id!, removedAt: null, post: { collegeId } },
    });
    if (!comment) throw notFound('No such comment.');

    if (comment.authorId !== req.session.userId && !(await hasPermission(req, 'feed:moderate'))) {
      throw forbidden('You can only take down your own comments.');
    }

    await prisma.postComment.update({
      where: { id: comment.id },
      data: { removedAt: new Date() },
    });

    res.json({ removed: true });
  }),
);
