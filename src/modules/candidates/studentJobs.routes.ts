import { Router } from 'express';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { z } from 'zod';
import {
  loadCandidateContext,
  resolvePlacementFor,
  visibleJobWhere,
} from '../jobs/visibility.js';
import { transition } from '../applications/state.js';
import { eligibilityOf } from '../jobs/job.service.js';
import { labelsFor } from '../jobs/job.options.js';
import { tenantHasModule } from '../tenants/tenant.context.js';
import { estimateInHand } from '../trust/inHand.js';
import { jobText, scanForFeeDemand } from '../trust/scam.js';
import { assertApplyConsent } from '../consent/consent.service.js';

/**
 * The honest offer card, from a role's own pay fields.
 *
 * Everything the company stated, split the way it will actually be paid, and
 * an estimate of the monthly take-home from the fixed part alone. Null when
 * the role states no fixed pay at all - an estimate from a headline range
 * would be exactly the kind of number this card exists to replace.
 */
function offerCardOf(job: {
  jobType: string;
  payPeriod: string;
  ctcMin: unknown;
  ctcMax: unknown;
  ctcFixed: unknown;
  ctcVariable?: unknown;
  joiningBonus?: unknown;
  bondMonths?: number | null;
  bondAmount?: unknown;
  bondNote?: string | null;
  stipendPerMonth?: unknown;
  internshipMonths?: number | null;
  ppoCtc?: unknown;
}) {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const fixed = num(job.ctcFixed);
  return {
    fixed,
    variable: num(job.ctcVariable),
    joiningBonus: num(job.joiningBonus),
    headline: { min: num(job.ctcMin), max: num(job.ctcMax) },
    bond:
      job.bondMonths || num(job.bondAmount)
        ? { months: job.bondMonths ?? null, amount: num(job.bondAmount), note: job.bondNote ?? null }
        : null,
    stipendPerMonth: num(job.stipendPerMonth),
    internshipMonths: job.internshipMonths ?? null,
    ppoCtc: num(job.ppoCtc),
    inHand: fixed ? estimateInHand(fixed) : null,
  };
}

export const studentJobsRouter = Router();

studentJobsRouter.use(requireRole('CANDIDATE'));

const jobCard = {
  id: true,
  title: true,
  jobType: true,
  workMode: true,
  location: true,
  openings: true,
  payPeriod: true,
  ctcMin: true,
  ctcMax: true,
  // The fixed figure is the one a student can actually plan around, and the
  // one their college will publish. Shown next to the headline, not instead.
  ctcFixed: true,
  stipendPerMonth: true,
  internshipMonths: true,
  deadline: true,
  // When it went out, which is half of how a student judges their odds - the
  // other half being how many have applied since.
  publishedAt: true,
  // Badges on the card: a women-first role, and one that welcomes a person
  // with a disability, are both things a student scanning the list looks for.
  genderEligibility: true,
  pwdSuitable: true,
  company: { select: { name: true } },
  _count: { select: { rounds: true, applications: true } },
  // What the role asks for, so a student can be told which of them they
  // already have rather than left to compare two lists by eye.
  skills: { select: { isRequired: true, skill: { select: { name: true } } } },
} as const;

/**
 * Once a student is actually in the process, rather than reading about it.
 *
 * Before that, a round is a shape - how many, what kind, and whether they
 * turn up or open a link. When and where is arranged per student after they
 * are shortlisted, so showing a date and a hall to everyone who opens the
 * role advertises a slot most of them will never be given, and goes stale the
 * moment the company reschedules.
 */
const IN_PROCESS = new Set([
  'APPLIED',
  'UNDER_REVIEW',
  'SHORTLISTED',
  'IN_ROUND',
  'WAITLISTED',
  'OFFERED',
  'ACCEPTED',
  'HIRED',
]);

/** How many days from now, rounded down. Negative for one already gone. */
const daysTo = (d: Date) => Math.floor((d.getTime() - Date.now()) / 86_400_000);

export interface JobMatch {
  /** 0-100. What it is made of is in `reasons`, which is the useful part. */
  score: number;
  /** Skills the role asks for that this student already lists. */
  have: string[];
  /** Skills it asks for that they do not. */
  missing: string[];
  /** Said plainly, so a suggestion can be argued with rather than trusted. */
  reasons: string[];
}

