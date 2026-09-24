import { Router } from 'express';
import { InviteToApplyStatus, ShowcaseVisibility, StoryKind, StoryStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  requireCandidateId,
  requireCollegeId,
  requireCompanyId,
  requireRole,
} from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import {
  STORY_INCLUDE,
  SHOWCASE_PURPOSE,
  candidateCollege,
  discoverable,
  sendInvite,
  showcaseConsent,
  storyForCollege,
  storyForStudent,
  verifiedCompany,
} from './community.service.js';

/**
 * Campus stories and the student showcase.
 *
 * Every route fences itself: account type, then the institution's module
 * (students and colleges belong to one; companies do not, so the talent pages
 * check each student's institution instead), then the capability.
 */
export const communityRouter = Router();

const stories = requireModule('showcase.stories');
const showcase = requireModule('showcase.student');

/* ========================================================================== */
/* Stories - students                                                          */
/* ========================================================================== */

const roundSchema = z.object({
  name: z.string().trim().min(1).max(80),
  what: z.string().trim().max(1000).default(''),
});

const storySchema = z
  .object({
    kind: z.nativeEnum(StoryKind),
    companyId: z.string().trim().optional().or(z.literal('')),
    companyName: z.string().trim().max(120).optional().or(z.literal('')),
    role: z.string().trim().min(2, 'Which role was it?').max(120),
    year: z.number().int().min(2000).max(2100),
    rounds: z.array(roundSchema).max(12).default([]),
    body: z.string().trim().min(40, 'Write at least a few sentences - juniors read these to prepare.').max(6000),
    difficulty: z.number().int().min(1).max(5).optional(),
    result: z.string().trim().max(60).optional().or(z.literal('')),
    anonymous: z.boolean().default(false),
  })
  .refine((s) => Boolean(s.companyId || s.companyName), {
    message: 'Name the company.',
    path: ['companyName'],
  });

/** GET /api/community/stories - the published stories of the student's own college. */
communityRouter.get(
  '/stories',
  requireRole('CANDIDATE'),
  stories,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const q = z
      .object({
        companyId: z.string().optional(),
        kind: z.nativeEnum(StoryKind).optional(),
        year: z.coerce.number().int().optional(),
      })
      .parse(req.query);

    const { collegeId } = await candidateCollege(candidateId);
    // A student with no college has no seniors to read.
    if (!collegeId) {
      res.json({ stories: [], companies: [], years: [] });
      return;
    }

    const base = { collegeId, status: StoryStatus.PUBLISHED };
    const [rows, facets] = await Promise.all([
      prisma.campusStory.findMany({
        where: {
          ...base,
          ...(q.companyId ? { companyId: q.companyId } : {}),
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.year ? { year: q.year } : {}),
        },
        orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
        take: 100,
        include: STORY_INCLUDE,
      }),
      prisma.campusStory.findMany({
        where: base,
        select: { companyId: true, companyName: true, year: true },
      }),
    ]);

    const companies = new Map<string, string>();
    for (const f of facets) if (f.companyId) companies.set(f.companyId, f.companyName);

    res.json({
      stories: rows.map((s) => storyForStudent(s, candidateId)),
      companies: [...companies].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      years: [...new Set(facets.map((f) => f.year))].sort((a, b) => b - a),
    });
  }),
);

/** GET /api/community/stories/mine - what the student has written, in any state. */
communityRouter.get(
  '/stories/mine',
  requireRole('CANDIDATE'),
  stories,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const rows = await prisma.campusStory.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      include: STORY_INCLUDE,
    });
    res.json({ stories: rows.map((s) => storyForStudent(s, candidateId)) });
  }),
);

