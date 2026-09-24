import { JobStatus, PostingStatus, type Job } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { needsApprovalMessage, unreachableTenants } from '../companyAccess/companyAccess.service.js';
import { canPublish } from '../company/verification.js';

/** Layer 3, as a query: a job id from another company simply does not match. */
export async function ownedJob(companyId: string, jobId: string): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, companyId } });
  if (!job) throw notFound('No such job.');
  return job;
}

/**
 * Everything that must be true before a job can go out to colleges. Collected
 * in one place and returned as a list, so the wizard can show the recruiter
 * exactly what is missing rather than failing on the first problem.
 */
export interface PublishCheck {
  ok: boolean;
  problems: string[];
}

export async function publishReadiness(jobId: string): Promise<PublishCheck> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      company: { select: { status: true } },
      rounds: { select: { id: true } },
      postings: { select: { id: true } },
    },
  });
  if (!job) throw notFound('No such job.');

  const problems: string[] = [];

  if (!canPublish(job.company.status)) {
    problems.push('Your company has not been verified yet, so it cannot publish roles.');
  }
  if (!job.title.trim()) problems.push('The role needs a title.');
  if (!job.description.trim()) problems.push('The role needs a description.');
  if (job.rounds.length === 0) problems.push('Add at least one hiring round.');
  if (job.postings.length === 0) problems.push('Target at least one placement season.');
  if (job.deadline.getTime() <= Date.now()) problems.push('The deadline is in the past.');

  /*
   * Not required to save a draft, but a role that reaches students without
   * them is a role every placement cell has to chase the company about.
   */
  if (job.ctcMin === null && job.ctcMax === null && job.stipendPerMonth === null) {
    problems.push('Say what it pays - a CTC range, or a stipend for an internship.');
  }
  if (job.openings === null) {
    problems.push('Say how many people you are hiring.');
  }

  /*
   * The four things a university asks about every offer. A student must not
   * find out after accepting that the job is on an agency's payroll, that the
   * letter takes months, that it was conditional, or that there was a fee.
   */
  if (!job.employerType) {
    problems.push('Say who employs the student - your company, a subsidiary, or an agency.');
  }
  if (job.offerLetterDays === null) {
    problems.push('Say how soon after results the offer letter is issued.');
  }
  if (!job.offerConditional) {
    problems.push('Say whether the offer is conditional, and on what.');
  }
  if (!job.noFeeDeclaredAt) {
    problems.push('Confirm that no fee is charged to students at any stage.');
  }

  // A required test with no link would stop every application dead.
  if (job.screeningTestRequired && !job.screeningTestUrl) {
    problems.push('The test students must take before applying has no link.');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Publishing does not make a job visible. It marks the job published and lets
 * each targeted college decide - every posting is already PENDING, and the
 * approval queue only shows postings whose job has actually been published.
 */
export async function publishJob(jobId: string): Promise<Job> {
  const check = await publishReadiness(jobId);
  if (!check.ok) throw badRequest(check.problems[0]!, { problems: check.problems });

  return prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.PUBLISHED, publishedAt: new Date() },
  });
}

/**
 * Replaces the set of drives this job is aimed at.
 *
 * Postings that a college has already answered are left alone - withdrawing a
 * job someone has accepted, or silently re-asking one they declined, would
 * both be dishonest. Only untouched PENDING rows are added or removed.
 */
export interface Target {
  placementId: string;
  /**
   * Which batches inside that drive, or none for all of them.
   *
   * A drive at a big college can hold a computing batch and a civil one, and
   * a role for one of them should not land in front of the other.
   */
  batchIds?: string[];
}