/**
 * Why this role might suit this student.
 *
 * Everything a student can see is already one they are eligible for - the
 * visibility query saw to that - so this is not about eligibility. It is
 * about which of forty eligible roles to read first, which is the question
 * they actually have.
 *
 * Deliberately plain arithmetic rather than anything clever: a student is
 * deciding where to spend an evening, and a number they cannot interrogate is
 * worse than no number. Every point is accounted for in `reasons`.
 */
function matchFor(
  job: { skills: { isRequired: boolean; skill: { name: string } }[]; deadline: Date; jobType: string },
  mySkills: Set<string>,
): JobMatch {
  const asked = job.skills.map((s) => s.skill.name);
  const have = asked.filter((n) => mySkills.has(n.toLowerCase()));
  const missing = asked.filter((n) => !mySkills.has(n.toLowerCase()));
  const required = job.skills.filter((s) => s.isRequired).map((s) => s.skill.name);
  const haveRequired = required.filter((n) => mySkills.has(n.toLowerCase()));

  const reasons: string[] = [];
  let score = 0;

  /*
   * A student with no skills on record cannot be scored on them.
   *
   * Nothing to compare is not the same as a bad match, and scoring it as one
   * gave a zero on every role to exactly the students who most need the
   * suggestions - the ones who have not finished their profile. They are told
   * what would fix it instead.
   */
  if (mySkills.size === 0) {
    score += 35;
    reasons.push('Add your skills to your profile and these suggestions get sharper');
  } else if (asked.length > 0) {
    // The bulk of it: what they can already do.
    const share = have.length / asked.length;
    score += Math.round(share * 60);
    if (have.length > 0) {
      reasons.push(`You list ${have.length} of the ${asked.length} skills it asks for`);
    }
    if (required.length > 0 && haveRequired.length === required.length) {
      score += 15;
      reasons.push('You have every skill it marks as required');
    }
  } else {
    // Nothing asked for is not a reason to bury it.
    score += 35;
    reasons.push('It does not ask for particular skills');
  }

  const days = daysTo(job.deadline);
  if (days >= 0 && days <= 7) {
    score += 15;
    reasons.push(days === 0 ? 'Closes today' : `Closes in ${days} day${days === 1 ? '' : 's'}`);
  } else if (days > 7 && days <= 21) {
    score += 8;
  }

  if (job.jobType.startsWith('INTERNSHIP')) {
    reasons.push('An internship rather than a full-time role');
  }

  return { score: Math.min(100, score), have, missing, reasons };
}

/** GET /api/candidate/jobs — everything visible_to(me) */
studentJobsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const ctx = await loadCandidateContext(candidateId);
    const withOfferCard = await tenantHasModule(req.session.tenantId, 'trust.offerCard');

    const [jobs, mine, mySkills] = await Promise.all([
      prisma.job.findMany({
        where: visibleJobWhere(ctx),
        orderBy: { deadline: 'asc' },
        select: jobCard,
      }),
      prisma.application.findMany({
        where: { candidateId },
        select: { jobId: true, status: true },
      }),
      prisma.candidateSkill.findMany({
        where: { candidateId },
        select: { skill: { select: { name: true } } },
      }),
    ]);

    const appliedTo = new Map(mine.map((a) => [a.jobId, a.status]));
    // Matched case-insensitively: the catalogue is one list, but a skill
    // added before it was is not always spelt the way the list spells it.
    const mine_ = new Set(mySkills.map((s) => s.skill.name.toLowerCase()));

    res.json({
      // The student is told why they cannot apply, rather than shown a
      // button that fails.
      canApply: ctx.isFrozen,
      blockedReason: ctx.isFrozen
        ? null
        : 'Your college has not verified your profile yet, so you cannot apply.',
      jobs: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        companyName: j.company.name,
        jobType: j.jobType,
        location: j.location,
        ctcMin: j.ctcMin,
        ctcMax: j.ctcMax,
        deadline: j.deadline,
        roundCount: j._count.rounds,
        postedAt: j.publishedAt,
        /*
         * Everyone who has applied, including those already turned down.
         *
         * A student is asking how crowded this is, and a count that quietly
         * dropped the rejected ones would understate exactly the roles that
         * have been picked over the longest.
         */
        applicants: j._count.applications,
        applicationStatus: appliedTo.get(j.id) ?? null,
        workMode: j.workMode,
        openings: j.openings,
        payPeriod: j.payPeriod,
        skills: j.skills.map((s) => s.skill.name),
        // Why it might suit them, which is a different question from whether
        // they are allowed to apply.
        match: matchFor(j, mine_),
        // Only where the institution has the offer card: the fixed pay and
        // what it comes to each month, next to the headline.
        ...(withOfferCard
          ? {
              ctcFixed: j.ctcFixed,
              stipendPerMonth: j.stipendPerMonth,
              inHandMonthly: j.ctcFixed ? (estimateInHand(Number(j.ctcFixed))?.monthly ?? null) : null,
            }
          : {}),
      })),
    });
  }),
);

