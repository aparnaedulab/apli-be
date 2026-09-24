import { Router } from 'express';
import { z } from 'zod';
import { ApplicationStatus as S, RoundOutcome } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import { transition } from './state.js';
import { can, hasPermission } from '../roles/can.js';
import { linksOf } from '../candidates/candidate.service.js';

export const applicationRouter = Router();

applicationRouter.use(requireRole('COMPANY'));

/** Layer 3: reachable only through a job this company owns. */
async function ownedApplication(companyId: string, id: string) {
  const application = await prisma.application.findFirst({
    where: { id, job: { companyId } },
    include: {
      job: { select: { id: true, title: true, rounds: { orderBy: { order: 'asc' } } } },
    },
  });
  if (!application) throw notFound('No such application.');
  return application;
}

const feedbackSchema = z.object({
  score: z.coerce.number().min(0).max(1000).optional(),
  feedback: z.string().trim().max(2000).optional().or(z.literal('')),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

/** GET /api/company/applications?jobId=&status= */
applicationRouter.get(
  '/',
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const query = z
      .object({
        jobId: z.string().optional(),
        status: z.nativeEnum(S).optional(),
        /** Narrowing the list, rather than narrowing who could apply. */
        course: z.string().trim().max(120).optional(),
        specialisation: z.string().trim().max(120).optional(),
        minCgpa: z.coerce.number().min(0).max(10).optional(),
        /**
         * How to order what is left.
         *
         * `match` is the default and the point of the screen: a role states a
         * bar it will accept and a standard it would rather have, and this
         * puts the second at the top without excluding the first.
         */
        sort: z.enum(['match', 'cgpa', 'applied', 'name']).default('match'),
      })
      .parse(req.query);

    const applications = await prisma.application.findMany({
      where: {
        job: { companyId, ...(query.jobId ? { id: query.jobId } : {}) },
        ...(query.status ? { status: query.status } : {}),
        candidate: {
          ...(query.course ? { course: query.course } : {}),
          ...(query.specialisation ? { specialisation: query.specialisation } : {}),
          ...(query.minCgpa !== undefined ? { cgpa: { gte: query.minCgpa } } : {}),
        },
      },
      orderBy: [{ status: 'asc' }, { appliedAt: 'asc' }],
      include: {
        candidate: {
          select: {
            id: true,
            cgpa: true,
            degreePct: true,
            course: true,
            specialisation: true,
            resumeUrl: true,
            user: { select: { fullName: true, email: true } },
            skills: { select: { skillId: true } },
            college: { select: { id: true, name: true } },
            batchMemberships: {
              select: {
                rollNo: true,
                batch: { select: { id: true, name: true, course: true } },
              },
              take: 1,
            },
          },
        },
        currentRound: { select: { id: true, order: true, name: true } },
        job: {
          select: {
            id: true,
            title: true,
            preferredCgpa: true,
            preferredDegreePct: true,
            skills: { select: { skillId: true, isRequired: true } },
            _count: { select: { rounds: true } },
            // The rounds themselves, so the queue can name the one it is
            // about to move somebody into rather than saying "round 1". A
            // recruiter inviting a student to an interview wants to see
            // which interview, and when.
            rounds: {
              select: { id: true, order: true, name: true, isOnline: true, scheduledAt: true },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });

    const rows = applications.map((a) => {
      const m = a.candidate.batchMemberships[0];
      const held = new Set(a.candidate.skills.map((s) => s.skillId));

      const asked = a.job.skills.filter((s) => s.isRequired);
      const welcomed = a.job.skills.filter((s) => !s.isRequired);

      const hasAsked = asked.filter((s) => held.has(s.skillId)).length;
      const hasWelcomed = welcomed.filter((s) => held.has(s.skillId)).length;

      /*
       * Why somebody is near the top, in the same words the role used.
       *
       * Not a score out of a hundred: an invented number nobody can check is
       * worse than a short list of the reasons, which a recruiter can argue
       * with. A skill asked for counts double one merely welcomed, and
       * clearing the preferred bar counts as much as two asked-for skills -
       * enough to lift somebody, never enough to bury a strong candidate who
       * simply left their profile half-filled.
       */
      const cgpa = a.candidate.cgpa === null ? null : Number(a.candidate.cgpa);
      const pct = a.candidate.degreePct === null ? null : Number(a.candidate.degreePct);

      const preferredCgpa =
        a.job.preferredCgpa === null ? null : Number(a.job.preferredCgpa);
      const preferredPct =
        a.job.preferredDegreePct === null ? null : Number(a.job.preferredDegreePct);

      const beatsPreferred =
        (preferredCgpa !== null && cgpa !== null && cgpa >= preferredCgpa) ||
        (preferredPct !== null && pct !== null && pct >= preferredPct);

      const reasons: string[] = [];
      if (beatsPreferred) reasons.push('Above your preferred mark');
      if (hasAsked > 0) reasons.push(`${hasAsked} of ${asked.length} skills you asked for`);
      if (hasWelcomed > 0) reasons.push(`${hasWelcomed} you would welcome`);

      return {
        id: a.id,
        status: a.status,
        appliedAt: a.appliedAt,
        jobId: a.job.id,
        jobTitle: a.job.title,
        totalRounds: a.job._count.rounds,
        rounds: a.job.rounds,
        currentRound: a.currentRound,
        candidateId: a.candidate.id,
        name: a.candidate.user.fullName,
        email: a.candidate.user.email,
        cgpa: a.candidate.cgpa,
        degreePct: a.candidate.degreePct,
        course: a.candidate.course ?? m?.batch.course ?? null,
        specialisation: a.candidate.specialisation ?? null,
        // The one this application carried, not whichever the student is
        // using today. Older rows never recorded it, so they fall back.
        resumeUrl: a.resumeUrl ?? a.candidate.resumeUrl,
        rollNo: m?.rollNo ?? null,
        batchId: m?.batch.id ?? null,
        batchName: m?.batch.name ?? null,
        /* Which campus they are on. A role run across three colleges is read
           very differently from one run at a single campus, and until now
           the queue could not tell them apart at all. */
        collegeId: a.candidate.college?.id ?? null,
        collegeName: a.candidate.college?.name ?? null,

        beatsPreferred,
        skillsAsked: asked.length,
        skillsAskedHeld: hasAsked,
        skillsWelcomed: welcomed.length,
        skillsWelcomedHeld: hasWelcomed,
        reasons,
        score: hasAsked * 2 + hasWelcomed + (beatsPreferred ? 2 : 0),
      };
    });

    // Sorted here rather than in SQL: the match is computed per row from two
    // tables, and a campus job has hundreds of applicants, not millions.
    const sorted = [...rows].sort((a, b) => {
      if (query.sort === 'cgpa') return Number(b.cgpa ?? -1) - Number(a.cgpa ?? -1);
      if (query.sort === 'name') return a.name.localeCompare(b.name);
      if (query.sort === 'applied') return a.appliedAt.getTime() - b.appliedAt.getTime();

      // Match, then the stronger candidate, then whoever applied first.
      return (
        b.score - a.score ||
        Number(b.cgpa ?? -1) - Number(a.cgpa ?? -1) ||
        a.appliedAt.getTime() - b.appliedAt.getTime()
      );
    });

    res.json({ applications: sorted });
  }),
);

/** GET /api/company/applications/:id — the full record plus round history */
applicationRouter.get(
  '/:id',
  can('application:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await ownedApplication(companyId, req.params.id!);

    const application = await prisma.application.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        candidate: {
          include: {
            user: { select: { fullName: true, email: true } },
            college: { select: { name: true } },
            educations: { orderBy: { startYear: 'desc' } },
            experiences: { orderBy: { startDate: 'desc' } },
            projects: true,
            skills: { include: { skill: true } },
            batchMemberships: {
              include: { batch: { select: { name: true, course: true, graduationYear: true } } },
            },
          },
        },
        job: { include: { rounds: { orderBy: { order: 'asc' } } } },
        currentRound: true,
        results: { include: { round: { select: { order: true, name: true } } } },
        events: {
          orderBy: { createdAt: 'desc' },
          include: { actor: { select: { fullName: true } } },
        },
      },
    });

    const c = application.candidate;
    const m = c.batchMemberships[0];

    res.json({
      application: {
        id: application.id,
        status: application.status,
        appliedAt: application.appliedAt,
        currentRound: application.currentRound,
        rounds: application.job.rounds,
        results: application.results.map((r) => ({
          roundOrder: r.round.order,
          roundName: r.round.name,
          outcome: r.outcome,
          score: r.score,
          feedback: r.feedback,
          evaluatedAt: r.evaluatedAt,
        })),
        events: application.events.map((e) => ({
          id: e.id,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          reason: e.reason,
          note: e.note,
          actor: e.actor?.fullName ?? 'System',
          createdAt: e.createdAt,
        })),
        job: { id: application.job.id, title: application.job.title },
        candidate: {
          id: c.id,
          name: c.user.fullName,
          email: c.user.email,
          phone: c.phone,
          headline: c.headline,
          about: c.about,
          // As sent with this application; their current one for rows that
          // predate it being recorded.
          resumeUrl: application.resumeUrl ?? c.resumeUrl,

          /*
           * The whole academic record, not the three columns the list
           * filters on.
           *
           * A recruiter deciding on one person is doing what the filters
           * cannot: weighing a diploma entrant's three years against a
           * twelfth percentage they never had, or reading two cleared
           * backlogs next to none live. Every one of these is on a real
           * criteria sheet, and leaving them out here does not make the
           * decision simpler - it makes it happen over email instead.
           */
          cgpa: c.cgpa,
          degreePct: c.degreePct,
          tenthPct: c.tenthPct,
          twelfthPct: c.twelfthPct,
          diplomaPct: c.diplomaPct,
          pgCgpa: c.pgCgpa,
          pgPct: c.pgPct,
          backlogs: c.backlogs,
          activeBacklogs: c.activeBacklogs,
          gapYears: c.gapYears,
          isLateralEntry: c.isLateralEntry,
          prn: c.prn,
          graduationYear: c.graduationYear,

          // What they are studying, from the student rather than the batch:
          // a batch called "Second year" says nothing about either.
          course: c.course,
          specialisation: c.specialisation,
          collegeName: c.college?.name ?? null,

          batch: m ? { ...m.batch, rollNo: m.rollNo, isFrozen: m.isFrozen } : null,
          educations: c.educations,
          experiences: c.experiences,
          // One project is routinely several places - the repository, a live
          // demo, a write-up. Sending one of them made the student choose
          // which the recruiter got to see.
          projects: c.projects.map((p) => ({ ...p, links: linksOf(p.links) })),
          skills: c.skills.map((s) => s.skill.name),
        },
      },
    });
  }),
);

