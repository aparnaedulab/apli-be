import { AssessmentStatus as A, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Assessments: a test somebody is asked to sit.
 *
 * Assigned, never requested. A company shortlists and says "take this by
 * Friday"; it does not publish tests and wait for volunteers, and an approval
 * step between the two would be latency nobody benefits from.
 *
 * Apli does not host the questions yet, so an assessment points at whatever
 * platform the company already uses. What is held here is the part that was
 * missing entirely: who was asked, by when, what came back, and who is
 * entitled to read the result.
 */

/** Whoever set it, which is also whoever may read the result. */
export type Setter = { companyId: string } | { collegeId: string };

/**
 * A due date that has gone by, on something not yet sat.
 *
 * Worked out on read rather than written by a job. A status column that only
 * becomes true when something else happens to run is a column that lies for
 * as long as the thing is down - and "did I miss it" is exactly the question
 * a student opens this page to ask.
 */
export function effectiveStatus(row: {
  status: A;
  dueAt: Date | null;
  submittedAt: Date | null;
}): A {
  if (row.status !== A.ASSIGNED) return row.status;
  if (row.dueAt && row.dueAt.getTime() < Date.now()) return A.MISSED;
  return A.ASSIGNED;
}

/** Still owed: not sat, and not yet past its date. */
export const isOwed = (row: { status: A; dueAt: Date | null; submittedAt: Date | null }) =>
  effectiveStatus(row) === A.ASSIGNED;

const include = {
  assessment: {
    select: {
      id: true,
      title: true,
      instructions: true,
      url: true,
      durationMin: true,
      supervised: true,
      retakes: true,
      company: { select: { id: true, name: true } },
      college: { select: { id: true, name: true } },
    },
  },
  application: {
    select: {
      id: true,
      status: true,
      job: { select: { id: true, title: true } },
    },
  },
} satisfies Prisma.AssessmentAssignmentInclude;

type Loaded = Prisma.AssessmentAssignmentGetPayload<{ include: typeof include }>;

export const ASSIGNMENT_INCLUDE = include;

/** One row, as every screen wants to read it. */
export function serialise(row: Loaded) {
  const a = row.assessment;
  return {
    id: row.id,
    status: effectiveStatus(row),
    /* The raw column too, so a screen can tell "missed" from "failed" - one
       is a thing that happened to them, the other a verdict on their work. */
    recordedStatus: row.status,
    attempt: row.attempt,
    dueAt: row.dueAt,
    submittedRef: row.submittedRef,
    submittedAt: row.submittedAt,
    score: row.score,
    maxScore: row.maxScore,
    feedback: row.feedback,
    reviewedAt: row.reviewedAt,
    assessment: {
      id: a.id,
      title: a.title,
      instructions: a.instructions,
      url: a.url,
      durationMin: a.durationMin,
      supervised: a.supervised,
      retakes: a.retakes,
      /** Who set it - and, by the same token, who may read the result. */
      setBy: a.company?.name ?? a.college?.name ?? 'Your placement cell',
      setByKind: a.company ? ('company' as const) : ('college' as const),
    },
    application: row.application
      ? {
          id: row.application.id,
          status: row.application.status,
          jobId: row.application.job.id,
          jobTitle: row.application.job.title,
        }
      : null,
  };
}

/**
 * Assign a test to a set of students, skipping anyone who already has it.
 *
 * Idempotent on purpose: a recruiter who selects forty applicants, assigns,
 * then selects forty-two and assigns again should end with forty-two people
 * holding one test each, not two people holding one and forty holding two.
 *
 * The same goes within one call. A student who has applied to two of this
 * company's roles arrives here twice - once per application - and choosing
 * them by college, batch or email is choosing a person, not a row. Somebody
 * named twice is still one person sitting one test.
 */
export async function assign(input: {
  assessmentId: string;
  candidateIds: string[];
  /** The application each test gates, where it gates one. */
  applicationByCandidate?: Map<string, string>;
  dueAt: Date | null;
}): Promise<{ assigned: number; alreadyHad: number }> {
  const { assessmentId, dueAt } = input;
  /* One row per person, whatever came in. Two applications to the same
     company is two rows here and one student in the world. */
  const candidateIds = [...new Set(input.candidateIds)];
  if (candidateIds.length === 0) return { assigned: 0, alreadyHad: 0 };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.assessmentAssignment.findMany({
      where: { assessmentId, candidateId: { in: candidateIds }, attempt: 1 },
      select: { candidateId: true },
    });
    const had = new Set(existing.map((e) => e.candidateId));
    const fresh = candidateIds.filter((id) => !had.has(id));

    if (fresh.length === 0) return { assigned: 0, alreadyHad: had.size };

    await tx.assessmentAssignment.createMany({
      data: fresh.map((candidateId) => ({
        assessmentId,
        candidateId,
        applicationId: input.applicationByCandidate?.get(candidateId) ?? null,
        dueAt,
      })),
    });

    /*
     * Tell the people who just got one.
     *
     * Written inside the same transaction as the rows, so a crash cannot
     * leave somebody holding a test nobody told them about - and only for
     * the ones who did not already have it, because assigning twice is a
     * recruiter tidying their selection, not news.
     */
    const [test, students] = await Promise.all([
      tx.assessment.findUniqueOrThrow({
        where: { id: assessmentId },
        select: {
          title: true,
          company: { select: { name: true } },
          college: { select: { name: true } },
        },
      }),
      tx.candidate.findMany({
        where: { id: { in: fresh } },
        select: { id: true, userId: true },
      }),
    ]);

    const setBy = test.company?.name ?? test.college?.name ?? 'Your placement cell';
    const by = dueAt
      ? ` It needs to be back by ${dueAt.toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'long',
        })}.`
      : '';

    await tx.notification.createMany({
      data: students.map((s) => ({
        userId: s.userId,
        type: 'assessment.assigned',
        title: 'You have a test to sit',
        body: `${setBy} has asked you to take ${test.title}.${by}`,
        link: '/student/assessments',
        payload: { assessmentId, candidateId: s.id },
      })),
    });

    return { assigned: fresh.length, alreadyHad: had.size };
  });
}

/**
 * Let the student sit it again.
 *
 * The only place an approval genuinely belongs. A retake is a real question
 * with a real answer, and it is settled by a rule on the assessment rather
 * than by an inbox somebody has to work through.
 */
export async function nextAttempt(assignmentId: string): Promise<number> {
  const row = await prisma.assessmentAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
    include: { assessment: { select: { retakes: true } } },
  });

  const taken = await prisma.assessmentAssignment.count({
    where: { assessmentId: row.assessmentId, candidateId: row.candidateId },
  });

  if (taken > row.assessment.retakes) {
    throw badRequest(
      row.assessment.retakes === 0
        ? 'This test is a single attempt.'
        : `You have used all ${row.assessment.retakes + 1} attempts.`,
    );
  }

  return taken + 1;
}
