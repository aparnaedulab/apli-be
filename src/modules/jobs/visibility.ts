import { ApplicationStatus, JobStatus, Prisma, PostingStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { GENDER_VALUES } from './inclusion.js';

/**
 * Everything about one student that affects what they can see or do.
 * Loaded once, then reused, so the visibility query stays a single statement.
 */
export interface CandidateContext {
  candidateId: string;
  /** Drives this student sits in, via their batch. */
  placementIds: string[];
  /** The batch itself, for a posting aimed at only some of a drive. */
  batchId: string | null;
  /** Drives they are already placed in and whose one-offer rule applies. */
  closedPlacementIds: string[];
  course: string | null;
  specialisation: string | null;
  graduationYear: number | null;
  cgpa: number | null;
  /// Some universities award a percentage instead of a CGPA, or as well as.
  degreePct: number | null;
  tenthPct: number | null;
  twelfthPct: number | null;
  /// What a lateral entrant has where a 12th standard result would be.
  diplomaPct: number | null;
  /// The master's, for somebody already holding a degree.
  pgCgpa: number | null;
  pgPct: number | null;
  backlogs: number | null;
  activeBacklogs: number | null;
  gapYears: number | null;
  isLateralEntry: boolean;
  isFrozen: boolean;
  /** As the college recorded it. Read only by a role open to one gender. */
  gender: string | null;
}

/** Which one-gender roles a recorded gender can see. */
function genderGroupOf(gender: string | null): 'WOMEN' | 'MEN' | null {
  const g = gender?.trim().toLowerCase();
  if (!g) return null;
  if (GENDER_VALUES.WOMEN.some((v) => v.toLowerCase() === g)) return 'WOMEN';
  if (GENDER_VALUES.MEN.some((v) => v.toLowerCase() === g)) return 'MEN';
  return null;
}

const num = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

export async function loadCandidateContext(candidateId: string): Promise<CandidateContext> {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      batchMemberships: {
        include: { batch: { include: { placements: { select: { id: true, oneOfferRule: true } } } } },
      },
    },
  });
  if (!candidate) throw notFound('Profile not found.');

  const membership = candidate.batchMemberships[0] ?? null;
  const placements = membership?.batch.placements ?? [];

  // Where has this student already accepted or started an offer?
  const settled = await prisma.application.findMany({
    where: {
      candidateId,
      status: { in: [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
    },
    select: { placementId: true },
  });
  const settledIn = new Set(settled.map((a) => a.placementId));

  return {
    candidateId,
    placementIds: placements.map((p) => p.id),
    batchId: membership?.batchId ?? null,
    closedPlacementIds: placements.filter((p) => p.oneOfferRule && settledIn.has(p.id)).map((p) => p.id),
    // The student's own record first, the batch only as a fallback for rows
    // entered before a student carried their own course. A batch may be
    // "Second year", which says nothing about what anyone is studying.
    course: candidate.course ?? membership?.batch.course ?? null,
    specialisation: candidate.specialisation ?? membership?.batch.specialisation ?? null,
    graduationYear:
      candidate.graduationYear ?? membership?.batch.graduationYear ?? null,
    cgpa: num(candidate.cgpa),
    degreePct: num(candidate.degreePct),
    tenthPct: num(candidate.tenthPct),
    twelfthPct: num(candidate.twelfthPct),
    diplomaPct: num(candidate.diplomaPct),
    pgCgpa: num(candidate.pgCgpa),
    pgPct: num(candidate.pgPct),
    backlogs: candidate.backlogs,
    activeBacklogs: candidate.activeBacklogs,
    gapYears: candidate.gapYears,
    isLateralEntry: candidate.isLateralEntry,
    isFrozen: membership?.isFrozen ?? false,
    gender: candidate.gender,
  };
}

/**
 * The one query that decides what a student sees. Six conditions, all of them
 * here and nowhere else:
 *
 *   1. the company published it
 *   2. the deadline has not passed
 *   3. their college accepted the posting
 *   4. their batch sits in that drive, and the posting was aimed at it
 *   5. they meet every stated criterion - marks, backlogs, gap years, course,
 *      branch, graduating year, and whether lateral entrants are taken
 *   6. they are not already placed in that drive
 *
 * A missing number on the student's side fails any criterion that needs it -
 * "no CGPA on record" is not the same as "meets a 7.5 requirement".
 */
export function visibleJobWhere(ctx: CandidateContext): Prisma.JobWhereInput {
  const open = ctx.placementIds.filter((id) => !ctx.closedPlacementIds.includes(id));

  const atLeast = (
    field: 'minCgpa' | 'minTenthPct' | 'minTwelfthPct',
    value: number | null,
  ): Prisma.JobWhereInput =>
    value === null
      ? { [field]: null }
      : { OR: [{ [field]: null }, { [field]: { lte: value } }] };

  /**
   * One requirement a role may state in more than one way.
   *
   * "7.0 CGPA or 70%" is a single bar written twice, and "60% in 12th or in
   * your diploma" is another. A student clears it by satisfying any one of
   * the stated bars they actually have a number for - because the conversion
   * between a CGPA and a percentage differs by university, so the only honest
   * thing is to check whichever the college recorded rather than derive one.
   *
   * A role stating none of them is open to everybody. A student holding none
   * of the numbers fails, which is the same rule as everywhere else here:
   * nothing on record is not the same as meeting the bar.
   */
  const eitherOf = (
    bars: {
      field:
        | 'minCgpa'
        | 'minDegreePct'
        | 'minTwelfthPct'
        | 'minDiplomaPct'
        | 'minPgCgpa'
        | 'minPgPct';
      value: number | null;
    }[],
  ): Prisma.JobWhereInput => {
    const unstated = bars.map((b) => ({ [b.field]: null }) as Prisma.JobWhereInput);
    const cleared = bars
      .filter((b) => b.value !== null)
      .map((b) => ({ [b.field]: { lte: b.value } }) as Prisma.JobWhereInput);

    return { OR: [{ AND: unstated }, ...cleared] };
  };

  /** A ceiling the student must sit under: backlogs, gap years. */
  const atMost = (
    field: 'maxBacklogs' | 'maxActiveBacklogs' | 'maxGapYears',
    value: number | null,
  ): Prisma.JobWhereInput =>
    value === null
      ? { [field]: null }
      : { OR: [{ [field]: null }, { [field]: { gte: value } }] };

  /**
   * A list criterion: no rows at all means "open to everybody".
   *
   * MySQL has no array columns, so these live in join tables - which is the
   * better shape anyway, because the database does the filtering instead of
   * every job being pulled back and sifted in application code.
   */
  const inList = <T extends 'courses' | 'specialisations'>(
    relation: T,
    field: T extends 'courses' ? 'course' : 'specialisation',
    value: string | null,
  ): Prisma.JobWhereInput =>
    value
      ? {
          OR: [
            { [relation]: { none: {} } },
            { [relation]: { some: { [field]: value } } },
          ] as Prisma.JobWhereInput[],
        }
      : ({ [relation]: { none: {} } } as Prisma.JobWhereInput);

  return {
    status: JobStatus.PUBLISHED,
    deadline: { gte: new Date() },
    postings: {
      some: {
        status: PostingStatus.ACCEPTED,
        placementId: { in: open },
        /*
         * A posting may be aimed at only some batches in the drive. No rows
         * means the whole of it, the same convention the eligibility lists
         * use - so a role that never thought about batches reaches everybody.
         */
        ...(ctx.batchId
          ? {
              OR: [
                { batches: { none: {} } },
                { batches: { some: { batchId: ctx.batchId } } },
              ],
            }
          : { batches: { none: {} } }),
      },
    },
    AND: [
      // The aggregate, in whichever unit the college records.
      eitherOf([
        { field: 'minCgpa', value: ctx.cgpa },
        { field: 'minDegreePct', value: ctx.degreePct },
      ]),

      atLeast('minTenthPct', ctx.tenthPct),

      // After the 10th, a student either did a 12th or a diploma. Checking
      // only the 12th is what quietly excluded every lateral entrant.
      eitherOf([
        { field: 'minTwelfthPct', value: ctx.twelfthPct },
        { field: 'minDiplomaPct', value: ctx.diplomaPct },
      ]),

      // The master's, where a role asks for one. A role that does not is open
      // to everybody on this count, including students on a first degree.
      eitherOf([
        { field: 'minPgCgpa', value: ctx.pgCgpa },
        { field: 'minPgPct', value: ctx.pgPct },
      ]),

      // Backlogs are two separate criteria stated in one breath: "no live
      // backlogs, at most two cleared". A college that records only one of
      // them leaves the other null, which fails whichever needs it.
      atMost('maxBacklogs', ctx.backlogs),
      atMost('maxActiveBacklogs', ctx.activeBacklogs),
      atMost('maxGapYears', ctx.gapYears),

      inList('courses', 'course', ctx.course),
      inList('specialisations', 'specialisation', ctx.specialisation),

      // A role that excludes lateral entrants hides from them; one that does
      // not is invisible to nobody on that count.
      ctx.isLateralEntry ? { allowsLateralEntry: true } : {},

      // A one-gender role is seen only by that gender. A preference, or no
      // restriction, hides from nobody.
      { genderEligibility: { notIn: (['WOMEN', 'MEN'] as const).filter((g) => g !== genderGroupOf(ctx.gender)) } },

      ctx.graduationYear
        ? {
            OR: [
              { gradYears: { none: {} } },
              { gradYears: { some: { year: ctx.graduationYear } } },
            ],
          }
        : { gradYears: { none: {} } },
    ],
  };
}

/**
 * Which drive an application belongs to: the accepted posting whose drive this
 * student actually sits in. Denormalising it onto the Application is what makes
 * the one-offer cascade a single indexed query later.
 */
export async function resolvePlacementFor(jobId: string, ctx: CandidateContext): Promise<string> {
  const posting = await prisma.jobPosting.findFirst({
    where: {
      jobId,
      status: PostingStatus.ACCEPTED,
      placementId: { in: ctx.placementIds },
      // The same narrowing the list applied, so a role that is not aimed at
      // this student's batch cannot be reached by applying to it directly.
      ...(ctx.batchId
        ? { OR: [{ batches: { none: {} } }, { batches: { some: { batchId: ctx.batchId } } }] }
        : { batches: { none: {} } }),
    },
    select: { placementId: true },
  });

  if (!posting) {
    throw forbidden('This role is not open to you through any of your placement seasons.');
  }
  return posting.placementId;
}

/* -------------------------------------------------------------------------- */
/* Why a student cannot apply                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One reason a role is closed to a student, in words they can act on.
 *
 * `required` and `yours` are shown side by side ("7.0 CGPA - you have 6.8"),
 * and `fix` says what, if anything, would change it. A reason with no fix is
 * honest too: a role for Mechanical is not going to open to Civil.
 */
export interface IneligibilityReason {
  code:
    | 'NOT_VERIFIED'
    | 'ALREADY_PLACED'
    | 'OTHER_BATCHES'
    | 'AGGREGATE'
    | 'TENTH'
    | 'TWELFTH'
    | 'PG'
    | 'BACKLOGS'
    | 'ACTIVE_BACKLOGS'
    | 'GAP_YEARS'
    | 'COURSE'
    | 'BRANCH'
    | 'YEAR'
    | 'LATERAL'
    | 'GENDER';
  text: string;
  required?: string;
  yours?: string;
  fix?: string;
}

type Num = Prisma.Decimal | number | null;

/** The fields of a role the explanation reads. */
export interface ExplainableJob {
  minCgpa: Num;
  minDegreePct: Num;
  minTenthPct: Num;
  minTwelfthPct: Num;
  minDiplomaPct: Num;
  minPgCgpa: Num;
  minPgPct: Num;
  maxBacklogs: number | null;
  maxActiveBacklogs: number | null;
  maxGapYears: number | null;
  allowsLateralEntry: boolean;
  genderEligibility: string;
  courses: { course: string }[];
  specialisations: { specialisation: string }[];
  gradYears: { year: number }[];
  /** The accepted postings of this role into the student's drives. */
  postings: { placementId: string; placement: { name: string }; batches: { batchId: string }[] }[];
}

const toNum = (v: Num): number | null => (v === null ? null : Number(v));
const fmt = (v: number, unit: 'cgpa' | 'pct') =>
  unit === 'cgpa' ? `${Number(v.toFixed(2))} CGPA` : `${Number(v.toFixed(2))}%`;

const ASK_COLLEGE_MARKS = 'If your marks on record are wrong, ask your placement cell to correct them.';
const ASK_COLLEGE_MISSING = 'Your college has not recorded this yet. Ask your placement cell to add it.';

/**
 * Every reason this student cannot apply to this role - the same six
 * conditions visibleJobWhere applies, read one by one instead of all at once.
 *
 * Deliberately separate from the query rather than derived from it: the query
 * must stay a single SQL statement, and this must say which part failed. The
 * tests hold the two to the same rules.
 */
export function explainIneligibility(ctx: CandidateContext, job: ExplainableJob): IneligibilityReason[] {
  const out: IneligibilityReason[] = [];

  if (!ctx.isFrozen) {
    out.push({
      code: 'NOT_VERIFIED',
      text: 'Your college has not verified your record yet.',
      fix: 'Ask your placement cell to verify and lock your record. Nobody can apply until they do.',
    });
  }

  const mine = job.postings.filter((p) => ctx.placementIds.includes(p.placementId));
  const open = mine.filter((p) => !ctx.closedPlacementIds.includes(p.placementId));
  if (mine.length > 0 && open.length === 0) {
    out.push({
      code: 'ALREADY_PLACED',
      text: `You have accepted an offer in ${mine[0]!.placement.name}, which allows one offer per student.`,
    });
  } else if (
    open.length > 0 &&
    !open.some(
      (p) => p.batches.length === 0 || (ctx.batchId !== null && p.batches.some((b) => b.batchId === ctx.batchId)),
    )
  ) {
    out.push({ code: 'OTHER_BATCHES', text: 'This role is open only to certain other batches in the season.' });
  }

  /** A bar stated in one or two units, cleared by any unit the student has. */
  const either = (
    code: IneligibilityReason['code'],
    what: string,
    bars: { min: number | null; value: number | null; unit: 'cgpa' | 'pct' }[],
  ) => {
    const stated = bars.filter((b) => b.min !== null);
    if (stated.length === 0) return;
    if (stated.some((b) => b.value !== null && b.value >= b.min!)) return;
    const required = stated.map((b) => fmt(b.min!, b.unit)).join(' or ');
    const have = stated.filter((b) => b.value !== null);
    const yours = have.map((b) => fmt(b.value!, b.unit)).join(' / ');
    out.push({
      code,
      text: have.length
        ? `Needs ${required} in ${what}. You have ${yours}.`
        : `Needs ${required} in ${what}, and none is on your record.`,
      required,
      yours: have.length ? yours : 'not recorded',
      fix: have.length ? ASK_COLLEGE_MARKS : ASK_COLLEGE_MISSING,
    });
  };

  either('AGGREGATE', 'your degree', [
    { min: toNum(job.minCgpa), value: ctx.cgpa, unit: 'cgpa' },
    { min: toNum(job.minDegreePct), value: ctx.degreePct, unit: 'pct' },
  ]);
  either('TENTH', '10th', [{ min: toNum(job.minTenthPct), value: ctx.tenthPct, unit: 'pct' }]);
  either('TWELFTH', '12th or diploma', [
    { min: toNum(job.minTwelfthPct), value: ctx.twelfthPct, unit: 'pct' },
    { min: toNum(job.minDiplomaPct), value: ctx.diplomaPct, unit: 'pct' },
  ]);
  either('PG', 'your master’s', [
    { min: toNum(job.minPgCgpa), value: ctx.pgCgpa, unit: 'cgpa' },
    { min: toNum(job.minPgPct), value: ctx.pgPct, unit: 'pct' },
  ]);

  const ceiling = (code: IneligibilityReason['code'], max: number | null, value: number | null, noun: string) => {
    if (max === null) return;
    if (value !== null && value <= max) return;
    out.push({
      code,
      text:
        value === null
          ? `Allows at most ${max} ${noun}, and your record does not say how many you have.`
          : `Allows at most ${max} ${noun}. You have ${value}.`,
      required: `at most ${max}`,
      yours: value === null ? 'not recorded' : String(value),
      fix: value === null ? ASK_COLLEGE_MISSING : undefined,
    });
  };
  ceiling('BACKLOGS', job.maxBacklogs, ctx.backlogs, 'backlogs in total');
  ceiling('ACTIVE_BACKLOGS', job.maxActiveBacklogs, ctx.activeBacklogs, 'live backlogs');
  ceiling('GAP_YEARS', job.maxGapYears, ctx.gapYears, 'gap years');

  /** A list criterion: empty means open to everybody. */
  const inList = (code: IneligibilityReason['code'], list: string[], value: string | null, noun: string) => {
    if (list.length === 0) return;
    if (value && list.includes(value)) return;
    out.push({
      code,
      text: `Open to ${list.join(', ')} only.${value ? ` Your ${noun} is ${value}.` : ''}`,
      required: list.join(', '),
      yours: value ?? 'not recorded',
      fix: value ? undefined : ASK_COLLEGE_MISSING,
    });
  };
  inList('COURSE', job.courses.map((c) => c.course), ctx.course, 'course');
  inList('BRANCH', job.specialisations.map((s) => s.specialisation), ctx.specialisation, 'branch');
  inList(
    'YEAR',
    job.gradYears.map((g) => String(g.year)),
    ctx.graduationYear ? String(ctx.graduationYear) : null,
    'graduating year',
  );

  if (ctx.isLateralEntry && !job.allowsLateralEntry) {
    out.push({ code: 'LATERAL', text: 'This company is not taking students who joined through lateral entry.' });
  }

  if (job.genderEligibility === 'WOMEN' || job.genderEligibility === 'MEN') {
    const mine = genderGroupOf(ctx.gender);
    if (mine !== job.genderEligibility) {
      out.push({
        code: 'GENDER',
        text: `This role is open to ${job.genderEligibility === 'WOMEN' ? 'women' : 'men'} only.`,
        required: job.genderEligibility === 'WOMEN' ? 'women' : 'men',
        yours: ctx.gender ?? 'not recorded',
        fix: ctx.gender ? undefined : ASK_COLLEGE_MISSING,
      });
    }
  }

  return out;
}