/** POST /api/company/applications/:id/review — open it */
applicationRouter.post(
  '/:id/review',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);
    res.json(await transition({ applicationId: app.id, to: S.UNDER_REVIEW, actorId: req.session.userId! }));
  }),
);

/**
 * POST /api/company/applications/:id/shortlist
 *
 * Picked out of the pile - and nothing more.
 *
 * No round is opened and no date is implied. A campus drive shortlists from
 * the applications first and schedules afterwards, and a student told "you
 * are shortlisted" on Monday can prepare for a call that comes on Thursday.
 * Calling them to a round is the next route down.
 */
applicationRouter.post(
  '/:id/shortlist',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);
    const body = feedbackSchema.parse(req.body);

    res.json(
      await transition({
        applicationId: app.id,
        to: S.SHORTLISTED,
        actorId: req.session.userId!,
        note: body.note || undefined,
      }),
    );
  }),
);

/**
 * POST /api/company/applications/:id/invite
 *
 * Calls them to a round, which is what unlocks its date, its venue and its
 * link on the student's side. Round one by default; `roundId` names another,
 * for a drive that skips one or runs them out of order.
 */
applicationRouter.post(
  '/:id/invite',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);
    const { roundId } = z.object({ roundId: z.string().optional() }).parse(req.body);

    const round = roundId
      ? app.job.rounds.find((r) => r.id === roundId)
      : app.job.rounds[0];
    if (!round) {
      throw badRequest(
        roundId ? 'That round is not part of this role.' : 'This role has no rounds to call them to.',
      );
    }

    const result = await transition({
      applicationId: app.id,
      to: S.IN_ROUND,
      actorId: req.session.userId!,
      note: `Called to ${round.name}`,
    });

    await prisma.application.update({
      where: { id: app.id },
      data: { currentRoundId: round.id },
    });
    await prisma.roundResult.upsert({
      where: { applicationId_roundId: { applicationId: app.id, roundId: round.id } },
      update: {},
      create: { applicationId: app.id, roundId: round.id, outcome: RoundOutcome.PENDING },
    });

    res.json({ ...result, calledTo: round.name });
  }),
);