/** GET /api/candidate/jobs/:id — only if it is visible to this student */
studentJobsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const ctx = await loadCandidateContext(candidateId);

    // Scoped by the same predicate as the list: an id that is not visible
    // reads as not found, rather than leaking that it exists.
    const job = await prisma.job.findFirst({
      where: { AND: [{ id: req.params.id }, visibleJobWhere(ctx)] },
      include: {
        // The id too, so the page can offer the company's own page - what a
        // student reads before deciding whether to spend a round on them.
        company: { select: { id: true, name: true, website: true, about: true, logoUrl: true } },
        rounds: { orderBy: { order: 'asc' } },
        courses: true,
        specialisations: true,
        gradYears: true,
        skills: { include: { skill: { select: { id: true, name: true } } } },
        terms: { orderBy: { order: 'asc' } },
      },
    });
    if (!job) throw notFound('This role is not available to you.');

    const application = await prisma.application.findUnique({
      where: { candidateId_jobId: { candidateId, jobId: job.id } },
      select: { id: true, status: true, appliedAt: true },
    });

    // The company may have renamed a round kind, or invented one. The student
    // reads what it says now rather than the key it was stored under.
    const label = await labelsFor(job.companyId);

    const [withOfferCard, withScamShield] = await Promise.all([
      tenantHasModule(req.session.tenantId, 'trust.offerCard'),
      tenantHasModule(req.session.tenantId, 'trust.scamShield'),
    ]);
    const report = withScamShield
      ? await prisma.jobReport.findUnique({
          where: { jobId_candidateId: { jobId: job.id, candidateId } },
          select: { reason: true, status: true, createdAt: true },
        })
      : null;

    const testClosed =
      job.screeningTestDeadline !== null && job.screeningTestDeadline.getTime() < Date.now();

    const inProcess = application !== null && IN_PROCESS.has(application.status);
    const applicantCount = await prisma.application.count({ where: { jobId: job.id } });

    res.json({
      job: {
        ...job,
        ...eligibilityOf(job),
        terms: job.terms.map((t) => t.text),
        roundCount: job.rounds.length,
        postedAt: job.publishedAt,
        applicants: applicantCount,
        jobTypeLabel: label('EMPLOYMENT_TYPE', job.jobType),
        workModeLabel: label('WORK_MODE', job.workMode),
        rounds: job.rounds.map((r) => {
          const shape = {
            id: r.id,
            order: r.order,
            name: r.name,
            type: r.type,
            isElimination: r.isElimination,
            isOnline: r.isOnline,
            typeLabel: label('ROUND_TYPE', r.type),
            modeLabel: label('ROUND_MODE', r.mode),
            description: r.description,
          };

          // The logistics follow the student into the process; they are not
          // part of the advertisement.
          return inProcess
            ? {
                ...shape,
                scheduledAt: r.scheduledAt,
                durationMin: r.durationMin,
                shortlistCount: r.shortlistCount,
                venue: r.venue,
                addressLine: r.addressLine,
                pincode: r.pincode,
                mapsLink: r.mapsLink,
                mapEmbedUrl: r.mapEmbedUrl,
                meetingLink: r.meetingLink,
              }
            : shape;
        }),
      },
      application,
      // Present only where the institution has the module switched on, so a
      // screen can simply ask "is it there?".
      offerCard: withOfferCard ? offerCardOf(job) : null,
      feeWarning: withScamShield ? scanForFeeDemand(jobText(job)) : null,
      myReport: report,
      canApply: ctx.isFrozen && !application && !testClosed,
      blockedReason: !ctx.isFrozen
        ? 'Your college has not verified your profile yet, so you cannot apply.'
        : testClosed
          ? 'The test for this role has closed, so applications are no longer open.'
          : null,
      // What applying will ask of them, said before they start rather than
      // after: the conditions to accept, and the test to have taken.
      beforeApplying: {
        terms: job.terms.map((t) => t.text),
        test: job.screeningTestUrl
          ? {
              name: job.screeningTestName,
              url: job.screeningTestUrl,
              instructions: job.screeningTestInstructions,
              deadline: job.screeningTestDeadline,
              required: job.screeningTestRequired,
            }
          : null,
      },
    });
  }),
);

