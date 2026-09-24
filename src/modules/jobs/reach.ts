import { Prisma, PostingStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { GENDER_VALUES } from './inclusion.js';

/**
 * How many students this role would actually reach.
 *
 * The visibility query answers "which roles can this student see". This is the
 * same question from the other end - "which students can see this role" - and
 * it exists because writing criteria was otherwise done blind. A recruiter
 * typing 8.0 into a CGPA box has no idea whether that leaves twelve students
 * or twelve hundred, and the first time anybody finds out is when nobody
 * applies.
 *
 * It also catches the quieter failure: a criterion nobody on the portal has
 * data for. "No live backlogs" reads as reasonable and matches nobody at all
 * if no college has recorded live backlogs yet. A count of zero says so while
 * there is still time to change it.
 */

export interface Reach {
  /** Students in the targeted drives, before any criteria are applied. */
  inScope: number;
  /** Of those, how many clear every stated criterion. */
  eligible: number;
  /** Of those, how many the college has actually verified. */
  verified: number;
  /** Whether any drive has been targeted at all. */
  targeted: number;
  /**
   * Which single criterion is cutting the most people, where one clearly is.
   * Named so it can be reconsidered rather than merely regretted.
   */
  narrowest: { field: string; label: string; cut: number } | null;
}

type JobCriteria = Prisma.JobGetPayload<{
  include: { courses: true; specialisations: true; gradYears: true };
}>;

const num = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

/** One bar a role may state in more than one way; clearing either clears it. */
function eitherBar(
  bars: { field: 'cgpa' | 'degreePct' | 'twelfthPct' | 'diplomaPct'; min: number | null }[],
): Prisma.CandidateWhereInput | null {
  const stated = bars.filter((b) => b.min !== null);
  if (stated.length === 0) return null;

  return {
    OR: stated.map((b) => ({ [b.field]: { gte: b.min as number } }) as Prisma.CandidateWhereInput),
  };
}

/** Everything the job asks of a student, as one where-clause. */
function criteriaOf(job: JobCriteria): Prisma.CandidateWhereInput[] {
  const all: Prisma.CandidateWhereInput[] = [];

  const aggregate = eitherBar([
    { field: 'cgpa', min: num(job.minCgpa) },
    { field: 'degreePct', min: num(job.minDegreePct) },
  ]);
  if (aggregate) all.push(aggregate);

  const afterTenth = eitherBar([
    { field: 'twelfthPct', min: num(job.minTwelfthPct) },
    { field: 'diplomaPct', min: num(job.minDiplomaPct) },
  ]);
  if (afterTenth) all.push(afterTenth);

  if (job.minTenthPct !== null) all.push({ tenthPct: { gte: Number(job.minTenthPct) } });
  if (job.minPgCgpa !== null || job.minPgPct !== null) {
    all.push({
      OR: [
        ...(job.minPgCgpa !== null ? [{ pgCgpa: { gte: Number(job.minPgCgpa) } }] : []),
        ...(job.minPgPct !== null ? [{ pgPct: { gte: Number(job.minPgPct) } }] : []),
      ] as Prisma.CandidateWhereInput[],
    });
  }

  if (job.maxBacklogs !== null) all.push({ backlogs: { lte: job.maxBacklogs } });
  if (job.maxActiveBacklogs !== null) {
    all.push({ activeBacklogs: { lte: job.maxActiveBacklogs } });
  }
  if (job.maxGapYears !== null) all.push({ gapYears: { lte: job.maxGapYears } });
  if (!job.allowsLateralEntry) all.push({ isLateralEntry: false });
  if (job.genderEligibility === 'WOMEN' || job.genderEligibility === 'MEN') {
    all.push({ gender: { in: GENDER_VALUES[job.genderEligibility] } });
  }

  if (job.courses.length > 0) {
    all.push({ course: { in: job.courses.map((c) => c.course) } });
  }
  if (job.specialisations.length > 0) {
    all.push({ specialisation: { in: job.specialisations.map((s) => s.specialisation) } });
  }
  if (job.gradYears.length > 0) {
    all.push({ graduationYear: { in: job.gradYears.map((g) => g.year) } });
  }

  return all;
}

/** Each criterion with a name a person would recognise, for the worst offender. */
const LABELS: Record<string, string> = {
  minCgpa: 'the CGPA bar',
  minDegreePct: 'the percentage bar',
  minTenthPct: 'the 10th % bar',
  minTwelfthPct: 'the 12th % bar',
  minPgCgpa: 'the post-graduation bar',
  maxBacklogs: 'the total backlogs limit',
  maxActiveBacklogs: 'the live backlogs limit',
  maxGapYears: 'the gap years limit',
  courses: 'the courses chosen',
  specialisations: 'the branches chosen',
  gradYears: 'the graduating years chosen',
  gender: 'the gender restriction',
};

export async function reachOf(jobId: string): Promise<Reach> {
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { courses: true, specialisations: true, gradYears: true },
  });

  /*
   * Only students the role can actually get to: in a batch, in a drive this
   * role was aimed at, and inside whatever batch narrowing that posting has.
   * A count over the whole portal would be a bigger and far less useful
   * number - it is not who could apply, it is who exists.
   */
  const postings = await prisma.jobPosting.findMany({
    where: { jobId, status: { not: PostingStatus.DECLINED } },
    select: { placementId: true, batches: { select: { batchId: true } } },
  });

  if (postings.length === 0) {
    return { inScope: 0, eligible: 0, verified: 0, targeted: 0, narrowest: null };
  }

  const batchScope: Prisma.BatchMembershipWhereInput = {
    OR: postings.map((p) =>
      p.batches.length > 0
        ? { batchId: { in: p.batches.map((b) => b.batchId) } }
        : { batch: { placements: { some: { id: p.placementId } } } },
    ),
  };

  const inScopeWhere: Prisma.CandidateWhereInput = {
    batchMemberships: { some: batchScope },
  };

  const criteria = criteriaOf(job);

  const [inScope, eligible, verified] = await Promise.all([
    prisma.candidate.count({ where: inScopeWhere }),
    prisma.candidate.count({ where: { AND: [inScopeWhere, ...criteria] } }),
    prisma.candidate.count({
      where: {
        AND: [
          { batchMemberships: { some: { ...batchScope, isFrozen: true } } },
          ...criteria,
        ],
      },
    }),
  ]);

  /*
   * Which one criterion is doing the most damage, found by removing each in
   * turn. Only worth saying when something is actually being cut - and worth
   * saying loudly then, because the usual cause is a bar set against data
   * nobody has recorded.
   */
  let narrowest: Reach['narrowest'] = null;

  if (inScope > eligible) {
    const named: { field: string; where: Prisma.CandidateWhereInput }[] = [];

    if (job.minCgpa !== null || job.minDegreePct !== null) {
      named.push({ field: 'minCgpa', where: criteria[0]! });
    }
    if (job.maxActiveBacklogs !== null) {
      named.push({
        field: 'maxActiveBacklogs',
        where: { activeBacklogs: { lte: job.maxActiveBacklogs } },
      });
    }
    if (job.maxGapYears !== null) {
      named.push({ field: 'maxGapYears', where: { gapYears: { lte: job.maxGapYears } } });
    }
    if (job.genderEligibility === 'WOMEN' || job.genderEligibility === 'MEN') {
      named.push({ field: 'gender', where: { gender: { in: GENDER_VALUES[job.genderEligibility] } } });
    }
    if (job.courses.length > 0) {
      named.push({
        field: 'courses',
        where: { course: { in: job.courses.map((c) => c.course) } },
      });
    }
    if (job.specialisations.length > 0) {
      named.push({
        field: 'specialisations',
        where: { specialisation: { in: job.specialisations.map((s) => s.specialisation) } },
      });
    }

    const counted = await Promise.all(
      named.map((n) => prisma.candidate.count({ where: { AND: [inScopeWhere, n.where] } })),
    );

    let worst = -1;
    named.forEach((n, i) => {
      const cut = inScope - counted[i]!;
      if (cut > 0 && cut > (worst === -1 ? 0 : inScope - counted[worst]!)) worst = i;
    });

    if (worst >= 0) {
      narrowest = {
        field: named[worst]!.field,
        label: LABELS[named[worst]!.field] ?? named[worst]!.field,
        cut: inScope - counted[worst]!,
      };
    }
  }

  return { inScope, eligible, verified, targeted: postings.length, narrowest };
}