/**
 * POST /api/company/applications/:id/advance
 * Passes the current round. If another follows, they move into it; if this was
 * the last, they are offered the role.
 */
applicationRouter.post(
  '/:id/advance',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);
    const body = feedbackSchema.parse(req.body);

    if (!app.currentRoundId) {
      throw badRequest('They are not in a round yet. Call them to one first.');
    }

    const rounds = app.job.rounds;
    const index = rounds.findIndex((r) => r.id === app.currentRoundId);
    const next = index >= 0 ? rounds[index + 1] : undefined;

    await prisma.roundResult.upsert({
      where: { applicationId_roundId: { applicationId: app.id, roundId: app.currentRoundId } },
      update: {
        outcome: RoundOutcome.PASSED,
        score: body.score ?? null,
        feedback: body.feedback || null,
        evaluatedById: req.session.userId!,
        evaluatedAt: new Date(),
      },
      create: {
        applicationId: app.id,
        roundId: app.currentRoundId,
        outcome: RoundOutcome.PASSED,
        score: body.score ?? null,
        feedback: body.feedback || null,
        evaluatedById: req.session.userId!,
        evaluatedAt: new Date(),
      },
    });

    if (next) {
      const result = await transition({
        applicationId: app.id,
        to: S.IN_ROUND,
        actorId: req.session.userId!,
        note: `Passed ${rounds[index]!.name}, moved to ${next.name}`,
      });
      await prisma.application.update({
        where: { id: app.id },
        data: { currentRoundId: next.id },
      });
      await prisma.roundResult.upsert({
        where: { applicationId_roundId: { applicationId: app.id, roundId: next.id } },
        update: {},
        create: { applicationId: app.id, roundId: next.id, outcome: RoundOutcome.PENDING },
      });
      res.json({ ...result, movedTo: next.name });
      return;
    }

    /*
     * Passing the final round is not another move through the pipeline - it
     * is an offer, made to a person, and it needs the permission that says so.
     *
     * The check has to live here rather than on the route, because whether
     * this call makes an offer depends on how many rounds the role has. A
     * recruiter may run every round and still not be the one who offers.
     */
    if (!(await hasPermission(req, 'offer:make'))) {
      throw forbidden(
        `${rounds[index]!.name} is the last round, so passing it makes an offer. Your role cannot do that. It needs the "offer:make" permission.`,
      );
    }

    const result = await transition({
      applicationId: app.id,
      to: S.OFFERED,
      actorId: req.session.userId!,
      note: 'Cleared the final round',
    });
    res.json({ ...result, movedTo: 'OFFERED' });
  }),
);