/** What a student sends with an application, where the role asks for it. */
const applySchema = z
  .object({
    acceptTerms: z.boolean().default(false),
    screeningRef: z.string().trim().max(120).optional().or(z.literal('')),
    /** Which of their resumes to send. Their current one when left out. */
    resumeId: z.string().trim().min(1).optional(),
    /** Make the one they picked their current resume from now on. */
    makeDefault: z.boolean().default(false),
  })
  .strict();

/** POST /api/candidate/jobs/:id/apply */
studentJobsRouter.post(
  '/:id/apply',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    // Where the institution runs the consent centre, sharing a profile with a
    // company is something the student agrees to before the first application.
    await assertApplyConsent(candidateId, req.session.tenantId);
    const ctx = await loadCandidateContext(candidateId);

    if (!ctx.isFrozen) {
      throw forbidden(
        'Your college has not verified your profile yet. Once they do, you can apply.',
      );
    }

    // Re-check visibility at the moment of applying, not just when listing.
    const job = await prisma.job.findFirst({
      where: { AND: [{ id: req.params.id }, visibleJobWhere(ctx)] },
      select: {
        id: true,
        title: true,
        screeningTestRequired: true,
        screeningTestName: true,
        screeningTestDeadline: true,
        terms: { select: { id: true } },
      },
    });
    if (!job) throw notFound('This role is not available to you.');

    const body = applySchema.parse(req.body ?? {});

    /*
     * The two things a company can ask for before an application counts.
     *
     * Both are recorded on the application rather than merely checked, so
     * that months later - when somebody declines an offer over a relocation
     * they say nobody mentioned - there is a row saying when they agreed.
     */
    if (job.terms.length > 0 && !body.acceptTerms) {
      throw badRequest('Accept the conditions of this role before applying.');
    }

    if (job.screeningTestRequired) {
      if (
        job.screeningTestDeadline &&
        job.screeningTestDeadline.getTime() < Date.now()
      ) {
        throw badRequest('The test for this role has closed.');
      }
      if (!body.screeningRef) {
        throw badRequest(
          `${job.screeningTestName ?? 'The test'} has to be taken first. Enter what it gave you when you finished.`,
        );
      }
    }

    const existing = await prisma.application.findUnique({
      where: { candidateId_jobId: { candidateId, jobId: job.id } },
    });
    if (existing) throw conflict('You have already applied to this role.');

    const placementId = await resolvePlacementFor(job.id, ctx);

    /*
     * Which resume this application carries.
     *
     * Named explicitly where the student picked one, and their current one
     * otherwise. Frozen onto the application either way, so switching their
     * default later does not change what a recruiter was sent.
     */
    const chosen = body.resumeId
      ? await prisma.resume.findFirst({ where: { id: body.resumeId, candidateId } })
      : null;
    if (body.resumeId && !chosen) throw notFound('No such resume.');

    const me = await prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
      select: { resumeUrl: true },
    });
    const resumeUrl = chosen?.url ?? me.resumeUrl;

    // Asked for, rather than assumed: a resume written for one kind of role
    // is not automatically the one they want on every other application.
    if (chosen && body.makeDefault) {
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { resumeUrl: chosen.url, resumeBuild: (chosen.build ?? Prisma.DbNull) as Prisma.InputJsonValue },
      });
    }

    // The application and its first audit row are written together - an
    // application with no history would be a hole in the trail from the start.
    const application = await prisma.$transaction(async (tx) => {
      const created = await tx.application.create({
        data: {
          candidateId,
          jobId: job.id,
          placementId,
          status: ApplicationStatus.APPLIED,
          acceptedTermsAt: job.terms.length > 0 ? new Date() : null,
          screeningRef: body.screeningRef || null,
          resumeUrl,
        },
      });

      await tx.statusEvent.create({
        data: {
          applicationId: created.id,
          actorId: req.session.userId!,
          fromStatus: null,
          toStatus: ApplicationStatus.APPLIED,
          reason: 'applied',
        },
      });

      return created;
    });

    res.status(201).json({ application });
  }),
);

