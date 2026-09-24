import { ApplicationStatus as S, PlacementType, PostingStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';

/**
 * Placement statistics, in the shapes NAAC, NIRF and NBA ask for.
 *
 * Everything here is counted from what happened on the portal - rosters,
 * drives, applications and offers - and nothing is estimated. What the portal
 * cannot know (who went on to higher studies, the sanctioned intake) is
 * returned as a note saying so, never as a number, because a report filed
 * with an accreditation body has to be defensible line by line.
 *
 * The numbers are anonymous aggregates: no student is named anywhere in a
 * report. That is why the `placement_statistics` consent purpose does not
 * filter them - it governs whether a student is identifiable, and here nobody
 * is. The consent centre says as much to the student.
 */

/** The statuses that mean a student took an offer and it stood. */
const PLACED: S[] = [S.ACCEPTED, S.HIRED];
/** Statuses that can only be reached through an offer. */
const OFFER_REACHED: S[] = [S.OFFERED, S.ACCEPTED, S.DECLINED, S.HIRED];

export const NOT_TRACKED = [
  'Students who went on to higher studies - NIRF asks for this; the portal does not record it.',
  'Students who started their own business (entrepreneurship).',
  'Sanctioned or first-year intake - take this from the admissions office.',
  'Offers a student found off campus, outside the portal.',
];

export const CONSENT_NOTE =
  'Anonymous totals only - no student is named, so every student in the pool is counted regardless of their "placement statistics" consent.';

/** Where the numbers come from: one college, or every college of a tenant. */
export type Scope = { kind: 'college'; collegeId: string } | { kind: 'tenant'; tenantId: string };

export interface ReportFilter {
  /** The passing year whose students make up the pool. */
  year?: number;
  /** Or a single drive: its batches make up the pool. */
  placementId?: string;
}

export interface SalaryStats {
  count: number;
  highest: number | null;
  median: number | null;
  average: number | null;
}

/** How the salary figures were read - so a reader knows what "salary" means. */
export interface SalaryBasis {
  /** Offers whose fixed annual CTC was stated. */
  fromFixed: number;
  /** Offers with no fixed figure, where the bottom of the advertised range was used. */
  fromRangeMin: number;
  /** Offers with no pay stated at all - left out of the salary figures. */
  missing: number;
}

export interface Outcome {
  /** Students in the pool with at least one application of this type. */
  applied: number;
  /** Students who accepted an offer that stood. */
  placed: number;
  /** placed / pool, as a percentage with one decimal. Null when the pool is empty. */
  placedPct: number | null;
  offersMade: number;
  offersAccepted: number;
  /** Distinct companies with a role accepted into a drive of this type. */
  recruiters: number;
  /** Final placements: annual CTC in rupees. Internships: monthly stipend in rupees. */
  pay: SalaryStats;
  payBasis: SalaryBasis;
  payUnit: 'annual CTC' | 'monthly stipend';
}

export interface BranchRow {
  course: string | null;
  branch: string | null;
  pool: number;
  placed: number;
  placedPct: number | null;
  medianCtc: number | null;
  highestCtc: number | null;
}

export interface CompanyRow {
  company: string;
  offers: number;
  accepted: number;
  medianCtc: number | null;
  highestCtc: number | null;
}

export interface CollegeRow {
  collegeId: string | null;
  college: string;
  code: string | null;
  pool: number;
  placed: number;
  placedPct: number | null;
  medianCtc: number | null;
  recruiters: number;
}

export interface PlacementReport {
  scope: { kind: Scope['kind']; name: string };
  filter: { year: number | null; placement: { id: string; name: string; type: PlacementType } | null };
  /** The choices a picker can offer. */
  years: number[];
  drives: { id: string; name: string; year: number; type: PlacementType; college: string }[];
  pool: number;
  final: Outcome;
  internship: Outcome;
  byBranch: BranchRow[];
  byCompany: CompanyRow[];
  /** Tenant scope only: one row per college. */
  byCollege: CollegeRow[];
  notTracked: string[];
  consentNote: string;
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Arithmetic                                                                  */
/* -------------------------------------------------------------------------- */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stats(values: number[]): SalaryStats {
  if (values.length === 0) return { count: 0, highest: null, median: null, average: null };
  return {
    count: values.length,
    highest: Math.max(...values),
    median: median(values),
    average: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

function collegeWhere(scope: Scope): Prisma.CollegeWhereInput {
  return scope.kind === 'college' ? { id: scope.collegeId } : { tenantId: scope.tenantId };
}

/** Students who belong to the scope - by their college, or a batch in it. */
function candidateInScope(scope: Scope): Prisma.CandidateWhereInput {
  if (scope.kind === 'college') {
    return {
      OR: [
        { collegeId: scope.collegeId },
        { batchMemberships: { some: { batch: { collegeId: scope.collegeId } } } },
      ],
    };
  }
  return {
    OR: [
      { college: { tenantId: scope.tenantId } },
      { batchMemberships: { some: { batch: { tenantId: scope.tenantId } } } },
    ],
  };
}

async function scopeName(scope: Scope): Promise<string> {
  if (scope.kind === 'college') {
    const c = await prisma.college.findUnique({ where: { id: scope.collegeId }, select: { name: true } });
    return c?.name ?? 'College';
  }
  const t = await prisma.tenant.findUnique({ where: { id: scope.tenantId }, select: { name: true } });
  return t?.name ?? 'Institution';
}

/** The years and drives a picker can offer, newest first. */
async function choices(scope: Scope) {
  const [years, drives] = await Promise.all([
    prisma.candidate.findMany({
      where: { ...candidateInScope(scope), graduationYear: { not: null } },
      distinct: ['graduationYear'],
      select: { graduationYear: true },
    }),
    prisma.placement.findMany({
      where: { college: collegeWhere(scope) },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, name: true, year: true, type: true, college: { select: { name: true } } },
    }),
  ]);
  const set = new Set<number>(years.map((y) => y.graduationYear!).filter(Boolean));
  drives.forEach((d) => set.add(d.year));
  return {
    years: [...set].sort((a, b) => b - a),
    drives: drives.map((d) => ({ id: d.id, name: d.name, year: d.year, type: d.type, college: d.college.name })),
  };
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

export async function placementReport(scope: Scope, filter: ReportFilter): Promise<PlacementReport> {
  const [name, picker] = await Promise.all([scopeName(scope), choices(scope)]);

  // A drive, when one was asked for - and only one of this scope's drives.
  const drive = filter.placementId
    ? await prisma.placement.findFirst({
        where: { id: filter.placementId, college: collegeWhere(scope) },
        select: { id: true, name: true, type: true, year: true, batches: { select: { id: true } } },
      })
    : null;
  if (filter.placementId && !drive) throw notFound('That drive is not part of this report.');

  // With neither a year nor a drive, the latest year there is.
  const year = drive ? null : (filter.year ?? picker.years[0] ?? new Date().getFullYear());

  /* --- the pool: who the percentages are out of --------------------------- */
  const poolWhere: Prisma.CandidateWhereInput = drive
    ? { batchMemberships: { some: { batchId: { in: drive.batches.map((b) => b.id) } } } }
    : {
        AND: [
          candidateInScope(scope),
          {
            OR: [
              { graduationYear: year },
              // A student whose own record has no year counts by their batch's.
              { graduationYear: null, batchMemberships: { some: { batch: { graduationYear: year } } } },
            ],
          },
        ],
      };

  const candidates = await prisma.candidate.findMany({
    where: poolWhere,
    select: {
      id: true,
      course: true,
      specialisation: true,
      collegeId: true,
      college: { select: { id: true, name: true, code: true } },
      batchMemberships: {
        select: {
          batch: {
            select: {
              course: true,
              specialisation: true,
              college: { select: { id: true, name: true, code: true } },
            },
          },
        },
        take: 1,
      },
    },
  });
  const poolIds = candidates.map((c) => c.id);

  /* --- their applications, in this scope's drives -------------------------- */
  const applications = poolIds.length
    ? await prisma.application.findMany({
        where: {
          candidateId: { in: poolIds },
          placement: drive ? { id: drive.id } : { college: collegeWhere(scope) },
        },
        select: {
          id: true,
          candidateId: true,
          status: true,
          placement: { select: { type: true } },
          job: {
            select: {
              ctcFixed: true,
              ctcMin: true,
              stipendPerMonth: true,
              company: { select: { id: true, name: true } },
            },
          },
          events: { where: { toStatus: S.OFFERED }, select: { id: true }, take: 1 },
        },
      })
    : [];

  /* --- recruiters: companies whose role a drive here accepted --------------- */
  const postings = await prisma.jobPosting.findMany({
    where: {
      status: PostingStatus.ACCEPTED,
      placement: drive ? { id: drive.id } : { college: collegeWhere(scope), ...(year ? { year } : {}) },
    },
    select: { placement: { select: { type: true, collegeId: true } }, job: { select: { companyId: true } } },
  });

  const outcome = (type: PlacementType): Outcome => {
    const apps = applications.filter((a) => a.placement.type === type);
    const applied = new Set(apps.map((a) => a.candidateId));
    const offers = apps.filter((a) => OFFER_REACHED.includes(a.status) || a.events.length > 0);
    const accepted = apps.filter((a) => PLACED.includes(a.status));
    const placed = new Set(accepted.map((a) => a.candidateId));

    // One figure per placed student - their best accepted offer - because
    // NIRF's median is of placed students, not of offers.
    const basis: SalaryBasis = { fromFixed: 0, fromRangeMin: 0, missing: 0 };
    const best = new Map<string, number>();
    for (const a of accepted) {
      let value: number | null;
      if (type === PlacementType.INTERNSHIP) {
        value = num(a.job.stipendPerMonth);
        if (value === null) basis.missing++;
        else basis.fromFixed++;
      } else {
        const fixed = num(a.job.ctcFixed);
        const min = num(a.job.ctcMin);
        value = fixed ?? min;
        if (fixed !== null) basis.fromFixed++;
        else if (min !== null) basis.fromRangeMin++;
        else basis.missing++;
      }
      if (value !== null) best.set(a.candidateId, Math.max(best.get(a.candidateId) ?? 0, value));
    }

    const recruiters = new Set(postings.filter((p) => p.placement.type === type).map((p) => p.job.companyId));

    return {
      applied: applied.size,
      placed: placed.size,
      placedPct: pct(placed.size, candidates.length),
      offersMade: offers.length,
      offersAccepted: accepted.length,
      recruiters: recruiters.size,
      pay: stats([...best.values()]),
      payBasis: basis,
      payUnit: type === PlacementType.INTERNSHIP ? 'monthly stipend' : 'annual CTC',
    };
  };

  // The breakdowns are of final placements - what NBA and NAAC ask about.
  const finalAccepted = applications.filter((a) => a.placement.type === PlacementType.FINAL && PLACED.includes(a.status));
  const ctcOf = (a: (typeof applications)[number]) => num(a.job.ctcFixed) ?? num(a.job.ctcMin);

  /* --- by course and branch ------------------------------------------------- */
  const branchKey = (c: (typeof candidates)[number]) => {
    const b = c.batchMemberships[0]?.batch;
    return { course: c.course ?? b?.course ?? null, branch: c.specialisation ?? b?.specialisation ?? null };
  };
  const branches = new Map<string, { course: string | null; branch: string | null; ids: Set<string> }>();
  for (const c of candidates) {
    const k = branchKey(c);
    const key = `${k.course ?? ''}|${k.branch ?? ''}`;
    if (!branches.has(key)) branches.set(key, { ...k, ids: new Set() });
    branches.get(key)!.ids.add(c.id);
  }
  const byBranch: BranchRow[] = [...branches.values()]
    .map((b) => {
      const acc = finalAccepted.filter((a) => b.ids.has(a.candidateId));
      const placedIds = new Set(acc.map((a) => a.candidateId));
      const pay = bestPerStudent(acc, ctcOf);
      return {
        course: b.course,
        branch: b.branch,
        pool: b.ids.size,
        placed: placedIds.size,
        placedPct: pct(placedIds.size, b.ids.size),
        medianCtc: median(pay),
        highestCtc: pay.length ? Math.max(...pay) : null,
      };
    })
    .sort((a, b) => (a.course ?? '').localeCompare(b.course ?? '') || (a.branch ?? '').localeCompare(b.branch ?? ''));

  /* --- by company ------------------------------------------------------------ */
  const companies = new Map<string, { company: string; offers: number; accepted: number; ctc: number[] }>();
  for (const a of applications.filter((x) => x.placement.type === PlacementType.FINAL)) {
    const offered = OFFER_REACHED.includes(a.status) || a.events.length > 0;
    const took = PLACED.includes(a.status);
    if (!offered && !took) continue;
    const key = a.job.company.id;
    if (!companies.has(key)) companies.set(key, { company: a.job.company.name, offers: 0, accepted: 0, ctc: [] });
    const row = companies.get(key)!;
    row.offers++;
    if (took) {
      row.accepted++;
      const v = ctcOf(a);
      if (v !== null) row.ctc.push(v);
    }
  }
  const byCompany: CompanyRow[] = [...companies.values()]
    .map((c) => ({
      company: c.company,
      offers: c.offers,
      accepted: c.accepted,
      medianCtc: median(c.ctc),
      highestCtc: c.ctc.length ? Math.max(...c.ctc) : null,
    }))
    .sort((a, b) => b.accepted - a.accepted || b.offers - a.offers || a.company.localeCompare(b.company));

  /* --- by college (tenant only) ---------------------------------------------- */
  let byCollege: CollegeRow[] = [];
  if (scope.kind === 'tenant') {
    const cols = new Map<string, { id: string | null; name: string; code: string | null; ids: Set<string> }>();
    for (const c of candidates) {
      const col = c.college ?? c.batchMemberships[0]?.batch.college ?? null;
      const key = col?.id ?? '';
      if (!cols.has(key)) {
        cols.set(key, { id: col?.id ?? null, name: col?.name ?? 'University-wide batches', code: col?.code ?? null, ids: new Set() });
      }
      cols.get(key)!.ids.add(c.id);
    }
    byCollege = [...cols.values()]
      .map((c) => {
        const acc = finalAccepted.filter((a) => c.ids.has(a.candidateId));
        const placedIds = new Set(acc.map((a) => a.candidateId));
        const recruiters = new Set(
          postings
            .filter((p) => p.placement.type === PlacementType.FINAL && p.placement.collegeId === c.id)
            .map((p) => p.job.companyId),
        );
        return {
          collegeId: c.id,
          college: c.name,
          code: c.code,
          pool: c.ids.size,
          placed: placedIds.size,
          placedPct: pct(placedIds.size, c.ids.size),
          medianCtc: median(bestPerStudent(acc, ctcOf)),
          recruiters: recruiters.size,
        };
      })
      .sort((a, b) => a.college.localeCompare(b.college));
  }

  return {
    scope: { kind: scope.kind, name },
    filter: {
      year,
      placement: drive ? { id: drive.id, name: drive.name, type: drive.type } : null,
    },
    years: picker.years,
    drives: picker.drives,
    pool: candidates.length,
    final: outcome(PlacementType.FINAL),
    internship: outcome(PlacementType.INTERNSHIP),
    byBranch,
    byCompany,
    byCollege,
    notTracked: NOT_TRACKED,
    consentNote: CONSENT_NOTE,
    generatedAt: new Date().toISOString(),
  };
}

/** Each placed student's best offer, once. */
function bestPerStudent<T extends { candidateId: string }>(apps: T[], valueOf: (a: T) => number | null): number[] {
  const best = new Map<string, number>();
  for (const a of apps) {
    const v = valueOf(a);
    if (v !== null) best.set(a.candidateId, Math.max(best.get(a.candidateId) ?? 0, v));
  }
  return [...best.values()];
}
