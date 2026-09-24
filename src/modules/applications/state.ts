import { ApplicationStatus as S, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { IllegalTransition } from '../../lib/errors.js';

/**
 * The application lifecycle.
 *
 * This is the only place a status changes. Ten view functions each writing
 * `status = 'HIRED'` is how a state machine becomes fourteen inconsistent
 * strings; one table and one function is how it stays a state machine.
 */
export const ALLOWED: Record<S, ReadonlySet<S>> = {
  [S.APPLIED]: new Set([S.UNDER_REVIEW, S.REJECTED, S.WITHDRAWN]),
  // Reviewing can shortlist, or call somebody straight to a round where a
  // drive is running the two as one act.
  [S.UNDER_REVIEW]: new Set([S.SHORTLISTED, S.IN_ROUND, S.WAITLISTED, S.REJECTED, S.WITHDRAWN]),
  [S.SHORTLISTED]: new Set([S.IN_ROUND, S.WAITLISTED, S.REJECTED, S.WITHDRAWN]),
  [S.IN_ROUND]: new Set([S.IN_ROUND, S.WAITLISTED, S.OFFERED, S.REJECTED, S.WITHDRAWN]),
  [S.WAITLISTED]: new Set([S.SHORTLISTED, S.IN_ROUND, S.REJECTED, S.WITHDRAWN]),
  [S.OFFERED]: new Set([S.ACCEPTED, S.DECLINED, S.REJECTED, S.WITHDRAWN]),
  [S.ACCEPTED]: new Set([S.HIRED, S.WITHDRAWN]),

  // Terminal. Nothing leaves these.
  [S.HIRED]: new Set(),
  [S.REJECTED]: new Set(),
  [S.DECLINED]: new Set(),
  [S.WITHDRAWN]: new Set(),
};

/** Still in play - the set the one-offer cascade closes. */
export const ACTIVE: readonly S[] = [
  S.APPLIED,
  S.UNDER_REVIEW,
  S.SHORTLISTED,
  S.IN_ROUND,
  S.WAITLISTED,
  S.OFFERED,
];

export function canMove(from: S, to: S): boolean {
  return ALLOWED[from].has(to);
}

/** What each move should tell the people it affects. */
const NOTICE: Partial<Record<S, { title: string; body: (job: string, org: string) => string }>> = {
  [S.UNDER_REVIEW]: {
    title: 'Your application is being reviewed',
    body: (job, org) => `${org} has opened your application for ${job}.`,
  },
  /*
   * Two messages, not one.
   *
   * "You are shortlisted" and "your interview is on Thursday at 10" arrive on
   * different days and mean different things, and a student who is told only
   * the second has had the good news and the logistics arrive together with
   * no time to prepare for either.
   */
  [S.SHORTLISTED]: {
    title: 'You have been shortlisted',
    body: (job, org) =>
      `${org} has shortlisted you for ${job}. They will tell you when and where the rounds are.`,
  },
  [S.IN_ROUND]: {
    title: 'You have been called to a round',
    body: (job, org) =>
      `${org} has called you to the next round for ${job}. Open the application for when and where.`,
  },
  [S.WAITLISTED]: {
    title: 'You have been waitlisted',
    body: (job, org) => `${org} has waitlisted your application for ${job}.`,
  },
  [S.OFFERED]: {
    title: 'You have an offer',
    body: (job, org) => `${org} has offered you the ${job} role. Accept or decline it.`,
  },
  [S.REJECTED]: {
    title: 'Application not taken forward',
    body: (job, org) => `${org} is not taking your application for ${job} further.`,
  },
  [S.HIRED]: {
    title: 'You are hired',
    body: (job, org) => `${org} has confirmed you for ${job}. Congratulations.`,
  },
  [S.WITHDRAWN]: {
    title: 'An application was closed',
    body: (job, org) => `Your application for ${job} at ${org} is no longer active.`,
  },
};

interface TransitionInput {
  applicationId: string;
  to: S;
  actorId: string | null;
  note?: string;
  reason?: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Validate, move, record, cascade, notify - atomically.
 *
 * Everything except the notification write happens inside one transaction, so
 * a crash cannot leave a status changed with no audit row, or an accepted
 * offer with the student's other applications still open.
 */
export async function transition(input: TransitionInput) {
  const { applicationId, to, actorId, note, reason } = input;

  return prisma.$transaction(async (tx) => {
    const application = await tx.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: {
        placement: { select: { oneOfferRule: true } },
        job: { select: { title: true, company: { select: { name: true } } } },
        candidate: { select: { userId: true } },
      },
    });

    if (!canMove(application.status, to)) {
      throw new IllegalTransition(application.status, to);
    }

    await tx.statusEvent.create({
      data: {
        applicationId,
        actorId,
        fromStatus: application.status,
        toStatus: to,
        note: note ?? null,
        reason: reason ?? null,
      },
    });

    const updated = await tx.application.update({
      where: { id: applicationId },
      data: { status: to },
    });

    // One offer per student per drive. Fires on ACCEPTED, not HIRED -
    // accepting is the student's moment of commitment; hiring is the
    // recruiter confirming months later.
    let cascaded = 0;
    if (to === S.ACCEPTED && application.placement.oneOfferRule) {
      cascaded = await withdrawSiblings(tx, application.candidateId, application.placementId, {
        exceptId: applicationId,
        actorId,
      });
    }

    await notify(tx, {
      userId: application.candidate.userId,
      to,
      jobTitle: application.job.title,
      orgName: application.job.company.name,
      applicationId,
    });

    return { application: updated, cascaded };
  });
}