export async function setTargets(job: Job, targets: Target[]): Promise<{ targets: number }> {
  // Only drives that are actually open may be targeted, whatever was sent.
  const valid = await prisma.placement.findMany({
    where: { id: { in: targets.map((t) => t.placementId) }, isOpen: true },
    select: { id: true, batches: { select: { id: true } } },
  });
  const wanted = new Set(valid.map((p) => p.id));

  // A batch has to belong to the drive it was named under. Anything else is
  // a stale id or a mistake, and quietly keeping it would narrow a posting to
  // a batch that can never match anybody.
  const batchesIn = new Map(valid.map((p) => [p.id, new Set(p.batches.map((b) => b.id))]));
  const batchesFor = new Map<string, string[]>(
    targets.map((t) => [
      t.placementId,
      (t.batchIds ?? []).filter((id) => batchesIn.get(t.placementId)?.has(id)),
    ]),
  );

  const existing = await prisma.jobPosting.findMany({
    where: { jobId: job.id },
    select: { id: true, placementId: true, status: true },
  });

  const toRemove = existing
    .filter((p) => p.status === PostingStatus.PENDING && !wanted.has(p.placementId))
    .map((p) => p.id);

  const already = new Set(existing.map((p) => p.placementId));
  const toAdd = [...wanted].filter((id) => !already.has(id));

  /*
   * An institution that approves companies itself must have said yes before a
   * new posting lands on any of its drives. Refused as a whole rather than
   * quietly dropped, so the company knows exactly where to ask. Postings that
   * already exist are left alone - a later block stops new roles, it does not
   * pull back ones a college already has.
   */
  if (toAdd.length) {
    const colleges = await prisma.placement.findMany({
      where: { id: { in: toAdd } },
      select: { college: { select: { tenantId: true } } },
    });
    const missing = await unreachableTenants(job.companyId, colleges.map((p) => p.college.tenantId));
    if (missing.length) {
      throw conflict(needsApprovalMessage(missing.map((t) => t.name)), {
        needsApproval: missing.map((t) => ({ tenantId: t.id, name: t.name })),
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    if (toRemove.length) await tx.jobPosting.deleteMany({ where: { id: { in: toRemove } } });
    if (toAdd.length) {
      await tx.jobPosting.createMany({
        data: toAdd.map((placementId) => ({ jobId: job.id, placementId })),
      });
    }

    /*
     * The batch narrowing, for every posting a college has not answered yet.
     *
     * Replaced wholesale rather than patched, like the eligibility lists: a
     * set edited in a form arrives as the whole set. Postings already
     * accepted or declined keep whatever they were answered about - changing
     * the reach of something a placement cell has already agreed to would be
     * doing it behind their back.
     */
    const open = await tx.jobPosting.findMany({
      where: { jobId: job.id, status: PostingStatus.PENDING },
      select: { id: true, placementId: true },
    });

    for (const posting of open) {
      const batchIds = batchesFor.get(posting.placementId) ?? [];
      await tx.jobPostingBatch.deleteMany({ where: { postingId: posting.id } });
      if (batchIds.length) {
        await tx.jobPostingBatch.createMany({
          data: batchIds.map((batchId) => ({ postingId: posting.id, batchId })),
        });
      }
    }
  });

  const total = await prisma.jobPosting.count({ where: { jobId: job.id } });
  return { targets: total };
}

/** A published job's shape is fixed - students have already seen it. */
export function assertEditable(job: Job): void {
  if (job.status !== JobStatus.DRAFT) {
    throw forbidden(
      'This role has been published, so its details and rounds are fixed. Close it and post a new one if it needs to change.',
    );
  }
}

/**
 * Replaces a job's course and graduating-year lists.
 *
 * These live in join tables rather than array columns because MySQL has none -
 * which is a better shape anyway: the visibility query filters on them in SQL
 * instead of pulling every job back and sifting in application code.
 */
export interface EligibilityLists {
  courses: string[];
  specialisations: string[];
  years: number[];
  skillIds: string[];
  /** A subset of skillIds the role actually asks for. */
  requiredSkillIds: string[];
}

export async function setEligibilityLists(
  jobId: string,
  lists: EligibilityLists,
): Promise<void> {
  const clean = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

  const courses = clean(lists.courses);
  const specialisations = clean(lists.specialisations);
  const skillIds = clean(lists.skillIds);
  const years = [...new Set(lists.years.filter((y) => Number.isInteger(y)))];

  await prisma.$transaction(async (tx) => {
    await tx.jobCourse.deleteMany({ where: { jobId } });
    await tx.jobSpecialisation.deleteMany({ where: { jobId } });
    await tx.jobGradYear.deleteMany({ where: { jobId } });
    await tx.jobSkill.deleteMany({ where: { jobId } });

    if (courses.length) {
      await tx.jobCourse.createMany({ data: courses.map((course) => ({ jobId, course })) });
    }
    if (specialisations.length) {
      await tx.jobSpecialisation.createMany({
        data: specialisations.map((specialisation) => ({ jobId, specialisation })),
      });
    }
    if (years.length) {
      await tx.jobGradYear.createMany({ data: years.map((year) => ({ jobId, year })) });
    }
    if (skillIds.length) {
      const required = new Set(clean(lists.requiredSkillIds));

      // Skipping duplicates rather than failing: a skill sent twice is a
      // client slip, not something worth losing the whole save over.
      await tx.jobSkill.createMany({
        data: skillIds.map((skillId) => ({ jobId, skillId, isRequired: required.has(skillId) })),
        skipDuplicates: true,
      });
    }
  });
}

/** Shapes the join rows back into the arrays the API has always returned. */
export function eligibilityOf(job: {
  courses?: { course: string }[];
  specialisations?: { specialisation: string }[];
  gradYears?: { year: number }[];
  skills?: { skill: { id: string; name: string }; isRequired?: boolean }[];
}) {
  return {
    allowedCourses: (job.courses ?? []).map((c) => c.course),
    allowedSpecialisations: (job.specialisations ?? []).map((c) => c.specialisation),
    graduationYears: (job.gradYears ?? []).map((g) => g.year),
    skills: (job.skills ?? []).map((s) => ({
      id: s.skill.id,
      name: s.skill.name,
      isRequired: s.isRequired ?? false,
    })),
    requiredSkillIds: (job.skills ?? []).filter((s) => s.isRequired).map((s) => s.skill.id),
  };
}

/**
 * What a recruiter is allowed to type into the eligibility step.
 *
 * Read from the data rather than from a constant: a course typed by hand
 * matches nobody, silently. The visibility query compares strings exactly, so
 * "B.E." and "B.Tech" are two different worlds, and the only list worth
 * offering is the one the students actually have.
 */
export async function eligibilityOptions(): Promise<{
  courses: string[];
  specialisations: string[];
  graduationYears: number[];
}> {
  /*
   * Everything that has been set up, from either place it is set up.
   *
   * The catalogue operations keeps under Setup is the canonical list, and it
   * comes first. But a course also arrives on a batch - a placement cell
   * enters "B.Tech" on "CSE 2026" and that is what its students are read as,
   * because a student with no course of their own is matched on their batch's
   * (see `contextOf` in visibility.ts). Offering the catalogue alone left the
   * picker narrower than the matcher: a university with batches but an empty
   * catalogue saw "No courses set up yet" and could not target anybody, while
   * the very strings that would have matched sat on the batches.
   *
   * Deduplicated on the exact string, not loosely, because the match is
   * exact: if two spellings are genuinely in the data, both are worth
   * offering, and the one that is never offered is the one that silently
   * reaches nobody.
   *
   * Graduating years stay derived the same way: nobody maintains a list of
   * years, and the ones worth offering are exactly the ones somebody is
   * graduating in.
   */
  const [courses, branches, batches, candidates] = await Promise.all([
    prisma.course.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.specialisation.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.batch.findMany({
      select: { course: true, specialisation: true, graduationYear: true },
      orderBy: { name: 'asc' },
    }),
    prisma.candidate.findMany({
      select: { course: true, specialisation: true, graduationYear: true },
    }),
  ]);

  const said = (...lists: (string | null)[][]) => [
    ...new Set(lists.flat().filter((v): v is string => typeof v === 'string' && v.trim() !== '')),
  ];

  const years = [
    ...new Set(
      [...candidates, ...batches]
        .map((r) => r.graduationYear)
        .filter((y): y is number => typeof y === 'number'),
    ),
  ].sort((a, b) => a - b);

  return {
    // The catalogue first, then anything a batch or a student carries that
    // the catalogue has not caught up with.
    courses: said(
      courses.map((c) => c.name),
      batches.map((b) => b.course),
      candidates.map((c) => c.course),
    ),
    specialisations: said(
      branches.map((b) => b.name),
      batches.map((b) => b.specialisation),
      candidates.map((c) => c.specialisation),
    ),
    graduationYears: years,
  };
}