/** GET /api/community/stories/companies - companies to pick from when writing. */
communityRouter.get(
  '/stories/companies',
  requireRole('CANDIDATE'),
  stories,
  asyncHandler(async (_req, res) => {
    const companies = await prisma.company.findMany({
      where: { status: 'VERIFIED' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
      take: 500,
    });
    res.json({ companies });
  }),
);

/**
 * POST /api/community/stories - a new story, waiting for the placement cell.
 * Nothing a student writes reaches other students until a person has read it.
 */
communityRouter.post(
  '/stories',
  requireRole('CANDIDATE'),
  stories,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const data = storySchema.parse(req.body);
    const { collegeId } = await candidateCollege(candidateId);
    if (!collegeId) throw badRequest('Your account is not linked to a college yet, so there is nobody to share this with.');

    let companyName = data.companyName || '';
    let companyId: string | null = null;
    if (data.companyId) {
      const company = await prisma.company.findFirst({
        where: { id: data.companyId, status: 'VERIFIED' },
        select: { id: true, name: true },
      });
      if (!company) throw badRequest('Choose a company from the list, or type its name.');
      companyId = company.id;
      companyName = company.name;
    }

    const story = await prisma.campusStory.create({
      data: {
        candidateId,
        collegeId,
        companyId,
        companyName,
        kind: data.kind,
        role: data.role,
        year: data.year,
        rounds: data.kind === StoryKind.INTERVIEW ? data.rounds : [],
        body: data.body,
        difficulty: data.kind === StoryKind.INTERVIEW ? (data.difficulty ?? null) : null,
        result: data.result || null,
        anonymous: data.anonymous,
      },
      include: STORY_INCLUDE,
    });
    res.status(201).json({ story: storyForStudent(story, candidateId) });
  }),
);

/** DELETE /api/community/stories/:id - an author taking their own story back. */
communityRouter.delete(
  '/stories/:id',
  requireRole('CANDIDATE'),
  stories,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const found = await prisma.campusStory.findFirst({ where: { id: req.params.id, candidateId } });
    if (!found) throw notFound('No such story.');
    await prisma.campusStory.delete({ where: { id: found.id } });
    res.status(204).end();
  }),
);

/**
 * POST /api/community/stories/:id/helpful
 *
 * A soft signal, deliberately: a plain counter the screen lets each student
 * press once. There is no table recording who pressed it, so it is a nudge
 * towards the stories people found useful - never a score to rank anybody by.
 */
communityRouter.post(
  '/stories/:id/helpful',
  requireRole('CANDIDATE'),
  stories,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { collegeId } = await candidateCollege(candidateId);
    const story = await prisma.campusStory.findFirst({
      where: { id: req.params.id, collegeId: collegeId ?? '-', status: StoryStatus.PUBLISHED },
      select: { id: true, candidateId: true },
    });
    if (!story) throw notFound('No such story.');
    if (story.candidateId === candidateId) throw badRequest('You cannot mark your own story as helpful.');
    const updated = await prisma.campusStory.update({
      where: { id: story.id },
      data: { helpful: { increment: 1 } },
      select: { helpful: true },
    });
    res.json({ helpful: updated.helpful });
  }),
);

/* ========================================================================== */
/* Stories - the placement cell                                                */
/* ========================================================================== */

/** GET /api/community/college/stories?status=PENDING - the moderation queue. */
communityRouter.get(
  '/college/stories',
  requireRole('CAMPUS'),
  stories,
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const status = z.nativeEnum(StoryStatus).optional().parse(req.query.status || undefined);
    const [rows, counts] = await Promise.all([
      prisma.campusStory.findMany({
        where: { collegeId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: STORY_INCLUDE,
      }),
      prisma.campusStory.groupBy({ by: ['status'], where: { collegeId }, _count: true }),
    ]);
    res.json({
      stories: rows.map(storyForCollege),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    });
  }),
);

const decisionSchema = z
  .object({
    status: z.enum([StoryStatus.PUBLISHED, StoryStatus.HIDDEN]),
    reason: z.string().trim().max(500).optional().or(z.literal('')),
  })
  .refine((d) => d.status !== StoryStatus.HIDDEN || Boolean(d.reason), {
    message: 'Tell the student why - they are shown this.',
    path: ['reason'],
  });

/**
 * POST /api/community/college/stories/:id/decision - publish or hide.
 * The author is told either way, and a hidden story says why, so the next one
 * can be better rather than silently lost.
 */
communityRouter.post(
  '/college/stories/:id/decision',
  requireRole('CAMPUS'),
  stories,
  can('posting:decide'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const { status, reason } = decisionSchema.parse(req.body);
    const story = await prisma.campusStory.findFirst({
      where: { id: req.params.id, collegeId },
      include: { candidate: { select: { userId: true } } },
    });
    if (!story) throw notFound('No such story.');

    const updated = await prisma.campusStory.update({
      where: { id: story.id },
      data: { status },
      include: STORY_INCLUDE,
    });
    await prisma.notification.create({
      data: {
        userId: story.candidate.userId,
        type: 'STORY_DECISION',
        title:
          status === StoryStatus.PUBLISHED
            ? `Your ${story.companyName} story is live for your juniors`
            : `Your ${story.companyName} story was not published`,
        body: status === StoryStatus.PUBLISHED ? 'Thank you for writing it.' : (reason ?? ''),
        link: '/student/stories',
      },
    });
    res.json({ story: storyForCollege(updated) });
  }),
);