/**
 * Closes a student's other live applications in the same drive.
 *
 * Each one goes through the same audit-and-notify path as any other move,
 * rather than a bulk update - a recruiter who loses a candidate this way is
 * entitled to see when it happened and why.
 */
async function withdrawSiblings(
  tx: Tx,
  candidateId: string,
  placementId: string,
  opts: { exceptId: string; actorId: string | null },
): Promise<number> {
  const siblings = await tx.application.findMany({
    where: {
      candidateId,
      placementId,
      status: { in: [...ACTIVE] },
      id: { not: opts.exceptId },
    },
    include: {
      job: { select: { title: true, company: { select: { name: true } } } },
      candidate: { select: { userId: true } },
    },
  });

  for (const sibling of siblings) {
    if (!canMove(sibling.status, S.WITHDRAWN)) continue;

    await tx.statusEvent.create({
      data: {
        applicationId: sibling.id,
        actorId: opts.actorId,
        fromStatus: sibling.status,
        toStatus: S.WITHDRAWN,
        // The reason is what lets a recruiter's dashboard tell "this student
        // took another offer" from "this student quit on us".
        reason: 'auto_placed',
        note: 'Closed automatically: the student accepted an offer in this season.',
      },
    });

    await tx.application.update({
      where: { id: sibling.id },
      data: { status: S.WITHDRAWN },
    });

    await notify(tx, {
      userId: sibling.candidate.userId,
      to: S.WITHDRAWN,
      jobTitle: sibling.job.title,
      orgName: sibling.job.company.name,
      applicationId: sibling.id,
    });
  }

  return siblings.length;
}

async function notify(
  tx: Tx,
  input: {
    userId: string;
    to: S;
    jobTitle: string;
    orgName: string;
    applicationId: string;
  },
): Promise<void> {
  const notice = NOTICE[input.to];
  if (!notice) return;

  await tx.notification.create({
    data: {
      userId: input.userId,
      type: `application.${input.to.toLowerCase()}`,
      title: notice.title,
      body: notice.body(input.jobTitle, input.orgName),
      link: '/student/applications',
      payload: { applicationId: input.applicationId, status: input.to },
    },
  });
}
