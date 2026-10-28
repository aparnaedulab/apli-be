import { InternshipOfferStatus, Prisma, RunStatus, WorkSimulationStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';

/**
 * What students do in the student app, read for the people who look after
 * them: an institution's admins (scoped to that institution's students) and
 * the platform team (every student, including those whose college is not on
 * Apli.ai yet).
 *
 * Every function takes `scope`, the students the caller may see, so the same
 * read serves both and neither can see past its own fence.
 */
export type StudentScope = Prisma.CandidateWhereInput;

export const activityQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().trim().max(30).optional(),
  /** Platform only: students not attached to any partner college. */
  attached: z.enum(['true', 'false']).optional(),
});
export type ActivityQuery = z.infer<typeof activityQuery>;

function paged<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

const skipTake = (p: { page: number; pageSize: number }) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});

/** Name or email contains the search. */
function studentSearch(q?: string): StudentScope {
  return q
    ? { OR: [{ user: { email: { contains: q } } }, { user: { fullName: { contains: q } } }] }
    : {};
}

/** A student with no partner college and no batch: signed up on their own. */
export const unattached: StudentScope = { collegeId: null, batchMemberships: { none: {} } };

const collegeSelect = {
  college: { select: { name: true } },
  listing: { select: { name: true, city: true } },
  otherCollege: true,
} as const;

function collegeName(c: {
  college: { name: string } | null;
  listing: { name: string; city: string } | null;
  otherCollege: string | null;
}) {
  return c.college?.name ?? (c.listing ? `${c.listing.name}, ${c.listing.city}` : null) ?? c.otherCollege ?? null;
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

export async function activityStats(scope: StudentScope) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const run = (where: Prisma.WorkSimulationRunWhereInput) =>
    prisma.workSimulationRun.count({ where: { AND: [{ candidate: scope }, where] } });

  const [
    students,
    newStudents,
    activeStudents,
    started,
    inProgress,
    inReview,
    needsWork,
    certified,
    offersSent,
    offersAccepted,
    offersOpen,
    interviews,
    interviewsOpen,
    liveSimulations,
    byField,
  ] = await Promise.all([
    prisma.candidate.count({ where: scope }),
    prisma.candidate.count({ where: { AND: [scope, { createdAt: { gte: since } }] } }),
    prisma.candidate.count({
      where: { AND: [scope, { workSimulationRuns: { some: { lastActiveAt: { gte: since } } } }] },
    }),
    run({}),
    run({ status: RunStatus.ACTIVE }),
    run({ status: RunStatus.IN_REVIEW }),
    run({ status: RunStatus.NEEDS_WORK }),
    run({ status: RunStatus.COMPLETED }),
    prisma.internshipOffer.count({ where: { candidate: scope } }),
    prisma.internshipOffer.count({ where: { candidate: scope, status: InternshipOfferStatus.ACCEPTED } }),
    prisma.internshipOffer.count({
      where: { candidate: scope, status: InternshipOfferStatus.SENT, respondBy: { gte: startOfToday() } },
    }),
    prisma.interviewInvite.count({ where: { candidate: scope, status: { not: 'WITHDRAWN' } } }),
    prisma.interviewInvite.count({ where: { candidate: scope, status: { in: ['PENDING', 'ACCEPTED'] } } }),
    prisma.workSimulation.count({ where: { status: WorkSimulationStatus.LIVE } }),
    prisma.workSimulationRun.findMany({
      where: { candidate: scope },
      select: { status: true, simulation: { select: { field: true } } },
    }),
  ]);

  // Which fields students are trying, and how far they get in each.
  const fields = new Map<string, { field: string; started: number; certified: number }>();
  for (const r of byField) {
    const f = fields.get(r.simulation.field) ?? { field: r.simulation.field, started: 0, certified: 0 };
    f.started += 1;
    if (r.status === RunStatus.COMPLETED) f.certified += 1;
    fields.set(r.simulation.field, f);
  }

  return {
    students,
    newStudents,
    activeStudents,
    simulations: { live: liveSimulations, started, inProgress, inReview, needsWork, certified },
    offers: { sent: offersSent, accepted: offersAccepted, open: offersOpen },
    interviews: { total: interviews, open: interviewsOpen },
    fields: [...fields.values()].sort((a, b) => b.started - a.started).slice(0, 8),
  };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/* -------------------------------------------------------------------------- */
/* Students                                                                    */
/* -------------------------------------------------------------------------- */

export async function listStudents(scope: StudentScope, p: ActivityQuery) {
  const where: StudentScope = {
    AND: [
      scope,
      studentSearch(p.q),
      p.attached === 'false' ? unattached : {},
      p.attached === 'true' ? { NOT: unattached } : {},
      p.status === 'certified' ? { workSimulationRuns: { some: { status: RunStatus.COMPLETED } } } : {},
      p.status === 'active' ? { workSimulationRuns: { some: { status: { in: [RunStatus.ACTIVE, RunStatus.IN_REVIEW, RunStatus.NEEDS_WORK] } } } } : {},
      p.status === 'idle' ? { workSimulationRuns: { none: {} } } : {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.candidate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...skipTake(p),
      select: {
        id: true,
        createdAt: true,
        course: true,
        graduationYear: true,
        ...collegeSelect,
        user: { select: { fullName: true, email: true, isActive: true, lastLoginAt: true } },
        batchMemberships: { take: 1, select: { batch: { select: { name: true } } } },
        workSimulationRuns: { select: { status: true } },
        _count: { select: { internshipOffers: true, interviewInvites: true } },
      },
    }),
    prisma.candidate.count({ where }),
  ]);

  return paged(
    rows.map((c) => ({
      id: c.id,
      name: c.user.fullName,
      email: c.user.email,
      isActive: c.user.isActive,
      lastLoginAt: c.user.lastLoginAt,
      joinedAt: c.createdAt,
      college: collegeName(c),
      onPartnerCollege: Boolean(c.college),
      course: c.course,
      graduationYear: c.graduationYear,
      batch: c.batchMemberships[0]?.batch.name ?? null,
      started: c.workSimulationRuns.length,
      certified: c.workSimulationRuns.filter((r) => r.status === RunStatus.COMPLETED).length,
      offers: c._count.internshipOffers,
      interviews: c._count.interviewInvites,
    })),
    total,
    p.page,
    p.pageSize,
  );
}

