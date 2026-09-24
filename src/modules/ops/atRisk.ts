import { ApplicationStatus, PlacementType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { completionFor } from '../candidates/candidate.service.js';
import { loadCandidateContext, visibleJobWhere } from '../jobs/visibility.js';

/**
 * Students who have stalled, early enough to help.
 *
 * Every flag is a plain rule with a plain reason, so a placement officer can
 * see exactly why somebody is on the list and what to talk to them about.
 * The list is for the college; a student is never shown the words "at risk".
 */

export const RULES = {
  /** Below this, the profile gets in the way of being picked. */
  completionBelow: 60,
  /** Eligible for at least this many open roles... */
  idleOpenRoles: 2,
  /** ...and has not applied to anything in this many days. */
  idleDays: 14,
  /** Rejected at least this many times with no offer yet. */
  rejectionsWithoutOffer: 3,
  /** Not signed in for this many days. */
  inactiveDays: 30,
} as const;

export type RiskKey =
  | 'profile_incomplete'
  | 'not_verified'
  | 'not_applying'
  | 'repeated_rejections'
  | 'inactive'
  | 'not_placed';

export interface RiskFlag {
  key: RiskKey;
  reason: string;
  /** How much it matters, for ordering the list. */
  weight: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every student at the college - or in one of its batches - with the flags
 * that fire for them. Students with no flags are left out.
 */
export async function atRiskStudents(collegeId: string, opts: { batchId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();

  const candidates = await prisma.candidate.findMany({
    where: {
      // Belongs to the college either directly or through one of its batches;
      // a batch filter narrows to that batch, which must itself be the college's.
      batchMemberships: {
        some: opts.batchId ? { batchId: opts.batchId, batch: { collegeId } } : { batch: { collegeId } },
      },
    },
    include: {
      user: { select: { fullName: true, email: true, lastLoginAt: true, isActive: true } },
      educations: { select: { id: true } },
      experiences: { select: { id: true } },
      projects: { select: { id: true } },
      skills: { select: { skillId: true } },
      batchMemberships: {
        where: { batch: { collegeId } },
        select: {
          isFrozen: true,
          batch: {
            select: {
              id: true,
              name: true,
              placements: { select: { id: true, name: true, isOpen: true, type: true } },
            },
          },
        },
      },
      applications: { select: { status: true, appliedAt: true, placementId: true } },
    },
  });

  const out = [];
  for (const c of candidates) {
    const flags: RiskFlag[] = [];
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

    const { percent, sections } = completionFor({
      phone: c.phone,
      graduationYear: c.graduationYear,
      resumeUrl: c.resumeUrl,
      cgpa: num(c.cgpa),
      tenthPct: num(c.tenthPct),
      twelfthPct: num(c.twelfthPct),
      educations: c.educations,
      experiences: c.experiences,
      projects: c.projects,
      skills: c.skills,
    });
    if (percent < RULES.completionBelow) {
      const missing = sections.filter((s) => !s.done).map((s) => s.label.toLowerCase());
      flags.push({
        key: 'profile_incomplete',
        reason: `Profile is ${percent}% complete - missing ${missing.join(', ')}.`,
        weight: 2,
      });
    }

    const verified = c.batchMemberships.some((m) => m.isFrozen);
    if (!verified) {
      flags.push({ key: 'not_verified', reason: 'Record not verified yet, so they cannot apply.', weight: 3 });
    }

    const settled = c.applications.some((a) =>
      ([ApplicationStatus.OFFERED, ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] as ApplicationStatus[]).includes(
        a.status,
      ),
    );

    const lastApplied = c.applications.reduce<Date | null>(
      (latest, a) => (!latest || a.appliedAt > latest ? a.appliedAt : latest),
      null,
    );
    const recentlyApplied = lastApplied && now.getTime() - lastApplied.getTime() < RULES.idleDays * DAY;
    if (verified && !settled && !recentlyApplied) {
      // Only worth a query when the cheaper conditions already hold.
      const ctx = await loadCandidateContext(c.id);
      const open = await prisma.job.count({
        where: { AND: [visibleJobWhere(ctx), { applications: { none: { candidateId: c.id } } }] },
      });
      if (open >= RULES.idleOpenRoles) {
        flags.push({
          key: 'not_applying',
          reason: `Eligible for ${open} open roles but hasn't applied ${lastApplied ? `in ${RULES.idleDays} days` : 'to any yet'}.`,
          weight: 3,
        });
      }
    }

    const rejected = c.applications.filter((a) => a.status === ApplicationStatus.REJECTED).length;
    if (rejected >= RULES.rejectionsWithoutOffer && !settled) {
      flags.push({
        key: 'repeated_rejections',
        reason: `Not selected in ${rejected} applications and no offer yet - worth a conversation.`,
        weight: 3,
      });
    }

    const last = c.user.lastLoginAt;
    if (!last || now.getTime() - last.getTime() > RULES.inactiveDays * DAY) {
      flags.push({
        key: 'inactive',
        reason: last
          ? `Hasn't signed in for ${Math.floor((now.getTime() - last.getTime()) / DAY)} days.`
          : 'Has never signed in.',
        weight: 1,
      });
    }

    const openFinals = c.batchMemberships
      .flatMap((m) => m.batch.placements)
      .filter((p) => p.isOpen && p.type === PlacementType.FINAL);
    const unplacedIn = openFinals.filter(
      (p) =>
        !c.applications.some(
          (a) =>
            a.placementId === p.id &&
            ([ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] as ApplicationStatus[]).includes(a.status),
        ),
    );
    if (unplacedIn.length > 0 && !settled) {
      flags.push({
        key: 'not_placed',
        reason: `Not placed yet in ${unplacedIn[0]!.name}, which is open.`,
        weight: 1,
      });
    }

    if (flags.length === 0) continue;
    out.push({
      candidateId: c.id,
      userId: c.userId,
      name: c.user.fullName,
      email: c.user.email,
      batches: c.batchMemberships.map((m) => ({ id: m.batch.id, name: m.batch.name })),
      completion: percent,
      flags,
      score: flags.reduce((n, f) => n + f.weight, 0),
      lastLoginAt: c.user.lastLoginAt,
    });
  }

  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out;
}

/**
 * What a nudge says to the student. Kind, specific, and never the words "at
 * risk" - the message is an offer of help from their own placement cell.
 */
export function nudgeMessage(primary: RiskKey | undefined, collegeName: string): { title: string; body: string; link: string } {
  switch (primary) {
    case 'profile_incomplete':
      return {
        title: 'A few minutes on your profile will help',
        body: `${collegeName}'s placement cell noticed a couple of sections are still empty. Recruiters filter on them - finish them and more roles open up.`,
        link: '/student/profile',
      };
    case 'not_verified':
      return {
        title: 'Let’s get your record verified',
        body: `Your placement cell at ${collegeName} still needs to verify your record before you can apply. Drop by or reply to them - it only takes a moment.`,
        link: '/student/profile',
      };
    case 'not_applying':
      return {
        title: 'There are roles open for you',
        body: `You're eligible for roles that are open right now. Take a look - your placement cell at ${collegeName} is happy to help you choose.`,
        link: '/student/jobs',
      };
    case 'repeated_rejections':
      return {
        title: 'Your placement cell would like to help',
        body: `Interviews are hard, and every one is practice. ${collegeName}'s placement cell would like to talk through what's next with you.`,
        link: '/student/applications',
      };
    default:
      return {
        title: 'A note from your placement cell',
        body: `${collegeName}'s placement cell is checking in - new roles and updates are waiting for you.`,
        link: '/student',
      };
  }
}
