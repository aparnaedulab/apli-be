import { PostAuthorKind, PostingStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden } from '../../lib/errors.js';
import { isAssetRef } from '../tenants/assets.js';

/**
 * The campus feed.
 *
 * Fenced at the college, like everything else on this platform. A story is
 * read only by its own college's students; a job is seen only where the cell
 * accepted it; a student is findable by a recruiter only having both chosen
 * it and consented. A feed that crossed colleges would be the single hole in
 * an otherwise consistent wall - and somebody writing about a rejection does
 * not expect it reaching a recruiter at another campus.
 *
 * So `collegeId` on a post is not a label. It is who the post is for, and
 * every read here starts from the reader's own college rather than filtering
 * down to it afterwards.
 */

/** How many photographs or clips one post may carry. */
export const MAX_MEDIA = 4;

export interface Media {
  url: string;
  kind: 'photo' | 'video';
}

/**
 * A post's media, whatever the column holds.
 *
 * Every entry has to be a reference this server issued. A URL somebody pasted
 * would be a page on the student side fetching from wherever it pointed, and
 * rubbish is dropped rather than rendered as a broken frame - the same
 * reasoning as a company's photographs.
 */
export function mediaOf(value: unknown): Media[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (m): m is Media =>
        Boolean(m) &&
        typeof (m as Media).url === 'string' &&
        isAssetRef((m as Media).url) &&
        ((m as Media).kind === 'photo' || (m as Media).kind === 'video'),
    )
    .slice(0, MAX_MEDIA)
    .map((m) => ({ url: m.url, kind: m.kind }));
}

/**
 * Which college's feed this account reads.
 *
 * A student's own; a staff member's own. Nobody has two, and nobody chooses -
 * which is what makes the fence hold without a single filter in a handler.
 */
export async function collegeFor(session: {
  userId?: string;
  candidateId?: string;
  collegeId?: string;
}): Promise<string> {
  if (session.collegeId) return session.collegeId;

  if (session.candidateId) {
    const c = await prisma.candidate.findUnique({
      where: { id: session.candidateId },
      select: { collegeId: true },
    });
    if (c?.collegeId) return c.collegeId;
    throw forbidden('You are not on a college roster yet, so there is no feed to read.');
  }

  throw forbidden('This account is not attached to a college.');
}

/**
 * Companies whose posts belong on a college's feed.
 *
 * Only those the cell actually accepted a role from. A company with no drive
 * there has no business on that feed, and this is the same rule that already
 * decides which jobs a student sees.
 */
export async function companiesOn(collegeId: string): Promise<Set<string>> {
  const rows = await prisma.jobPosting.findMany({
    where: { status: PostingStatus.ACCEPTED, placement: { collegeId } },
    select: { job: { select: { companyId: true } } },
  });
  return new Set(rows.map((r) => r.job.companyId));
}

const include = {
  author: { select: { id: true, fullName: true, role: true } },
  comments: {
    where: { removedAt: null },
    orderBy: { createdAt: 'asc' as const },
    include: { author: { select: { id: true, fullName: true } } },
  },
  _count: { select: { likes: true } },
} satisfies Prisma.PostInclude;

type Loaded = Prisma.PostGetPayload<{ include: typeof include }>;

export const POST_INCLUDE = include;

/** One post, as the feed wants to read it. */
export function serialise(row: Loaded, me: string, likedByMe: boolean) {
  return {
    id: row.id,
    bodyHtml: row.bodyHtml,
    media: mediaOf(row.media),
    createdAt: row.createdAt,
    authorKind: row.authorKind,
    author: {
      id: row.author.id,
      /* The college speaks as itself, not as whoever was logged in. A cell
         announcement signed by one coordinator reads as their opinion. */
      name: row.authorKind === PostAuthorKind.COLLEGE ? 'Placement cell' : row.author.fullName,
    },
    mine: row.authorId === me,
    likes: row._count.likes,
    likedByMe,
    comments: row.comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      author: { id: c.author.id, name: c.author.fullName },
      mine: c.authorId === me,
    })),
  };
}

/** The feed, newest first, with the reader's own likes marked. */
export async function feedFor(collegeId: string, userId: string, take = 30, before?: Date) {
  const posts = await prisma.post.findMany({
    where: {
      collegeId,
      removedAt: null,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    include,
  });

  // One query for the reader's likes rather than one per post.
  const liked = new Set(
    (
      await prisma.postLike.findMany({
        where: { userId, postId: { in: posts.map((p) => p.id) } },
        select: { postId: true },
      })
    ).map((l) => l.postId),
  );

  return posts.map((p) => serialise(p, userId, liked.has(p.id)));
}
