import { CompanyStatus, ShowcaseVisibility, StoryStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { unreachableTenantIds } from '../companyAccess/companyAccess.service.js';

/**
 * Campus stories and the student showcase.
 *
 * Two rules run through all of it. A story belongs to one college: seniors
 * write for their own juniors, so a student only ever reads their own
 * college's stories, and only once the placement cell has published them.
 * And a student is only ever findable by a recruiter when they have both
 * chosen to be (visibility RECRUITERS) and said yes to it on the consent
 * centre - either one alone is not enough, and withdrawing consent hides them
 * at once without them having to remember the other switch.
 */

export const SHOWCASE_PURPOSE = 'showcase_to_recruiters';

/** How many invitations one company may send in a day. */
export const DAILY_INVITE_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/* Stories                                                                     */
/* -------------------------------------------------------------------------- */

export async function candidateCollege(candidateId: string) {
  const c = await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    select: { collegeId: true, userId: true, user: { select: { fullName: true } } },
  });
  return c;
}

type StoryRow = Prisma.CampusStoryGetPayload<{
  include: { candidate: { select: { user: { select: { fullName: true } } } } };
}>;

/**
 * A story as a student sees it. An anonymous author is "a senior" to other
 * students; the author always sees their own name, and the college sees the
 * real name through its own view, which does not go through here.
 */
export function storyForStudent(s: StoryRow, viewerCandidateId: string) {
  const mine = s.candidateId === viewerCandidateId;
  return {
    id: s.id,
    kind: s.kind,
    companyId: s.companyId,
    companyName: s.companyName,
    role: s.role,
    year: s.year,
    rounds: s.rounds,
    body: s.body,
    difficulty: s.difficulty,
    result: s.result,
    anonymous: s.anonymous,
    author: s.anonymous && !mine ? null : s.candidate.user.fullName,
    helpful: s.helpful,
    status: s.status,
    mine,
    createdAt: s.createdAt,
  };
}

export function storyForCollege(s: StoryRow) {
  return { ...storyForStudent(s, s.candidateId), mine: false, author: s.candidate.user.fullName };
}

export const STORY_INCLUDE = {
  candidate: { select: { user: { select: { fullName: true } } } },
} as const;

/* -------------------------------------------------------------------------- */
/* Showcase                                                                    */
/* -------------------------------------------------------------------------- */

/** The latest answer on the showcase purpose, for many students in one query. */
export async function showcaseConsent(candidateIds: string[]): Promise<Map<string, boolean>> {
  const rows = await prisma.consentRecord.findMany({
    where: { candidateId: { in: candidateIds }, purpose: SHOWCASE_PURPOSE },
    orderBy: { createdAt: 'desc' },
    select: { candidateId: true, granted: true },
  });
  const out = new Map<string, boolean>();
  for (const r of rows) if (!out.has(r.candidateId)) out.set(r.candidateId, r.granted);
  return out;
}

/** The tenants that have the student showcase switched on. */
async function showcaseTenants(): Promise<string[]> {
  const rows = await prisma.tenantModule.findMany({
    where: { moduleKey: 'showcase.student', enabled: true },
    select: { tenantId: true },
  });
  return rows.map((r) => r.tenantId);
}

export interface TalentFilter {
  course?: string;
  branch?: string;
  year?: number;
  skill?: string;
  collegeId?: string;
  q?: string;
}

/**
 * The students a recruiter may find. All three must hold: the student chose
 * RECRUITERS, their latest consent answer is yes, and their institution has
 * the showcase switched on. Contact details are never selected, so they
 * cannot leak through a later change to what is returned.
 *
 * Given the looking company, institutions that approve companies themselves
 * and have not approved this one drop out too: a company that may not send
 * those students a role should not be browsing them either.
 */
