import { CampusDriveStatus, JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/**
 * Drives the college starts.
 *
 * The platform already had the recruiter's way in: a company builds a role,
 * aims it at colleges, and each college accepts or declines its own posting.
 * This is the other way round, which is how most campus hiring actually
 * begins - the cell rings a company it has a relationship with and asks them
 * to come.
 *
 * The order is deliberate and it is the whole feature:
 *
 *   1. the cell drafts the visit, the roles it wants and who it is for
 *   2. it invites the company
 *   3. the company is shown numbers - how many students clear the bar, broken
 *      down - and agrees or declines with a reason
 *   4. only then does the cell put a time and a place on it
 *   5. only then can it be opened, and only an open drive is visible to a
 *      student
 *
 * Nothing about a student reaches the company at step 3. A recruiter deciding
 * whether a campus is worth a day needs to know how many people clear the bar,
 * not who they are, and the product's promise is that student data does not
 * leave the college. So the report is counts, and the roster stays put.
 *
 * Where it converges: a drive carries Jobs, students apply to those Jobs, and
 * from there it is the same pipeline, the same state machine and the same
 * one-offer cascade as everything else. This changes how a role arrives, not
 * what happens to it afterwards.
 *
 * Whose bar it is
 * ---------------
 * The company's. Always. A college does not tell a recruiter who it may
 * consider, and a version of this where it did would be wrong about the one
 * thing campus hiring is never confused about.
 *
 * So the cell does not enter one at all. A new drive has no bar: it counts
 * everyone the college has verified in that season. The company sets its
 * requirement on the invitation, watches the counts move as it does, and only
 * then decides - and once it has answered, the bar is settled.
 */

const S = CampusDriveStatus;

/**
 * What may follow what.
 *
 * DRAFT and INVITED can still be withdrawn to DRAFT, because a cell that
 * invited the wrong company should be able to say so. Nothing comes back from
 * CLOSED or DECLINED: those are endings, and a drive that could be un-declined
 * would leave a company's "no" looking negotiable.
 */
const NEXT: Record<CampusDriveStatus, CampusDriveStatus[]> = {
  [S.DRAFT]: [S.INVITED],
  [S.INVITED]: [S.ACCEPTED, S.DECLINED, S.DRAFT],
  [S.ACCEPTED]: [S.SCHEDULED, S.CLOSED],
  [S.SCHEDULED]: [S.OPEN, S.CLOSED],
  [S.OPEN]: [S.CLOSED],
  [S.CLOSED]: [],
  [S.DECLINED]: [],
};

export function canMove(from: CampusDriveStatus, to: CampusDriveStatus): boolean {
  return NEXT[from].includes(to);
}

const DRIVE_INCLUDE = {
  company: { select: { id: true, name: true, status: true } },
  college: { select: { id: true, name: true } },
  placement: { select: { id: true, name: true, year: true, isOpen: true } },
  courses: { select: { course: true } },
  branches: { select: { specialisation: true } },
  gradYears: { select: { year: true } },
  jobs: {
    select: {
      confirmedAt: true,
      job: { select: { id: true, title: true, status: true } },
    },
  },
  _count: { select: { registrations: true } },
} satisfies Prisma.CampusDriveInclude;

export interface DriveInput {
  placementId: string;
  companyId: string;
  title: string;
  pitch?: string | null;
}

/**
 * Telling somebody.
 *
 * An invitation nobody notices is an invitation that expires, and the two
 * moments that matter here are both handovers: the cell has asked and is now
 * waiting on the company, or the company has answered and the cell can plan.
 * Each one goes to the people who have to do the next thing.
 *
 * Never fatal. A drive that was invited but whose notification failed is still
 * invited, and throwing here would undo a state change that genuinely
 * happened.
 */
async function tellCompany(companyId: string, title: string, body: string) {
  try {
    const members = await prisma.companyMember.findMany({
      where: { companyId, user: { isActive: true } },
      select: { userId: true },
    });
    if (members.length === 0) return;
    await prisma.notification.createMany({
      data: members.map((m) => ({
        userId: m.userId,
        type: 'DRIVE_INVITED',
        title,
        body,
        link: '/company/invitations',
      })),
    });
  } catch {
    // Logged by the caller's own error path if anything else goes wrong.
  }
}

async function tellCell(collegeId: string, title: string, body: string) {
  try {
    const staff = await prisma.campusMember.findMany({
      where: { collegeId, user: { isActive: true } },
      select: { userId: true },
    });
    if (staff.length === 0) return;
    await prisma.notification.createMany({
      data: staff.map((s) => ({
        userId: s.userId,
        type: 'DRIVE_ANSWERED',
        title,
        body,
        link: '/campus/campus-drives',
      })),
    });
  } catch {
    /* as above */
  }
}

/** The drive, or nothing - an id from another college simply does not match. */
async function owned(collegeId: string, id: string) {
  const drive = await prisma.campusDrive.findFirst({
    where: { id, collegeId },
    include: DRIVE_INCLUDE,
  });
  if (!drive) throw notFound('No such drive.');
  return drive;
}

export async function createDrive(collegeId: string, input: DriveInput) {
  const placement = await prisma.placement.findFirst({
    where: { id: input.placementId, collegeId },
    select: { id: true, isOpen: true },
  });
  if (!placement) throw notFound('That placement season is not one of yours.');
  if (!placement.isOpen) throw badRequest('That season is closed. Reopen it, or use another.');

  const company = await prisma.company.findUnique({
    where: { id: input.companyId },
    select: { id: true },
  });
  if (!company) throw notFound('No such company.');

  return prisma.campusDrive.create({
    data: {
      collegeId,
      placementId: input.placementId,
      companyId: input.companyId,
      title: input.title.trim(),
      pitch: input.pitch?.trim() || null,
      // No bar. The drive starts open to everyone the college has verified,
      // and the company narrows it on the invitation.
    },
    include: DRIVE_INCLUDE,
  });
}

export async function listForCollege(collegeId: string, status?: CampusDriveStatus) {
  return prisma.campusDrive.findMany({
    where: { collegeId, ...(status ? { status } : {}) },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: DRIVE_INCLUDE,
    take: 200,
  });
}

/** How many invitations are sitting unanswered. For the badge on the nav. */
export async function pendingInvitationCount(companyId: string) {
  return prisma.campusDrive.count({ where: { companyId, status: S.INVITED } });
}

/** What a company has been invited to. Never DRAFT - an unsent invitation is the cell's business. */
export async function listForCompany(companyId: string) {
  return prisma.campusDrive.findMany({
    where: { companyId, status: { not: S.DRAFT } },
    orderBy: [{ status: 'asc' }, { invitedAt: 'desc' }],
    include: DRIVE_INCLUDE,
    take: 200,
  });
}

async function move(
  drive: { id: string; status: CampusDriveStatus },
  to: CampusDriveStatus,
  data: Prisma.CampusDriveUpdateInput = {},
) {
  if (!canMove(drive.status, to)) {
    throw conflict(`A drive that is ${drive.status.toLowerCase()} cannot become ${to.toLowerCase()}.`);
  }
  return prisma.campusDrive.update({
    where: { id: drive.id },
    data: { status: to, ...data },
    include: DRIVE_INCLUDE,
  });
}

export async function invite(collegeId: string, id: string) {
  const drive = await owned(collegeId, id);
  const sent = await move(drive, S.INVITED, { invitedAt: new Date() });
  await tellCompany(
    drive.companyId,
    `${drive.college.name} has invited you to a drive`,
    `${drive.title} — see how many of their students clear your bar, then accept or decline.`,
  );
  return sent;
}

/** Pulled back before the company answered. */
export async function withdrawInvite(collegeId: string, id: string) {
  const drive = await owned(collegeId, id);
  return move(drive, S.DRAFT, { invitedAt: null });
}

export async function respond(
  companyId: string,
  id: string,
  accept: boolean,
  reason?: string,
) {
  const drive = await prisma.campusDrive.findFirst({ where: { id, companyId } });
  if (!drive) throw notFound('No such invitation.');
  if (!accept && !reason?.trim()) {
    // The cell has to plan a season around this. "No" with nothing after it is
    // the thing every placement officer complains about.
    throw badRequest('Say why, so the cell can plan around it.');
  }
  const answered = await move(drive, accept ? S.ACCEPTED : S.DECLINED, {
    respondedAt: new Date(),
    declineReason: accept ? null : reason!.trim(),
  });
  await tellCell(
    drive.collegeId,
    accept
      ? `${answered.company.name} will come to ${answered.title}`
      : `${answered.company.name} declined ${answered.title}`,
    accept ? 'Set the day and place, then open it to students.' : reason!.trim(),
  );
  return answered;
}

/**
 * The company correcting the bar it was sent.
 *
 * Only while the invitation is still open. Afterwards the college has agreed
 * to a drive on the strength of particular numbers and has started planning
 * around them; moving them quietly at that point is not a change, it is a
 * different drive.
 */
export async function setCriteria(
  companyId: string,
  id: string,
  bar: {
    minCgpa?: number | null;
    minDegreePct?: number | null;
    maxBacklogs?: number | null;
    maxActiveBacklogs?: number | null;
    courses?: string[];
    branches?: string[];
    gradYears?: number[];
  },
) {
  const drive = await prisma.campusDrive.findFirst({
    where: { id, companyId },
    select: { id: true, status: true },
  });
  if (!drive) throw notFound('No such invitation.');
  if (drive.status !== S.INVITED) {
    throw conflict('The bar can only be changed while the invitation is still open.');
  }

  return prisma.campusDrive.update({
    where: { id: drive.id },
    data: {
      minCgpa: bar.minCgpa ?? null,
      minDegreePct: bar.minDegreePct ?? null,
      maxBacklogs: bar.maxBacklogs ?? null,
      maxActiveBacklogs: bar.maxActiveBacklogs ?? null,
      ...(bar.courses
        ? { courses: { deleteMany: {}, create: bar.courses.map((course) => ({ course })) } }
        : {}),
      ...(bar.branches
        ? {
            branches: {
              deleteMany: {},
              create: bar.branches.map((specialisation) => ({ specialisation })),
            },
          }
        : {}),
      ...(bar.gradYears
        ? { gradYears: { deleteMany: {}, create: bar.gradYears.map((year) => ({ year })) } }
        : {}),
    },
    include: DRIVE_INCLUDE,
  });
}

export async function schedule(
  collegeId: string,
  id: string,
  when: { scheduledAt: Date; addressLine?: string | null; meetingLink?: string | null },
) {
  const drive = await owned(collegeId, id);
  if (drive.status !== S.ACCEPTED && drive.status !== S.SCHEDULED) {
    throw conflict('Schedule it once the company has agreed to come.');
  }
  if (!when.addressLine?.trim() && !when.meetingLink?.trim()) {
    throw badRequest('Say where it is - a place on campus, or a link.');
  }
  return prisma.campusDrive.update({
    where: { id: drive.id },
    data: {
      status: S.SCHEDULED,
      scheduledAt: when.scheduledAt,
      addressLine: when.addressLine?.trim() || null,
      meetingLink: when.meetingLink?.trim() || null,
    },
    include: DRIVE_INCLUDE,
  });
}

/** Open it to students. Nothing is visible to anybody before this. */
export async function open(collegeId: string, id: string) {
  const drive = await owned(collegeId, id);
  if (!drive.scheduledAt) throw badRequest('Put a date on it before opening it.');
  return move(drive, S.OPEN, { openedAt: new Date() });
}

export async function close(collegeId: string, id: string) {
  const drive = await owned(collegeId, id);
  return move(drive, S.CLOSED, { closedAt: new Date() });
}

/**
 * Companies a cell may invite.
 *
 * Verified ones only. An unverified company cannot publish anything anywhere
 * on the platform, so offering it as somebody to invite would be offering a
 * dead end - the invitation would be accepted and the roles still could not go
 * out.
 */
export async function invitableCompanies(q?: string) {
  return prisma.company.findMany({
    where: {
      status: 'VERIFIED',
      ...(q?.trim() ? { name: { contains: q.trim() } } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
    take: 200,
  });
}

/* -------------------------------------------------------------------------- */
/* The eligibility report                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The numbers a company is shown before it agrees to come.
 *
 * Counts, and nothing else. No names, no roll numbers, no list: a recruiter
 * deciding whether a campus is worth a day needs to know how many people clear
 * the bar, not who they are.
 *
 * Only frozen students are counted. An unverified record is a claim the
 * college has not checked, and promising a company forty students on the
 * strength of self-entered marks is how a visit turns into a wasted morning.
 * The number is therefore lower than the roster, on purpose, and the report
 * says so.
 */
export async function eligibilityReport(driveId: string) {
  const drive = await prisma.campusDrive.findUnique({
    where: { id: driveId },
    include: {
      courses: { select: { course: true } },
      branches: { select: { specialisation: true } },
      gradYears: { select: { year: true } },
      placement: { select: { batches: { select: { id: true } } } },
    },
  });
  if (!drive) throw notFound('No such drive.');

  const batchIds = drive.placement.batches.map((b) => b.id);
  if (batchIds.length === 0) {
    return {
      inSeason: 0,
      verified: 0,
      eligible: 0,
      eligiblePct: null,
      byBranch: [],
      failing: [],
      note: 'No batches are in this season yet, so there is nobody to count.',
    };
  }

  const memberships = await prisma.batchMembership.findMany({
    where: { batchId: { in: batchIds } },
    select: {
      isFrozen: true,
      candidate: {
        select: {
          course: true,
          specialisation: true,
          graduationYear: true,
          cgpa: true,
          degreePct: true,
          backlogs: true,
          activeBacklogs: true,
        },
      },
    },
  });

  const num = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));
  const minCgpa = num(drive.minCgpa);
  const minDegreePct = num(drive.minDegreePct);
  const courses = new Set(drive.courses.map((c) => c.course));
  const branches = new Set(drive.branches.map((b) => b.specialisation));
  const years = new Set(drive.gradYears.map((g) => g.year));

  const verified = memberships.filter((m) => m.isFrozen);

  /** Why somebody did not make it, counted - so a bar can be argued about. */
  const failing = new Map<string, number>();
  const bump = (k: string) => failing.set(k, (failing.get(k) ?? 0) + 1);

  const byBranch = new Map<string, number>();
  let eligible = 0;

  for (const m of verified) {
    const c = m.candidate;
    let ok = true;

    // A missing number fails the criterion that needs it - the same rule as
    // jobs/visibility.ts. "No CGPA on record" is not "clears 7.0".
    if (courses.size > 0 && !(c.course && courses.has(c.course))) {
      ok = false;
      bump('course');
    }
    if (branches.size > 0 && !(c.specialisation && branches.has(c.specialisation))) {
      ok = false;
      bump('branch');
    }
    if (years.size > 0 && !(c.graduationYear && years.has(c.graduationYear))) {
      ok = false;
      bump('graduating year');
    }
    if (minCgpa !== null && !(num(c.cgpa) !== null && num(c.cgpa)! >= minCgpa)) {
      ok = false;
      bump('CGPA');
    }
    if (
      minDegreePct !== null &&
      !(num(c.degreePct) !== null && num(c.degreePct)! >= minDegreePct)
    ) {
      ok = false;
      bump('degree percentage');
    }
    if (drive.maxBacklogs !== null && (c.backlogs ?? 0) > drive.maxBacklogs) {
      ok = false;
      bump('backlogs');
    }
    if (
      drive.maxActiveBacklogs !== null &&
      (c.activeBacklogs ?? 0) > drive.maxActiveBacklogs
    ) {
      ok = false;
      bump('live backlogs');
    }

    if (ok) {
      eligible++;
      const key = c.specialisation || c.course || 'Not stated';
      byBranch.set(key, (byBranch.get(key) ?? 0) + 1);
    }
  }

  return {
    inSeason: memberships.length,
    verified: verified.length,
    eligible,
    eligiblePct: verified.length > 0 ? Math.round((eligible / verified.length) * 100) : null,
    byBranch: [...byBranch.entries()]
      .map(([branch, count]) => ({ branch, count }))
      .sort((a, b) => b.count - a.count),
    failing: [...failing.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    note: 'Verified students only. Unverified records are claims the college has not checked yet.',
  };
}

/* -------------------------------------------------------------------------- */
/* The roles on offer                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Are roles required? No - and that is deliberate.
 *
 * A cell often fixes a date with a company weeks before the roles are settled,
 * and a portal that refused to record the visit until they were would just
 * move that fortnight of negotiation back into email, which is the thing this
 * is meant to replace. So a drive can be arranged, agreed and even scheduled
 * with no roles attached.
 *
 * What roles do change is what a student can actually do. A drive with none is
 * an appointment: it can be opened, students can put their names down, and
 * that is all. Applying happens against a Job, so until one is attached and
 * published there is nothing to apply to - which is why the student's card
 * says "no roles yet" rather than pretending.
 */
export async function attachJob(collegeId: string, driveId: string, jobId: string) {
  const drive = await owned(collegeId, driveId);
  const job = await prisma.job.findFirst({
    where: { id: jobId, companyId: drive.companyId },
    select: { id: true },
  });
  // Only that company's roles. A drive is one company's visit, and a role from
  // somebody else on the day would be a different drive wearing its badge.
  if (!job) throw badRequest('That role belongs to another company.');

  await prisma.campusDriveJob.upsert({
    where: { driveId_jobId: { driveId, jobId } },
    create: { driveId, jobId },
    update: {},
  });
  return owned(collegeId, driveId);
}

export async function detachJob(collegeId: string, driveId: string, jobId: string) {
  await owned(collegeId, driveId);
  await prisma.campusDriveJob.deleteMany({ where: { driveId, jobId } });
  return owned(collegeId, driveId);
}

/** The company standing behind a role the college attached to its visit. */
export async function confirmJob(companyId: string, driveId: string, jobId: string) {
  const drive = await prisma.campusDrive.findFirst({
    where: { id: driveId, companyId },
    select: { id: true },
  });
  if (!drive) throw notFound('No such drive.');
  const done = await prisma.campusDriveJob.updateMany({
    where: { driveId, jobId, confirmedAt: null },
    data: { confirmedAt: new Date() },
  });
  if (done.count === 0) throw notFound('That role is not on this drive, or is already confirmed.');
}

/** This company's roles, for the cell to choose from when building the day. */
export async function companyJobs(collegeId: string, driveId: string) {
  const drive = await owned(collegeId, driveId);
  return prisma.job.findMany({
    // Drafts included: a cell often lines a role up for the day before the
    // company has published it.
    where: { companyId: drive.companyId, status: { not: JobStatus.CLOSED } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, status: true, location: true },
    take: 100,
  });
}

/* -------------------------------------------------------------------------- */
/* Students putting their name down                                           */
/* -------------------------------------------------------------------------- */

/** The open drives a student may put their name down for. */
export async function openDrivesFor(candidateId: string) {
  const memberships = await prisma.batchMembership.findMany({
    where: { candidateId },
    select: { isFrozen: true, batch: { select: { id: true } } },
  });
  const batchIds = memberships.map((m) => m.batch.id);
  if (batchIds.length === 0) return [];

  const drives = await prisma.campusDrive.findMany({
    where: { status: S.OPEN, placement: { batches: { some: { id: { in: batchIds } } } } },
    orderBy: { scheduledAt: 'asc' },
    include: {
      company: { select: { name: true } },
      registrations: { where: { candidateId, removedAt: null }, select: { id: true } },
      jobs: { select: { job: { select: { id: true, title: true } } } },
    },
    take: 50,
  });

  // Verification gates taking part, exactly as it gates applying.
  const frozen = memberships.some((m) => m.isFrozen);

  return drives.map((d) => ({
    id: d.id,
    title: d.title,
    company: d.company.name,
    scheduledAt: d.scheduledAt,
    addressLine: d.addressLine,
    meetingLink: d.meetingLink,
    pitch: d.pitch,
    roles: d.jobs.map((j) => j.job),
    registered: d.registrations.length > 0,
    canRegister: frozen,
  }));
}

export async function register(candidateId: string, driveId: string) {
  const drive = await prisma.campusDrive.findUnique({
    where: { id: driveId },
    select: { id: true, status: true, placement: { select: { batches: { select: { id: true } } } } },
  });
  if (!drive || drive.status !== S.OPEN) throw notFound('That drive is not open.');

  const membership = await prisma.batchMembership.findFirst({
    where: {
      candidateId,
      batchId: { in: drive.placement.batches.map((b) => b.id) },
    },
    select: { isFrozen: true },
  });
  if (!membership) throw badRequest('That drive is not for your batch.');
  if (!membership.isFrozen) {
    throw badRequest('Your college has not verified your record yet, so you cannot take part.');
  }

  // Putting a name down twice is the same as once, not an error.
  await prisma.campusDriveRegistration.upsert({
    where: { driveId_candidateId: { driveId, candidateId } },
    create: { driveId, candidateId },
    update: { removedAt: null },
  });
}

export async function unregister(candidateId: string, driveId: string) {
  await prisma.campusDriveRegistration.updateMany({
    where: { driveId, candidateId, removedAt: null },
    data: { removedAt: new Date() },
  });
}

/**
 * Who the company will meet.
 *
 * This is the one place a student reaches a recruiter, and it is narrow on
 * purpose. Two things have to be true, and both are the student's own doing:
 *
 *   they put their name down for this company's drive - choosing a company is
 *   the same act as applying to one of its roles, which is the basis the
 *   product already works on;
 *
 *   and they granted `share_profile_with_recruiters`, the consent whose own
 *   words are "your name, contact details, education and projects go to the
 *   company - only for roles you apply to".
 *
 * A student who has not answered that consent is counted and not named. The
 * company is told how many, so the number still adds up and nobody is quietly
 * missing - it just cannot see who they are until they say so.
 *
 * And only once the drive is OPEN. Before that nobody has opted into anything.
 */
export async function driveRoster(companyId: string, driveId: string) {
  const drive = await prisma.campusDrive.findFirst({
    where: { id: driveId, companyId },
    select: { id: true, status: true },
  });
  if (!drive) throw notFound('No such drive.');
  if (drive.status !== S.OPEN && drive.status !== S.CLOSED) {
    return { students: [], withheld: 0, note: 'Nobody can put their name down until the drive is open.' };
  }

  const rows = await prisma.campusDriveRegistration.findMany({
    where: { driveId, removedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      candidate: {
        select: {
          id: true,
          course: true,
          specialisation: true,
          graduationYear: true,
          cgpa: true,
          backlogs: true,
          user: { select: { fullName: true, email: true } },
          consents: {
            where: { purpose: 'share_profile_with_recruiters' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { granted: true },
          },
        },
      },
    },
    take: 1000,
  });

  const shared = rows.filter((r) => r.candidate.consents[0]?.granted === true);

  return {
    students: shared.map((r) => ({
      id: r.candidate.id,
      name: r.candidate.user.fullName,
      email: r.candidate.user.email,
      course: r.candidate.course,
      branch: r.candidate.specialisation,
      graduationYear: r.candidate.graduationYear,
      cgpa: r.candidate.cgpa,
      backlogs: r.candidate.backlogs,
      registeredAt: r.createdAt,
    })),
    withheld: rows.length - shared.length,
    note:
      rows.length === 0
        ? 'Nobody has put their name down yet.'
        : 'Students who put their name down for this drive and agreed to share their profile.',
  };
}

/** Who has put their name down - the cell's list, and only the cell's. */
export async function registrations(collegeId: string, driveId: string) {
  await owned(collegeId, driveId);
  return prisma.campusDriveRegistration.findMany({
    where: { driveId, removedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
      candidate: {
        select: {
          id: true,
          course: true,
          specialisation: true,
          cgpa: true,
          user: { select: { fullName: true, email: true } },
        },
      },
    },
  });
}
