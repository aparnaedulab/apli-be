import { ApplicationStatus as S, AssessmentStatus, RoundOutcome } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * Badges: a record of movement that does not depend on a company replying.
 *
 * Most of what a placement portal has to tell somebody is a refusal, and on a
 * week where nothing has come back a student has no evidence they are getting
 * anywhere. "You finished your profile, sent six applications and cleared two
 * rounds" stays true through a silent fortnight - which is the whole point of
 * keeping it.
 *
 * Two rules hold this honest.
 *
 * Nothing is invented. Every badge is derived from a row that already exists
 * and carries the date that row was written, so a badge cannot claim anything
 * the record does not. They are computed on read rather than stored for the
 * same reason: a second copy of a fact is a fact that can drift from it.
 *
 * And nothing is comparative. There are no counts against a cohort and no
 * ranking, because the rest of the student side deliberately refuses to keep
 * score and one page doing it would undo the lot.
 */

export interface Badge {
  key: string;
  /** What it says on the badge. */
  label: string;
  /** What earns it - shown whether or not they have it. */
  how: string;
  /** When it happened, where the record can say. */
  at: Date | null;
  earned: boolean;
  /** Where to go and see the thing that earned it. */
  to: string;
}

/**
 * The earliest time an application reached a given status.
 *
 * The audit trail rather than the application's own column: somebody who was
 * shortlisted in September and rejected in October was still shortlisted, and
 * reading the current status would quietly take that back.
 */
async function firstReached(candidateId: string, to: S): Promise<Date | null> {
  const row = await prisma.statusEvent.findFirst({
    where: { toStatus: to, application: { candidateId } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export async function badgesFor(candidateId: string): Promise<Badge[]> {
  const [
    candidate,
    firstApplication,
    applicationCount,
    shortlisted,
    calledIn,
    passedRound,
    clearedTest,
    certificate,
    offered,
    placed,
  ] = await Promise.all([
    prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { resumeUrl: true, resumes: { select: { id: true }, take: 1 } },
    }),
    prisma.application.findFirst({
      where: { candidateId },
      orderBy: { appliedAt: 'asc' },
      select: { appliedAt: true },
    }),
    prisma.application.count({ where: { candidateId } }),
    firstReached(candidateId, S.SHORTLISTED),
    firstReached(candidateId, S.IN_ROUND),
    prisma.roundResult.findFirst({
      where: { outcome: RoundOutcome.PASSED, application: { candidateId } },
      orderBy: { evaluatedAt: 'asc' },
      select: { evaluatedAt: true },
    }),
    prisma.assessmentAssignment.findFirst({
      where: { candidateId, status: AssessmentStatus.PASSED },
      orderBy: { reviewedAt: 'asc' },
      select: { reviewedAt: true },
    }),
    prisma.simulationEnrolment.findFirst({
      where: { candidateId, certificateCode: { not: null } },
      orderBy: { completedAt: 'asc' },
      select: { completedAt: true },
    }),
    firstReached(candidateId, S.OFFERED),
    firstReached(candidateId, S.ACCEPTED),
  ]);

  const hasResume = Boolean(candidate?.resumeUrl) || (candidate?.resumes.length ?? 0) > 0;

  /*
   * Ten is a milestone, not a target.
   *
   * It is here because the tenth application is a genuinely different place
   * to be from the first, and for nobody to feel measured against it there
   * is no badge for twenty, fifty or a hundred. One nod, then it stops.
   */
  const tenth =
    applicationCount >= 10
      ? await prisma.application.findMany({
          where: { candidateId },
          orderBy: { appliedAt: 'asc' },
          skip: 9,
          take: 1,
          select: { appliedAt: true },
        })
      : [];

  const badges: Badge[] = [
    {
      key: 'resume',
      label: 'Resume ready',
      how: 'Upload one or build it here',
      // The record does not say when a resume first appeared, and a guessed
      // date is worse than none.
      at: null,
      earned: hasResume,
      to: '/student/resume',
    },
    {
      key: 'applied',
      label: 'First application',
      how: 'Apply to any role you qualify for',
      at: firstApplication?.appliedAt ?? null,
      earned: Boolean(firstApplication),
      to: '/student/applications',
    },
    {
      key: 'ten',
      label: 'Ten applications',
      how: 'Keep going - the tenth is a different place from the first',
      at: tenth[0]?.appliedAt ?? null,
      earned: applicationCount >= 10,
      to: '/student/applications',
    },
    {
      key: 'shortlisted',
      label: 'Shortlisted',
      how: 'A company picks you out of the pile',
      at: shortlisted,
      earned: shortlisted !== null,
      to: '/student/applications',
    },
    {
      key: 'called',
      label: 'Called to a round',
      how: 'A company asks you to a round and tells you when',
      at: calledIn,
      earned: calledIn !== null,
      to: '/student/interviews',
    },
    {
      key: 'round',
      label: 'Cleared a round',
      how: 'Pass any round of any process',
      at: passedRound?.evaluatedAt ?? null,
      earned: Boolean(passedRound),
      to: '/student/applications',
    },
    {
      key: 'test',
      label: 'Cleared a test',
      how: 'Pass an assessment somebody set you',
      at: clearedTest?.reviewedAt ?? null,
      earned: Boolean(clearedTest),
      to: '/student/assessments',
    },
    {
      key: 'certificate',
      label: 'Simulation certificate',
      how: 'Finish a work simulation and have it reviewed',
      at: certificate?.completedAt ?? null,
      earned: Boolean(certificate),
      to: '/student/projects',
    },
    {
      key: 'offer',
      label: 'Offer in hand',
      how: 'A company offers you a role',
      at: offered,
      earned: offered !== null,
      to: '/student/applications',
    },
    {
      key: 'placed',
      label: 'Placed',
      how: 'Accept an offer',
      at: placed,
      earned: placed !== null,
      to: '/student/applications',
    },
  ];

  return badges;
}
