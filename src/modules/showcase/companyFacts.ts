import { ApplicationStatus, JobStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { honourSummary, MIN_RATINGS, ratingSummary } from '../afterOffer/afterOffer.service.js';

/**
 * What the platform measures about a company - the middle layer of the
 * company page.
 *
 * Everything here is computed from what actually happened on the platform:
 * roles published, applications answered, offers made and kept. None of it is
 * a column the company can edit, which is the whole point - a company earns a
 * good page by behaving well, not by writing well.
 *
 * Every fact says whether there is enough behind it. A median of one reply is
 * not a median, and printing it would mislead more than saying nothing, so
 * below a small threshold a fact reads "Not enough data yet".
 */

/** How long a company is given to answer before it counts as slow. */
export const ANSWER_WITHIN_DAYS = 7;

/** The fewest data points a fact needs before its number is shown. */
export const MIN_RESPONSES = 5;
export const MIN_JOBS = 3;

const DAY = 24 * 60 * 60 * 1000;

export interface Fact {
  key: string;
  label: string;
  /** The number as a person reads it - "2.5 days", "80%". Null without enough data. */
  display: string | null;
  /** The raw figure behind `display`, for anything that wants to sort or colour it. */
  value: number | null;
  enough: boolean;
  /** One sentence saying what the figure means, or why there is none. */
  sentence: string;
  /** For the company's own editor: what would move this fact. */
  improve: string | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const pct = (part: number, whole: number) => Math.round((part / whole) * 100);

function days(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} day${rounded === 1 ? '' : 's'}`;
}

/** Statuses that mean an offer was made at some point. */
const OFFERED_OR_LATER: ApplicationStatus[] = [
  ApplicationStatus.OFFERED,
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.DECLINED,
  ApplicationStatus.HIRED,
];
const OFFER_TAKEN: ApplicationStatus[] = [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED];

export async function companyFacts(companyId: string, now = new Date()): Promise<Fact[]> {
  const [company, jobs, applications] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { createdAt: true } }),
    prisma.job.findMany({
      where: { companyId, publishedAt: { not: null }, status: { not: JobStatus.DRAFT } },
      select: { ctcFixed: true, bondMonths: true, bondAmount: true },
    }),
    prisma.application.findMany({
      where: { job: { companyId } },
      select: {
        status: true,
        appliedAt: true,
        placement: { select: { collegeId: true } },
        // The first thing that happened after applying - the company's answer.
        events: {
          where: { toStatus: { not: ApplicationStatus.APPLIED } },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    }),
  ]);

  // Offers are read from the status history as well as the current status, so
  // an offer later declined or withdrawn still counts as made.
  const offeredViaHistory = await prisma.statusEvent.findMany({
    where: { toStatus: ApplicationStatus.OFFERED, application: { job: { companyId } } },
    select: { applicationId: true },
    distinct: ['applicationId'],
  });

  /* --- roles ------------------------------------------------------------- */

  const published = jobs.length;

  /* --- responses ---------------------------------------------------------- */

  const responseDays = applications
    .filter((a) => a.events[0])
    .map((a) => (a.events[0]!.createdAt.getTime() - a.appliedAt.getTime()) / DAY);
  const typical = median(responseDays);

  // Only applications old enough to have had the full window can count
  // against the company - one made yesterday is not late yet.
  const due = applications.filter((a) => now.getTime() - a.appliedAt.getTime() >= ANSWER_WITHIN_DAYS * DAY);
  const onTime = due.filter(
    (a) => a.events[0] && a.events[0].createdAt.getTime() - a.appliedAt.getTime() <= ANSWER_WITHIN_DAYS * DAY,
  );

  /* --- offers and hires ----------------------------------------------------- */

  const offers = new Set(offeredViaHistory.map((e) => e.applicationId)).size;
  const offersFromStatus = applications.filter((a) => OFFERED_OR_LATER.includes(a.status)).length;
  const offersMade = Math.max(offers, offersFromStatus);
  const offersTaken = applications.filter((a) => OFFER_TAKEN.includes(a.status)).length;
  const colleges = new Set(
    applications.filter((a) => OFFER_TAKEN.includes(a.status)).map((a) => a.placement.collegeId),
  ).size;

  /* --- terms ------------------------------------------------------------------ */

  const statesFixed = jobs.filter((j) => j.ctcFixed !== null).length;
  const withBond = jobs.filter((j) => (j.bondMonths ?? 0) > 0 || Number(j.bondAmount ?? 0) > 0).length;

  /* --- after the offer ------------------------------------------------------- */

  // Kept offers against withdrawn ones, and how students rated the process -
  // both from the offer-protection and reputation records, both totals only.
  const [honourBy, ratingBy] = await Promise.all([honourSummary([companyId]), ratingSummary([companyId])]);
  const honour = honourBy.get(companyId)!;
  const rating = ratingBy.get(companyId)!;

  const enoughResponses = responseDays.length >= MIN_RESPONSES;
  const enoughDue = due.length >= MIN_RESPONSES;
  const enoughJobs = published >= MIN_JOBS;
  const notYet = 'Not enough data yet.';

  return [
    {
      key: 'rolesPublished',
      label: 'Roles published',
      display: String(published),
      value: published,
      enough: true,
      sentence:
        published === 0
          ? 'No roles published on the platform yet.'
          : `${published} role${published === 1 ? '' : 's'} published on the platform.`,
      improve: null,
    },
    {
      key: 'collegesHiredFrom',
      label: 'Colleges hired from',
      display: String(colleges),
      value: colleges,
      enough: true,
      sentence:
        colleges === 0
          ? 'Nobody has accepted an offer from them on the platform yet.'
          : `Students from ${colleges} college${colleges === 1 ? '' : 's'} have accepted their offers.`,
      improve: null,
    },
    {
      key: 'offers',
      label: 'Offers made / accepted',
      display: `${offersMade} / ${offersTaken}`,
      value: offersMade,
      enough: true,
      sentence:
        offersMade === 0
          ? 'No offers made on the platform yet.'
          : `${offersMade} offer${offersMade === 1 ? '' : 's'} made, ${offersTaken} accepted.`,
      improve: null,
    },
    {
      key: 'medianResponse',
      label: 'Typical reply time',
      display: enoughResponses && typical !== null ? days(typical) : null,
      value: enoughResponses ? typical : null,
      enough: enoughResponses,
      sentence:
        enoughResponses && typical !== null
          ? `Half of all applications get a first answer within ${days(typical)}.`
          : notYet,
      improve: 'Move every application on - shortlist, reject or schedule - within a few days of it arriving.',
    },
    {
      key: 'answeredOnTime',
      label: `Answered within ${ANSWER_WITHIN_DAYS} days`,
      display: enoughDue ? `${pct(onTime.length, due.length)}%` : null,
      value: enoughDue ? pct(onTime.length, due.length) : null,
      enough: enoughDue,
      sentence: enoughDue
        ? `${pct(onTime.length, due.length)}% of applications were answered within ${ANSWER_WITHIN_DAYS} days.`
        : notYet,
      improve: `Answer each application within ${ANSWER_WITHIN_DAYS} days, even if the answer is "not this time".`,
    },
    {
      key: 'offerHonour',
      label: 'Offers honoured',
      display: honour.enough && honour.rate !== null ? `${honour.rate}%` : null,
      value: honour.enough ? honour.rate : null,
      enough: honour.enough,
      sentence:
        honour.enough && honour.rate !== null
          ? honour.revoked === 0
            ? `Every one of ${honour.decided} accepted offers ended with the student joining.`
            : `${honour.rate}% of accepted offers ended with the student joining; ${honour.revoked} ${honour.revoked === 1 ? 'was' : 'were'} withdrawn.`
          : notYet,
      improve: 'Keep the offers you make, and give a joining date early - a withdrawn offer weighs heaviest of all.',
    },
    {
      key: 'processRating',
      label: 'How students rate the process',
      display: rating.enough && rating.overall !== null ? `${rating.overall} / 5` : null,
      value: rating.enough ? rating.overall : null,
      enough: rating.enough,
      sentence:
        rating.enough && rating.overall !== null
          ? `${rating.count} students rated communication ${rating.communication}, clarity ${rating.clarity} and fairness ${rating.fairness} out of 5.`
          : rating.count > 0
            ? `Shown once ${MIN_RATINGS} students have rated it, so no one student can be picked out.`
            : notYet,
      improve: 'Tell candidates what each round involves, when they will hear back, and why they did not move on.',
    },
    {
      key: 'payTransparency',
      label: 'States fixed pay',
      display: enoughJobs ? `${pct(statesFixed, published)}%` : null,
      value: enoughJobs ? pct(statesFixed, published) : null,
      enough: enoughJobs,
      sentence: enoughJobs
        ? `${pct(statesFixed, published)}% of their roles say what the fixed part of the pay is.`
        : notYet,
      improve: 'State the fixed pay on every role, not only the headline CTC.',
    },
    {
      key: 'bondUsage',
      label: 'Roles with a bond',
      display: enoughJobs ? `${pct(withBond, published)}%` : null,
      value: enoughJobs ? pct(withBond, published) : null,
      enough: enoughJobs,
      sentence: enoughJobs
        ? withBond === 0
          ? 'None of their roles ask for a service bond.'
          : `${pct(withBond, published)}% of their roles come with a service bond.`
        : notYet,
      improve: 'Avoid service bonds where you can; students weigh them heavily.',
    },
    {
      key: 'since',
      label: 'On the platform since',
      display: company.createdAt.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
      value: company.createdAt.getTime(),
      enough: true,
      sentence: `Joined the platform in ${company.createdAt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}.`,
      improve: null,
    },
  ];
}
