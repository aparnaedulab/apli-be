import { ApplicationStatus, JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { inTenant } from '../tenants/tenant.context.js';

/**
 * The operations overview: one screen that answers "what is actually going on".
 *
 * The existing /admin/stats answers "how many of each thing exist". That is a
 * different question, and a count on its own has never told anybody whether a
 * season is going well. Four hundred applications is good news or bad news
 * depending entirely on whether anybody is answering them.
 *
 * So this is built round movement and answers rather than totals:
 *
 *   pulse          what happened in the last N days, against the N before it,
 *                  because a number with nothing to compare it to is a number
 *                  nobody can act on
 *   funnel         the same stages as the dashboard, but with the drop between
 *                  each one, which is where a season is actually lost
 *   companies      how long they take to answer, and who is sitting on
 *                  applications past the institution's own deadline
 *   students       how long they take to answer an offer, and how much of the
 *                  roll is verified and actually applying
 *   colleges       a league table, so a dormant campus is visible
 *   recruiters     the same for companies
 *   activity       the recent feed, so "what changed today" needs no query
 *
 * Everything is fenced to the tenant with the same helpers every other query
 * uses. Nothing here writes.
 */

/** Rows read when computing a median. High enough to be representative, bounded so one busy tenant cannot stall the page. */
const SAMPLE = 4000;

/** How many rows each league table and the activity feed return. */
const TOP = 12;
const FEED = 30;

export interface OverviewOptions {
  tenantId: string;
  /** The window, in days. */
  days: number;
}

/** A count for this window and the one before it, so every figure has a direction. */
export interface Trend {
  now: number;
  before: number;
}

const trend = (now: number, before: number): Trend => ({ now, before });

/** The middle value, or null when there is nothing to take a middle of. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 10) / 10;
}

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY;

/**
 * The statuses that mean the company has not answered yet.
 *
 * WAITLISTED is deliberately not here: a waitlist is an answer, and a poor one
 * to be given, but it is not silence.
 */
const AWAITING_COMPANY: ApplicationStatus[] = [
  ApplicationStatus.APPLIED,
  ApplicationStatus.UNDER_REVIEW,
];

export async function operationsOverview({ tenantId, days }: OverviewOptions) {
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY);
  const previousFrom = new Date(now.getTime() - 2 * days * DAY);

  const application = inTenant.application(tenantId);
  const candidate = inTenant.candidate(tenantId);
  const job = inTenant.job(tenantId);
  const college = inTenant.college(tenantId);

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { responseDays: true },
  });
  const targetDays = tenant?.responseDays ?? 7;

  // CampusWeek carries a bare collegeId with no relation to follow, so its
  // fence has to be built from the tenant's colleges by hand.
  const collegeIds = (
    await prisma.college.findMany({ where: college, select: { id: true } })
  ).map((c) => c.id);

  /** An application whose events happened inside a window. */
  const eventsIn = (to: ApplicationStatus, gte: Date, lt: Date): Prisma.StatusEventWhereInput => ({
    toStatus: to,
    createdAt: { gte, lt },
    application: application,
  });

  const [
    studentsNow,
    studentsBefore,
    appsNow,
    appsBefore,
    jobsNow,
    jobsBefore,
    offersNow,
    offersBefore,
    acceptedNow,
    acceptedBefore,
    eventsNow,
    eventsBefore,
    postsNow,
    postsBefore,
  ] = await Promise.all([
    prisma.candidate.count({ where: { AND: [candidate, { createdAt: { gte: from } }] } }),
    prisma.candidate.count({
      where: { AND: [candidate, { createdAt: { gte: previousFrom, lt: from } }] },
    }),
    prisma.application.count({ where: { ...application, appliedAt: { gte: from } } }),
    prisma.application.count({
      where: { ...application, appliedAt: { gte: previousFrom, lt: from } },
    }),
    prisma.job.count({ where: { AND: [job, { publishedAt: { gte: from } }] } }),
    prisma.job.count({ where: { AND: [job, { publishedAt: { gte: previousFrom, lt: from } }] } }),
    prisma.statusEvent.count({ where: eventsIn(ApplicationStatus.OFFERED, from, now) }),
    prisma.statusEvent.count({ where: eventsIn(ApplicationStatus.OFFERED, previousFrom, from) }),
    prisma.statusEvent.count({ where: eventsIn(ApplicationStatus.ACCEPTED, from, now) }),
    prisma.statusEvent.count({ where: eventsIn(ApplicationStatus.ACCEPTED, previousFrom, from) }),
    prisma.campusWeekEvent.count({
      where: { startsAt: { gte: from }, week: { collegeId: { in: collegeIds } } },
    }),
    prisma.campusWeekEvent.count({
      where: {
        startsAt: { gte: previousFrom, lt: from },
        week: { collegeId: { in: collegeIds } },
      },
    }),
    prisma.companyPost.count({ where: { deletedAt: null, publishedAt: { gte: from } } }),
    prisma.companyPost.count({
      where: { deletedAt: null, publishedAt: { gte: previousFrom, lt: from } },
    }),
  ]);

  // --- the funnel -----------------------------------------------------------
  //
  // Counted on "has this application ever reached this stage", not on where it
  // is sitting now. Current status cannot answer the question the section asks:
  // an application at HIRED is no longer counted at APPLIED, so a column of
  // live counts shows no funnel at all and the drop between two of them is a
  // number that means nothing. The status history is the only honest source,
  // and it is exactly what StatusEvent exists to keep.
  const FUNNEL_STAGES = [
    ApplicationStatus.APPLIED,
    ApplicationStatus.UNDER_REVIEW,
    ApplicationStatus.SHORTLISTED,
    ApplicationStatus.IN_ROUND,
    ApplicationStatus.OFFERED,
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.HIRED,
  ] as const;

  const reached = await Promise.all(
    FUNNEL_STAGES.map((stage) =>
      stage === ApplicationStatus.APPLIED
        ? // Every application was applied for, and the first status is set
          // without a transition into it, so there is no event to count.
          prisma.application.count({ where: application })
        : prisma.application.count({
            where: { ...application, events: { some: { toStatus: stage } } },
          }),
    ),
  );
  const statusCount = new Map(FUNNEL_STAGES.map((s, i) => [s, reached[i]!]));

  // --- how long companies take to answer ------------------------------------
  //
  // Measured from the application to the first move away from APPLIED, which
  // is the only moment the student experiences as "somebody looked".
  const answered = await prisma.application.findMany({
    where: { ...application, appliedAt: { gte: previousFrom } },
    select: {
      appliedAt: true,
      events: {
        where: { toStatus: { not: ApplicationStatus.APPLIED } },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    take: SAMPLE,
  });

  const firstResponseDays = answered
    .map((a) => (a.events[0] ? daysBetween(a.appliedAt, a.events[0].createdAt) : null))
    .filter((d): d is number => d !== null);

  const withinTarget = firstResponseDays.filter((d) => d <= targetDays).length;

  const overdueNow = await prisma.application.count({
    where: {
      ...application,
      status: { in: AWAITING_COMPANY },
      appliedAt: { lt: new Date(now.getTime() - targetDays * DAY) },
    },
  });

  // --- how long students take to answer an offer ----------------------------
  const offered = await prisma.application.findMany({
    where: {
      ...application,
      events: { some: { toStatus: ApplicationStatus.OFFERED, createdAt: { gte: previousFrom } } },
    },
    select: {
      events: {
        where: {
          toStatus: {
            in: [ApplicationStatus.OFFERED, ApplicationStatus.ACCEPTED, ApplicationStatus.DECLINED],
          },
        },
        orderBy: { createdAt: 'asc' },
        select: { toStatus: true, createdAt: true },
      },
    },
    take: SAMPLE,
  });

  const offerAnswerDays: number[] = [];
  for (const row of offered) {
    const madeAt = row.events.find((e) => e.toStatus === ApplicationStatus.OFFERED)?.createdAt;
    if (!madeAt) continue;
    const answeredAt = row.events.find(
      (e) =>
        e.createdAt > madeAt &&
        (e.toStatus === ApplicationStatus.ACCEPTED || e.toStatus === ApplicationStatus.DECLINED),
    )?.createdAt;
    if (answeredAt) offerAnswerDays.push(daysBetween(madeAt, answeredAt));
  }

  const [offersPending, students, frozen, appliedAtLeastOnce] = await Promise.all([
    prisma.application.count({ where: { ...application, status: ApplicationStatus.OFFERED } }),
    prisma.candidate.count({ where: candidate }),
    prisma.batchMembership.count({ where: { isFrozen: true, batch: { tenantId } } }),
    prisma.candidate.count({ where: { AND: [candidate, { applications: { some: {} } }] } }),
  ]);

  // --- league tables --------------------------------------------------------
  const collegeRows = await prisma.college.findMany({
    where: college,
    select: {
      id: true,
      name: true,
      _count: { select: { candidates: true } },
    },
    take: 200,
  });

  const [appsByCollege, offersByCollege, frozenByCollege] = await Promise.all([
    prisma.application.groupBy({
      by: ['placementId'],
      where: application,
      _count: { _all: true },
    }),
    prisma.application.groupBy({
      by: ['placementId'],
      where: {
        ...application,
        status: { in: [ApplicationStatus.OFFERED, ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
      },
      _count: { _all: true },
    }),
    prisma.batchMembership.groupBy({
      by: ['batchId'],
      where: { isFrozen: true, batch: { tenantId } },
      _count: { _all: true },
    }),
  ]);

  // placementId and batchId have to be resolved back to their college.
  const [placements, batches] = await Promise.all([
    prisma.placement.findMany({
      where: inTenant.placement(tenantId),
      select: { id: true, collegeId: true },
    }),
    prisma.batch.findMany({ where: inTenant.batch(tenantId), select: { id: true, collegeId: true } }),
  ]);
  const placementCollege = new Map(placements.map((p) => [p.id, p.collegeId]));
  const batchCollege = new Map(batches.map((b) => [b.id, b.collegeId]));

  const sumBy = <T>(rows: T[], key: (r: T) => string | null | undefined, n: (r: T) => number) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      if (k) m.set(k, (m.get(k) ?? 0) + n(r));
    }
    return m;
  };

  const collegeApps = sumBy(appsByCollege, (r) => placementCollege.get(r.placementId), (r) => r._count._all);
  const collegeOffers = sumBy(offersByCollege, (r) => placementCollege.get(r.placementId), (r) => r._count._all);
  const collegeFrozen = sumBy(frozenByCollege, (r) => batchCollege.get(r.batchId), (r) => r._count._all);

  const colleges = collegeRows
    .map((c) => ({
      id: c.id,
      name: c.name,
      students: c._count.candidates,
      frozen: collegeFrozen.get(c.id) ?? 0,
      applications: collegeApps.get(c.id) ?? 0,
      offers: collegeOffers.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.applications - a.applications || b.students - a.students)
    .slice(0, TOP);

  // --- recruiters -----------------------------------------------------------
  const jobRows = await prisma.job.findMany({
    where: { AND: [job, { status: { not: JobStatus.DRAFT } }] },
    select: {
      id: true,
      companyId: true,
      company: { select: { name: true } },
      _count: { select: { applications: true } },
    },
    take: 500,
  });

  const offersByJob = await prisma.application.groupBy({
    by: ['jobId'],
    where: {
      ...application,
      status: { in: [ApplicationStatus.OFFERED, ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
    },
    _count: { _all: true },
  });
  const jobOffers = new Map(offersByJob.map((r) => [r.jobId, r._count._all]));

  const byCompany = new Map<
    string,
    { id: string; name: string; jobs: number; applications: number; offers: number }
  >();
  for (const j of jobRows) {
    const row = byCompany.get(j.companyId) ?? {
      id: j.companyId,
      name: j.company.name,
      jobs: 0,
      applications: 0,
      offers: 0,
    };
    row.jobs += 1;
    row.applications += j._count.applications;
    row.offers += jobOffers.get(j.id) ?? 0;
    byCompany.set(j.companyId, row);
  }

  const recruiters = [...byCompany.values()]
    .sort((a, b) => b.applications - a.applications || b.jobs - a.jobs)
    .slice(0, TOP);

  // --- who is sitting on applications ---------------------------------------
  const stalled = await prisma.application.findMany({
    where: {
      ...application,
      status: { in: AWAITING_COMPANY },
      appliedAt: { lt: new Date(now.getTime() - targetDays * DAY) },
    },
    select: {
      id: true,
      appliedAt: true,
      job: { select: { title: true, company: { select: { name: true } } } },
    },
    orderBy: { appliedAt: 'asc' },
    take: TOP,
  });

  // --- the feed -------------------------------------------------------------
  const recentEvents = await prisma.statusEvent.findMany({
    where: {
      application: application,
      toStatus: {
        in: [
          ApplicationStatus.OFFERED,
          ApplicationStatus.ACCEPTED,
          ApplicationStatus.HIRED,
          ApplicationStatus.REJECTED,
        ],
      },
      createdAt: { gte: from },
    },
    orderBy: { createdAt: 'desc' },
    take: FEED,
    select: {
      id: true,
      toStatus: true,
      createdAt: true,
      application: {
        select: {
          job: { select: { title: true, company: { select: { name: true } } } },
          placement: { select: { college: { select: { name: true } } } },
        },
      },
    },
  });

  const recentJobs = await prisma.job.findMany({
    where: { AND: [job, { publishedAt: { gte: from } }] },
    orderBy: { publishedAt: 'desc' },
    take: FEED,
    select: { id: true, title: true, publishedAt: true, company: { select: { name: true } } },
  });

  const activity = [
    ...recentEvents.map((e) => ({
      id: e.id,
      at: e.createdAt,
      kind: e.toStatus,
      what: `${e.application.job.company.name} · ${e.application.job.title}`,
      where: e.application.placement.college.name,
    })),
    ...recentJobs.map((j) => ({
      id: j.id,
      at: j.publishedAt!,
      kind: 'PUBLISHED' as const,
      what: `${j.company.name} · ${j.title}`,
      where: null as string | null,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, FEED);

  const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null);

  return {
    window: { days, from, until: now },
    pulse: {
      students: trend(studentsNow, studentsBefore),
      applications: trend(appsNow, appsBefore),
      jobsPublished: trend(jobsNow, jobsBefore),
      offers: trend(offersNow, offersBefore),
      accepted: trend(acceptedNow, acceptedBefore),
      events: trend(eventsNow, eventsBefore),
      posts: trend(postsNow, postsBefore),
    },
    funnel: FUNNEL_STAGES.map((status) => ({ status, count: statusCount.get(status) ?? 0 })),
    companies: {
      targetDays,
      medianFirstResponseDays: median(firstResponseDays),
      answeredWithinTargetPct: pct(withinTarget, firstResponseDays.length),
      measured: firstResponseDays.length,
      overdueNow,
      stalled: stalled.map((s) => ({
        id: s.id,
        company: s.job.company.name,
        role: s.job.title,
        waitingDays: Math.floor(daysBetween(s.appliedAt, now)),
      })),
    },
    students: {
      medianOfferAnswerDays: median(offerAnswerDays),
      measured: offerAnswerDays.length,
      offersPending,
      students,
      frozen,
      frozenPct: pct(frozen, students),
      appliedPct: pct(appliedAtLeastOnce, students),
    },
    colleges,
    recruiters,
    activity,
  };
}