/* ========================================================================== */
/* Showcase - students                                                         */
/* ========================================================================== */

async function showcaseFor(candidateId: string) {
  const [profile, candidate, consent, invites] = await Promise.all([
    prisma.showcaseProfile.findUnique({ where: { candidateId } }),
    prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
      select: {
        projects: {
          select: { id: true, title: true, description: true, links: true },
          orderBy: { startDate: 'desc' },
        },
        applications: { select: { jobId: true } },
      },
    }),
    showcaseConsent([candidateId]),
    prisma.showcaseInvite.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { company: { select: { id: true, name: true, logoUrl: true } } },
    }),
  ]);

  // An invitation to a role the student has since applied to reads as such;
  // the apply flow does not know about invitations, so it is settled here.
  const applied = new Set(candidate.applications.map((a) => a.jobId));
  const jobIds = invites.map((i) => i.jobId).filter((j): j is string => Boolean(j));
  const jobs = await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true } });
  const title = new Map(jobs.map((j) => [j.id, j.title]));

  const stale = invites.filter((i) => i.jobId && applied.has(i.jobId) && i.status !== InviteToApplyStatus.APPLIED);
  if (stale.length) {
    await prisma.showcaseInvite.updateMany({
      where: { id: { in: stale.map((i) => i.id) } },
      data: { status: InviteToApplyStatus.APPLIED },
    });
  }

  return {
    profile: {
      pitch: profile?.pitch ?? '',
      videoUrl: profile?.videoUrl ?? '',
      pinned: Array.isArray(profile?.pinned) ? (profile!.pinned as string[]) : [],
      visibility: profile?.visibility ?? ShowcaseVisibility.PRIVATE,
    },
    projects: candidate.projects,
    consentGranted: consent.get(candidateId) === true,
    invites: invites.map((i) => ({
      id: i.id,
      company: i.company,
      jobId: i.jobId,
      jobTitle: i.jobId ? (title.get(i.jobId) ?? null) : null,
      message: i.message,
      status: stale.some((s) => s.id === i.id) ? InviteToApplyStatus.APPLIED : i.status,
      createdAt: i.createdAt,
    })),
  };
}

/** GET /api/community/showcase - the student's own showcase and invitations. */
communityRouter.get(
  '/showcase',
  requireRole('CANDIDATE'),
  showcase,
  asyncHandler(async (req, res) => {
    res.json(await showcaseFor(requireCandidateId(req)));
  }),
);

const showcaseSchema = z.object({
  pitch: z.string().trim().max(600, 'Keep your pitch under 600 characters.').default(''),
  videoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https:\/\/\S+$/i.test(v), 'Use a link starting with https://')
    .default(''),
  pinned: z.array(z.string().min(1)).max(3, 'Pin at most three projects.').default([]),
  visibility: z.nativeEnum(ShowcaseVisibility),
});

/**
 * PUT /api/community/showcase
 *
 * Choosing RECRUITERS without the matching consent is refused rather than
 * quietly saved, so a student is never left believing recruiters can find
 * them when the consent centre says they cannot.
 */
communityRouter.put(
  '/showcase',
  requireRole('CANDIDATE'),
  showcase,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const data = showcaseSchema.parse(req.body);

    if (data.visibility === ShowcaseVisibility.RECRUITERS) {
      const consent = await showcaseConsent([candidateId]);
      if (consent.get(candidateId) !== true) {
        throw new AppError(
          409,
          'CONSENT_REQUIRED',
          'To be found by recruiters, first allow it in your privacy choices.',
          { purposes: [SHOWCASE_PURPOSE] },
        );
      }
    }

    const own = await prisma.project.findMany({
      where: { candidateId, id: { in: data.pinned } },
      select: { id: true },
    });
    if (own.length !== new Set(data.pinned).size) throw badRequest('Pin projects from your own profile.');

    await prisma.showcaseProfile.upsert({
      where: { candidateId },
      update: { pitch: data.pitch || null, videoUrl: data.videoUrl || null, pinned: data.pinned, visibility: data.visibility },
      create: {
        candidateId,
        pitch: data.pitch || null,
        videoUrl: data.videoUrl || null,
        pinned: data.pinned,
        visibility: data.visibility,
      },
    });
    res.json(await showcaseFor(candidateId));
  }),
);

