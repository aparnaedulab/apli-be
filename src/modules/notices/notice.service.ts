import { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * Notices from the institution.
 *
 * Operations writes one thing and says who it is for - students, companies,
 * the placement cells, or any combination. Everything else here follows from
 * the fact that those three audiences are not reachable the same way.
 *
 * Students and placement cells belong to the institution: they are reached
 * through the tenant, like every other campus row.
 *
 * Companies do not. A company is shared by the whole platform - one row that
 * recruits at many universities - so "tell the companies" can only honestly
 * mean the ones that have actually posted a role to one of this institution's
 * drives. Reading it any wider would let one university broadcast to the
 * entire marketplace, which is not a feature anybody asked for and is the kind
 * of thing that gets a platform blocked.
 */

export interface NoticeInput {
  title: string;
  body: string;
  toStudents: boolean;
  toCompanies: boolean;
  toColleges: boolean;
  expiresAt?: Date | null;
}

/** A notice that is live right now: published, not expired, not taken down. */
function live(now: Date) {
  return {
    retractedAt: null,
    publishedAt: { lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

const SELECT = {
  id: true,
  title: true,
  body: true,
  toStudents: true,
  toCompanies: true,
  toColleges: true,
  publishedAt: true,
  expiresAt: true,
  retractedAt: true,
  author: { select: { fullName: true } },
  tenant: { select: { name: true, shortName: true } },
} as const;

export async function createNotice(
  tenantId: string,
  authorId: string | undefined,
  input: NoticeInput,
) {
  if (!input.toStudents && !input.toCompanies && !input.toColleges) {
    // A notice addressed to nobody is not a notice. Caught here as well as in
    // the schema, because the schema cannot express "at least one of three".
    throw badRequest('Choose at least one audience for this notice.');
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw badRequest('That expiry is already in the past.');
  }

  return prisma.notice.create({
    data: {
      tenantId,
      authorId: authorId ?? null,
      title: input.title.trim(),
      body: input.body.trim(),
      toStudents: input.toStudents,
      toCompanies: input.toCompanies,
      toColleges: input.toColleges,
      expiresAt: input.expiresAt ?? null,
    },
    select: SELECT,
  });
}

/** Everything the institution has posted, live or not - this is the admin's own list. */
export async function listNotices(tenantId: string) {
  const now = new Date();
  const rows = await prisma.notice.findMany({
    where: { tenantId },
    orderBy: { publishedAt: 'desc' },
    take: 100,
    select: SELECT,
  });

  return rows.map((n) => ({
    ...n,
    status: n.retractedAt
      ? ('retracted' as const)
      : n.expiresAt && n.expiresAt <= now
        ? ('expired' as const)
        : ('live' as const),
  }));
}

export async function retractNotice(tenantId: string, id: string) {
  // Scoped in the update itself: an id from another institution matches
  // nothing rather than being found and then refused.
  const done = await prisma.notice.updateMany({
    where: { id, tenantId, retractedAt: null },
    data: { retractedAt: new Date() },
  });
  if (done.count === 0) throw notFound('That notice is not there, or is already taken down.');
}

export async function deleteNotice(tenantId: string, id: string) {
  const done = await prisma.notice.deleteMany({ where: { id, tenantId } });
  if (done.count === 0) throw notFound('That notice is not there.');
}

/**
 * The notices the signed-in person should see.
 *
 * Returns [] rather than throwing for a session with nothing to match on - a
 * dashboard asking "anything for me?" should get "no", not a 400.
 */
export async function noticesFor(session: {
  role?: Role;
  tenantId?: string;
  companyId?: string;
}): Promise<Awaited<ReturnType<typeof listNotices>>[number][]> {
  const now = new Date();

  if (session.role === Role.COMPANY) {
    if (!session.companyId) return [];
    // The institutions this company actually recruits at: it has put a role in
    // front of one of their drives. PENDING counts - the company chose to
    // approach them, and the notice may well be about that very request.
    const postings = await prisma.jobPosting.findMany({
      where: { job: { companyId: session.companyId } },
      select: { placement: { select: { college: { select: { tenantId: true } } } } },
      distinct: ['placementId'],
      take: 500,
    });
    const tenantIds = [...new Set(postings.map((p) => p.placement.college.tenantId))];
    if (tenantIds.length === 0) return [];

    return prisma.notice.findMany({
      where: { tenantId: { in: tenantIds }, toCompanies: true, ...live(now) },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: SELECT,
    }) as never;
  }

  if (!session.tenantId) return [];

  const audience =
    session.role === Role.CANDIDATE
      ? { toStudents: true }
      : session.role === Role.CAMPUS
        ? { toColleges: true }
        : // An institution admin sees everything their own institution posted,
          // including the ones aimed elsewhere - they are the ones who sent it.
          {};

  return prisma.notice.findMany({
    where: { tenantId: session.tenantId, ...audience, ...live(now) },
    orderBy: { publishedAt: 'desc' },
    take: 20,
    select: SELECT,
  }) as never;
}