/** POST /api/company/applications/:id/waitlist */
applicationRouter.post(
  '/:id/waitlist',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);
    const body = feedbackSchema.parse(req.body);

    res.json(
      await transition({
        applicationId: app.id,
        to: S.WAITLISTED,
        actorId: req.session.userId!,
        note: body.note || undefined,
      }),
    );
  }),
);

/** POST /api/company/applications/:id/reject */
applicationRouter.post(
  '/:id/reject',
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);
    const body = feedbackSchema.parse(req.body);

    if (app.currentRoundId) {
      await prisma.roundResult.updateMany({
        where: { applicationId: app.id, roundId: app.currentRoundId },
        data: {
          outcome: RoundOutcome.FAILED,
          feedback: body.feedback || null,
          evaluatedById: req.session.userId!,
          evaluatedAt: new Date(),
        },
      });
    }

    res.json(
      await transition({
        applicationId: app.id,
        to: S.REJECTED,
        actorId: req.session.userId!,
        note: body.note || undefined,
      }),
    );
  }),
);

/** POST /api/company/applications/:id/offer — skip straight to an offer */
applicationRouter.post(
  '/:id/offer',
  can('offer:make'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);

    res.json(
      await transition({ applicationId: app.id, to: S.OFFERED, actorId: req.session.userId! }),
    );
  }),
);

/** POST /api/company/applications/:id/hire — confirm they joined */
applicationRouter.post(
  '/:id/hire',
  can('offer:make'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const app = await ownedApplication(companyId, req.params.id!);

    res.json(
      await transition({ applicationId: app.id, to: S.HIRED, actorId: req.session.userId! }),
    );
  }),
);