/** POST /api/community/showcase/invites/:id/respond {action: SEEN|DECLINED} */
communityRouter.post(
  '/showcase/invites/:id/respond',
  requireRole('CANDIDATE'),
  showcase,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { action } = z
      .object({ action: z.enum([InviteToApplyStatus.SEEN, InviteToApplyStatus.DECLINED]) })
      .parse(req.body);
    const invite = await prisma.showcaseInvite.findFirst({ where: { id: req.params.id, candidateId } });
    if (!invite) throw notFound('No such invitation.');
    // Applying outranks both: an invitation that led somewhere stays that way.
    if (invite.status !== InviteToApplyStatus.APPLIED) {
      await prisma.showcaseInvite.update({ where: { id: invite.id }, data: { status: action } });
    }
    res.json(await showcaseFor(candidateId));
  }),
);

/* ========================================================================== */
/* Talent - companies                                                          */
/* ========================================================================== */

const talentQuery = z.object({
  course: z.string().trim().max(120).optional(),
  branch: z.string().trim().max(120).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  skill: z.string().trim().max(120).optional(),
  collegeId: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
});

/** GET /api/community/talent - students who chose to be found, and agreed to it. */
communityRouter.get(
  '/talent',
  requireRole('COMPANY'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompany(companyId);
    const filter = talentQuery.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));

    const [students, jobs] = await Promise.all([
      discoverable(filter, undefined, companyId),
      prisma.job.findMany({
        where: { companyId, status: 'PUBLISHED' },
        orderBy: { publishedAt: 'desc' },
        select: { id: true, title: true },
      }),
    ]);

    // Filter choices are drawn from the students who can actually be found,
    // so no option ever leads to an empty page by construction.
    const all = filter.course || filter.branch || filter.year || filter.skill || filter.collegeId || filter.q
      ? await discoverable({}, undefined, companyId)
      : students;
    const uniq = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];

    res.json({
      students,
      jobs,
      options: {
        courses: uniq(all.map((s) => s.course)).sort(),
        branches: uniq(all.map((s) => s.branch)).sort(),
        years: uniq(all.map((s) => s.graduationYear)).sort(),
        skills: uniq(all.flatMap((s) => s.skills)).sort(),
        colleges: [...new Map(all.map((s) => [s.college?.id, s.college])).values()].filter(Boolean),
      },
    });
  }),
);

/** GET /api/community/talent/invites - what this company has sent, and what happened. */
communityRouter.get(
  '/talent/invites',
  requireRole('COMPANY'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompany(companyId);
    const invites = await prisma.showcaseInvite.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { candidate: { select: { user: { select: { fullName: true } } } } },
    });
    res.json({
      invites: invites.map((i) => ({
        id: i.id,
        candidateId: i.candidateId,
        name: i.candidate.user.fullName,
        jobId: i.jobId,
        status: i.status,
        createdAt: i.createdAt,
      })),
    });
  }),
);

/**
 * POST /api/community/talent/:candidateId/invite {jobId?, message}
 *
 * The only thing a recruiter can send a student. No free-form messaging, no
 * contact details either way - a student who wants to talk applies.
 */
communityRouter.post(
  '/talent/:candidateId/invite',
  requireRole('COMPANY'),
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const company = await verifiedCompany(companyId);
    const body = z
      .object({
        jobId: z.string().trim().optional().or(z.literal('')),
        message: z.string().trim().min(10, 'Say a sentence about why.').max(500, 'Keep it under 500 characters.'),
      })
      .parse(req.body);

    const invite = await sendInvite({
      companyId,
      companyName: company.name,
      sentById: req.session.userId!,
      candidateId: req.params.candidateId!,
      jobId: body.jobId || undefined,
      message: body.message,
    });
    res.status(201).json({ invite: { id: invite.id, status: invite.status } });
  }),
);