/** Everything one student has done in the app, for a side panel. */
export async function studentDetail(scope: StudentScope, id: string) {
  const c = await prisma.candidate.findFirst({
    where: { AND: [scope, { id }] },
    select: {
      id: true,
      createdAt: true,
      phone: true,
      city: true,
      course: true,
      specialisation: true,
      degreeLevel: true,
      graduationYear: true,
      headline: true,
      interests: true,
      ...collegeSelect,
      user: { select: { fullName: true, email: true, isActive: true, lastLoginAt: true } },
      batchMemberships: { select: { rollNo: true, batch: { select: { id: true, name: true } } } },
      workSimulationRuns: {
        orderBy: { lastActiveAt: 'desc' },
        select: {
          id: true,
          status: true,
          startedAt: true,
          lastActiveAt: true,
          submittedAt: true,
          completedAt: true,
          certificateCode: true,
          reviewNote: true,
          simulation: {
            select: {
              title: true,
              field: true,
              company: { select: { name: true } },
              _count: { select: { tasks: true } },
            },
          },
          _count: { select: { done: true, shares: true } },
        },
      },
      internshipOffers: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          role: true,
          status: true,
          months: true,
          stipend: true,
          workMode: true,
          respondBy: true,
          createdAt: true,
          company: { select: { name: true } },
        },
      },
      interviewInvites: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          role: true,
          status: true,
          currentRoundOrder: true,
          createdAt: true,
          company: { select: { name: true } },
          process: { select: { _count: { select: { rounds: true } } } },
        },
      },
    },
  });
  if (!c) throw notFound('No such student.');

  return {
    id: c.id,
    name: c.user.fullName,
    email: c.user.email,
    phone: c.phone,
    isActive: c.user.isActive,
    lastLoginAt: c.user.lastLoginAt,
    joinedAt: c.createdAt,
    college: collegeName(c),
    onPartnerCollege: Boolean(c.college),
    city: c.city,
    degreeLevel: c.degreeLevel,
    course: c.course,
    specialisation: c.specialisation,
    graduationYear: c.graduationYear,
    headline: c.headline,
    interests: Array.isArray(c.interests) ? (c.interests as string[]) : [],
    batches: c.batchMemberships.map((m) => ({ id: m.batch.id, name: m.batch.name, rollNo: m.rollNo })),
    runs: c.workSimulationRuns.map((r) => ({
      id: r.id,
      status: r.status,
      simulation: r.simulation.title,
      field: r.simulation.field,
      company: r.simulation.company.name,
      tasksDone: r._count.done,
      tasks: r.simulation._count.tasks,
      sharedWith: r._count.shares,
      startedAt: r.startedAt,
      lastActiveAt: r.lastActiveAt,
      submittedAt: r.submittedAt,
      completedAt: r.completedAt,
      certificateCode: r.certificateCode,
      reviewNote: r.reviewNote,
    })),
    offers: c.internshipOffers.map((o) => ({
      id: o.id,
      company: o.company.name,
      role: o.role,
      status: offerStatus(o.status, o.respondBy),
      months: o.months,
      stipend: o.stipend,
      workMode: o.workMode,
      respondBy: o.respondBy,
      sentAt: o.createdAt,
    })),
    interviews: c.interviewInvites.map((i) => ({
      id: i.id,
      company: i.company.name,
      role: i.role,
      status: i.status,
      round: i.currentRoundOrder,
      rounds: i.process._count.rounds,
      sentAt: i.createdAt,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Simulations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The simulations live on the platform, with how this scope's students are
 * getting on in each. Simulations are the companies', shared by everyone;
 * the numbers are the scope's own.
 */
export async function listSimulations(scope: StudentScope, p: ActivityQuery) {
  const where: Prisma.WorkSimulationWhereInput = {
    AND: [
      p.status && p.status in WorkSimulationStatus
        ? { status: p.status as WorkSimulationStatus }
        : { status: { in: [WorkSimulationStatus.LIVE, WorkSimulationStatus.RETIRED] } },
      p.q
        ? { OR: [{ title: { contains: p.q } }, { field: { contains: p.q } }, { company: { name: { contains: p.q } } }] }
        : {},
    ],
  };

  const [sims, total] = await Promise.all([
    prisma.workSimulation.findMany({
      where,
      orderBy: [{ status: 'asc' }, { publishedAt: 'desc' }],
      ...skipTake(p),
      select: {
        id: true,
        slug: true,
        title: true,
        field: true,
        level: true,
        hours: true,
        status: true,
        publishedAt: true,
        company: { select: { name: true } },
        _count: { select: { tasks: true } },
      },
    }),
    prisma.workSimulation.count({ where }),
  ]);

  const counts = sims.length
    ? await prisma.workSimulationRun.groupBy({
        by: ['simulationId', 'status'],
        where: { simulationId: { in: sims.map((s) => s.id) }, candidate: scope },
        _count: { _all: true },
      })
    : [];

  return paged(
    sims.map((s) => {
      const mine = counts.filter((c) => c.simulationId === s.id);
      const n = (st?: RunStatus) =>
        mine.filter((c) => !st || c.status === st).reduce((a, c) => a + c._count._all, 0);
      return {
        id: s.id,
        slug: s.slug,
        title: s.title,
        company: s.company.name,
        field: s.field,
        level: s.level,
        hours: s.hours,
        tasks: s._count.tasks,
        status: s.status,
        publishedAt: s.publishedAt,
        started: n(),
        inReview: n(RunStatus.IN_REVIEW),
        certified: n(RunStatus.COMPLETED),
      };
    }),
    total,
    p.page,
    p.pageSize,
  );
}

/* -------------------------------------------------------------------------- */
/* Student work (simulation runs)                                              */
/* -------------------------------------------------------------------------- */

export async function listRuns(scope: StudentScope, p: ActivityQuery) {
  const where: Prisma.WorkSimulationRunWhereInput = {
    AND: [
      { candidate: { AND: [scope, studentSearch(p.q)] } },
      p.status && p.status in RunStatus ? { status: p.status as RunStatus } : {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.workSimulationRun.findMany({
      where,
      orderBy: { lastActiveAt: 'desc' },
      ...skipTake(p),
      select: {
        id: true,
        status: true,
        startedAt: true,
        lastActiveAt: true,
        submittedAt: true,
        completedAt: true,
        certificateCode: true,
        candidate: { select: { id: true, ...collegeSelect, user: { select: { fullName: true, email: true } } } },
        simulation: {
          select: { title: true, field: true, company: { select: { name: true } }, _count: { select: { tasks: true } } },
        },
        _count: { select: { done: true, shares: true } },
      },
    }),
    prisma.workSimulationRun.count({ where }),
  ]);

  return paged(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      studentId: r.candidate.id,
      student: r.candidate.user.fullName,
      email: r.candidate.user.email,
      college: collegeName(r.candidate),
      simulation: r.simulation.title,
      company: r.simulation.company.name,
      field: r.simulation.field,
      tasksDone: r._count.done,
      tasks: r.simulation._count.tasks,
      sharedWith: r._count.shares,
      startedAt: r.startedAt,
      lastActiveAt: r.lastActiveAt,
      submittedAt: r.submittedAt,
      completedAt: r.completedAt,
      certificateCode: r.certificateCode,
    })),
    total,
    p.page,
    p.pageSize,
  );
}

/* -------------------------------------------------------------------------- */
/* Internship offers                                                           */
/* -------------------------------------------------------------------------- */

/** A SENT offer past its reply-by date has lapsed; nobody marks it so. */
function offerStatus(status: InternshipOfferStatus, respondBy: Date) {
  return status === InternshipOfferStatus.SENT && respondBy < startOfToday() ? 'LAPSED' : status;
}

export async function listOffers(scope: StudentScope, p: ActivityQuery) {
  const today = startOfToday();
  const statusWhere: Prisma.InternshipOfferWhereInput =
    p.status === 'LAPSED'
      ? { status: InternshipOfferStatus.SENT, respondBy: { lt: today } }
      : p.status === 'SENT'
        ? { status: InternshipOfferStatus.SENT, respondBy: { gte: today } }
        : p.status && p.status in InternshipOfferStatus
          ? { status: p.status as InternshipOfferStatus }
          : {};
  const where: Prisma.InternshipOfferWhereInput = {
    AND: [{ candidate: { AND: [scope, studentSearch(p.q)] } }, statusWhere],
  };

  const [rows, total] = await Promise.all([
    prisma.internshipOffer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...skipTake(p),
      select: {
        id: true,
        role: true,
        status: true,
        workMode: true,
        city: true,
        months: true,
        stipend: true,
        startsOn: true,
        respondBy: true,
        respondedAt: true,
        createdAt: true,
        company: { select: { name: true } },
        run: { select: { simulation: { select: { title: true } } } },
        candidate: { select: { id: true, ...collegeSelect, user: { select: { fullName: true, email: true } } } },
      },
    }),
    prisma.internshipOffer.count({ where }),
  ]);

  return paged(
    rows.map((o) => ({
      id: o.id,
      studentId: o.candidate.id,
      student: o.candidate.user.fullName,
      email: o.candidate.user.email,
      college: collegeName(o.candidate),
      company: o.company.name,
      role: o.role,
      status: offerStatus(o.status, o.respondBy),
      workMode: o.workMode,
      city: o.city,
      months: o.months,
      stipend: o.stipend,
      startsOn: o.startsOn,
      respondBy: o.respondBy,
      respondedAt: o.respondedAt,
      sentAt: o.createdAt,
      fromSimulation: o.run?.simulation.title ?? null,
    })),
    total,
    p.page,
    p.pageSize,
  );
}