/** GET /api/candidate/applications — my applications, newest first */
studentJobsRouter.get(
  '/mine/applications',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);

    const applications = await prisma.application.findMany({
      where: { candidateId },
      orderBy: { appliedAt: 'desc' },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            deadline: true,
            company: { select: { name: true } },
            /*
             * The rounds with their logistics.
             *
             * Being called to a round is the message; the date, the place and
             * the link are what the message is for. A student who has to open
             * the job advert to find out where to be on Thursday has been
             * told half of it.
             */
            rounds: {
              orderBy: { order: 'asc' },
              select: {
                id: true,
                order: true,
                name: true,
                type: true,
                isOnline: true,
                isElimination: true,
                scheduledAt: true,
                durationMin: true,
                venue: true,
                addressLine: true,
                mapsLink: true,
                mapEmbedUrl: true,
                meetingLink: true,
              },
            },
          },
        },
        placement: { select: { name: true } },
        currentRound: { select: { id: true, order: true, name: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    res.json({
      applications: applications.map((a) => ({
        id: a.id,
        status: a.status,
        appliedAt: a.appliedAt,
        updatedAt: a.updatedAt,
        jobId: a.job.id,
        title: a.job.title,
        companyName: a.job.company.name,
        placementName: a.placement.name,
        deadline: a.job.deadline,
        rounds: a.job.rounds,
        currentRound: a.currentRound,
        lastEventAt: a.events[0]?.createdAt ?? a.appliedAt,
      })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* The student's own moves: responding to an offer, and pulling out.           */
/* -------------------------------------------------------------------------- */

/** Their own application, or nothing. */
async function myApplication(candidateId: string, id: string) {
  const application = await prisma.application.findFirst({
    where: { id, candidateId },
  });
  if (!application) throw notFound('No such application.');
  return application;
}

/**
 * POST /api/candidate/jobs/mine/applications/:id/respond
 * Accepting is the moment that closes their other applications in this drive.
 */
studentJobsRouter.post(
  '/mine/applications/:id/respond',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const application = await myApplication(candidateId, req.params.id!);

    const { decision } = z
      .object({ decision: z.enum(['ACCEPT', 'DECLINE']) })
      .parse(req.body);

    if (application.status !== ApplicationStatus.OFFERED) {
      throw conflict('There is no open offer on this application.');
    }

    const result = await transition({
      applicationId: application.id,
      to: decision === 'ACCEPT' ? ApplicationStatus.ACCEPTED : ApplicationStatus.DECLINED,
      actorId: req.session.userId!,
      reason: decision === 'ACCEPT' ? 'offer_accepted' : 'offer_declined',
    });

    res.json(result);
  }),
);

/** POST /api/candidate/jobs/mine/applications/:id/withdraw */
studentJobsRouter.post(
  '/mine/applications/:id/withdraw',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const application = await myApplication(candidateId, req.params.id!);

    res.json(
      await transition({
        applicationId: application.id,
        to: ApplicationStatus.WITHDRAWN,
        actorId: req.session.userId!,
        reason: 'withdrawn_by_student',
      }),
    );
  }),
);