export async function discoverable(filter: TalentFilter, onlyCandidateId?: string, companyId?: string) {
  let tenants = await showcaseTenants();
  if (companyId) {
    const hidden = await unreachableTenantIds(companyId, tenants);
    tenants = tenants.filter((t) => !hidden.has(t));
  }
  if (tenants.length === 0) return [];

  const profiles = await prisma.showcaseProfile.findMany({
    where: {
      visibility: ShowcaseVisibility.RECRUITERS,
      ...(onlyCandidateId ? { candidateId: onlyCandidateId } : {}),
      candidate: {
        college: { tenantId: { in: tenants }, ...(filter.collegeId ? { id: filter.collegeId } : {}) },
        ...(filter.course ? { course: filter.course } : {}),
        ...(filter.branch ? { specialisation: filter.branch } : {}),
        ...(filter.year ? { graduationYear: filter.year } : {}),
        ...(filter.skill ? { skills: { some: { skill: { name: filter.skill } } } } : {}),
        ...(filter.q
          ? {
              OR: [
                { user: { fullName: { contains: filter.q } } },
                { headline: { contains: filter.q } },
              ],
            }
          : {}),
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: {
      candidateId: true,
      pitch: true,
      videoUrl: true,
      pinned: true,
      updatedAt: true,
      candidate: {
        select: {
          course: true,
          specialisation: true,
          graduationYear: true,
          headline: true,
          user: { select: { fullName: true } },
          college: { select: { id: true, name: true, code: true } },
          skills: { select: { skill: { select: { name: true } } } },
          projects: { select: { id: true, title: true, description: true, links: true } },
          batchMemberships: { where: { isFrozen: true }, select: { id: true }, take: 1 },
        },
      },
    },
  });

  const consent = await showcaseConsent(profiles.map((p) => p.candidateId));

  return profiles
    .filter((p) => consent.get(p.candidateId) === true)
    .slice(0, 60)
    .map((p) => {
      const pinned = Array.isArray(p.pinned) ? (p.pinned as string[]) : [];
      return {
        candidateId: p.candidateId,
        name: p.candidate.user.fullName,
        headline: p.candidate.headline,
        college: p.candidate.college,
        course: p.candidate.course,
        branch: p.candidate.specialisation,
        graduationYear: p.candidate.graduationYear,
        verified: p.candidate.batchMemberships.length > 0,
        pitch: p.pitch,
        videoUrl: p.videoUrl,
        skills: p.candidate.skills.map((s) => s.skill.name),
        projects: pinned
          .map((id) => p.candidate.projects.find((pr) => pr.id === id))
          .filter((pr): pr is NonNullable<typeof pr> => Boolean(pr)),
      };
    });
}

/** A company may use the talent pages only once the platform has verified it. */
export async function verifiedCompany(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, status: true },
  });
  if (!company) throw notFound('No such company.');
  if (company.status !== CompanyStatus.VERIFIED) {
    throw forbidden('Your company must be verified before it can look for students.');
  }
  return company;
}

/** One invitation, with every check a recruiter could trip. */
export async function sendInvite(input: {
  companyId: string;
  companyName: string;
  sentById: string;
  candidateId: string;
  jobId?: string;
  message: string;
}) {
  const [student] = await discoverable({}, input.candidateId, input.companyId);
  // Answers like a student who does not exist: a recruiter should not learn
  // that somebody is on the platform but has chosen not to be found.
  if (!student) throw notFound('That student is not open to invitations.');

  let jobTitle: string | null = null;
  if (input.jobId) {
    const job = await prisma.job.findFirst({
      where: { id: input.jobId, companyId: input.companyId, status: 'PUBLISHED' },
      select: { title: true },
    });
    if (!job) throw badRequest('Choose one of your published roles, or send the invitation without one.');
    jobTitle = job.title;
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = await prisma.showcaseInvite.count({
    where: { companyId: input.companyId, createdAt: { gte: since } },
  });
  if (today >= DAILY_INVITE_LIMIT) {
    throw new AppError(
      429,
      'TOO_MANY_INVITES',
      `Your company has sent ${DAILY_INVITE_LIMIT} invitations in the last day. Try again tomorrow.`,
    );
  }

  const recent = await prisma.showcaseInvite.findFirst({
    where: {
      companyId: input.companyId,
      candidateId: input.candidateId,
      jobId: input.jobId ?? null,
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (recent) {
    throw new AppError(409, 'ALREADY_INVITED', 'You invited this student to this role in the last 30 days.');
  }

  const candidate = await prisma.candidate.findUniqueOrThrow({
    where: { id: input.candidateId },
    select: { userId: true },
  });

  return prisma.$transaction(async (tx) => {
    const invite = await tx.showcaseInvite.create({
      data: {
        companyId: input.companyId,
        candidateId: input.candidateId,
        jobId: input.jobId ?? null,
        message: input.message,
        sentById: input.sentById,
      },
    });
    await tx.notification.create({
      data: {
        userId: candidate.userId,
        type: 'SHOWCASE_INVITE',
        title: `${input.companyName} invited you to apply`,
        body: jobTitle ? `For ${jobTitle}. ${input.message}` : input.message,
        link: '/student/showcase',
        payload: { inviteId: invite.id, jobId: input.jobId ?? null },
      },
    });
    return invite;
  });
}