/* -------------------------------------------------------------------------- */
/* Interviews                                                                  */
/* -------------------------------------------------------------------------- */

const INVITE_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'REJECTED', 'OFFERED'];

export async function listInterviews(scope: StudentScope, p: ActivityQuery) {
  const where: Prisma.InterviewInviteWhereInput = {
    AND: [
      { candidate: { AND: [scope, studentSearch(p.q)] } },
      p.status && INVITE_STATUSES.includes(p.status) ? { status: p.status } : {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.interviewInvite.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      ...skipTake(p),
      select: {
        id: true,
        role: true,
        status: true,
        currentRoundOrder: true,
        respondedAt: true,
        createdAt: true,
        updatedAt: true,
        company: { select: { name: true } },
        process: {
          select: { title: true, rounds: { orderBy: { order: 'asc' }, select: { order: true, name: true } } },
        },
        candidate: { select: { id: true, ...collegeSelect, user: { select: { fullName: true, email: true } } } },
      },
    }),
    prisma.interviewInvite.count({ where }),
  ]);

  return paged(
    rows.map((i) => ({
      id: i.id,
      studentId: i.candidate.id,
      student: i.candidate.user.fullName,
      email: i.candidate.user.email,
      college: collegeName(i.candidate),
      company: i.company.name,
      role: i.role,
      status: i.status,
      round: i.currentRoundOrder,
      rounds: i.process.rounds.length,
      roundName: i.process.rounds.find((r) => r.order === i.currentRoundOrder)?.name ?? null,
      sentAt: i.createdAt,
      respondedAt: i.respondedAt,
      updatedAt: i.updatedAt,
    })),
    total,
    p.page,
    p.pageSize,
  );
}
