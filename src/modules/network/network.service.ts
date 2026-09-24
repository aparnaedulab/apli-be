import { ApplicationStatus, CompanyStatus, JobStatus, PostingStatus, type PlacementType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { tenantHasModule } from '../tenants/tenant.context.js';
import { unreachableTenants } from '../companyAccess/companyAccess.service.js';

/**
 * Alumni connect and pooled drives.
 *
 * Both are about a college reaching past itself - to the people who left it,
 * and to the colleges beside it - without ever loosening the fences the rest
 * of the platform keeps: a student only ever sees their own college's
 * seniors, nobody's phone or email crosses over, and a company that reaches a
 * pool still waits for each college to accept its role.
 */

/* ========================================================================== */
/* Alumni                                                                      */
/* ========================================================================== */

/** Open referral requests a student may have at once - enough to try, not enough to spam. */
export const MAX_OPEN_REFERRALS = 3;

/**
 * Whether a candidate counts as an alumnus of their college.
 *
 * Either they have graduated (their passing year is behind us) or they have
 * already accepted an offer - a final-year student with a job in hand knows
 * exactly what juniors want to ask, months before convocation.
 */
export async function isAlumnus(candidateId: string, now = new Date()): Promise<boolean> {
  const c = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { graduationYear: true },
  });
  if (!c) return false;
  if (c.graduationYear !== null && c.graduationYear < now.getFullYear()) return true;
  const placed = await prisma.application.count({
    where: {
      candidateId,
      status: { in: [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
    },
  });
  return placed > 0;
}

/** The student's own college, or a refusal - alumni connect is always inside one. */
export async function collegeOf(candidateId: string) {
  const c = await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    select: {
      collegeId: true,
      userId: true,
      user: { select: { fullName: true } },
      college: { select: { name: true } },
    },
  });
  if (!c.collegeId) {
    throw forbidden('Alumni connect works within your college, and your account is not linked to one.');
  }
  return { ...c, collegeId: c.collegeId };
}

/** What anyone may see of an alumnus. Deliberately no email and no phone. */
export function publicMentor(row: {
  candidateId: string;
  currentCompany: string | null;
  currentRole: string | null;
  canRefer: boolean;
  topics: unknown;
  candidate: {
    graduationYear: number | null;
    course: string | null;
    specialisation: string | null;
    user: { fullName: string };
  };
}) {
  return {
    candidateId: row.candidateId,
    name: row.candidate.user.fullName,
    graduationYear: row.candidate.graduationYear,
    course: row.candidate.course,
    specialisation: row.candidate.specialisation,
    currentCompany: row.currentCompany,
    currentRole: row.currentRole,
    canRefer: row.canRefer,
    topics: Array.isArray(row.topics) ? (row.topics as string[]) : [],
  };
}

/** A notification, fire-and-forget within the caller's own write. */
export async function notify(userId: string, type: string, title: string, body: string, link: string, payload = {}) {
  await prisma.notification.create({ data: { userId, type, title, body, link, payload } });
}

/**
 * Checks everything a referral request must satisfy before it is sent.
 *
 * Only to an alumnus of the student's own college who has opted in, is
 * available and said they can refer; never to oneself; and never more than
 * MAX_OPEN_REFERRALS waiting at once.
 */
export async function assertCanRequestReferral(fromCandidateId: string, toCandidateId: string) {
  if (fromCandidateId === toCandidateId) throw badRequest('You cannot ask yourself for a referral.');

  const me = await collegeOf(fromCandidateId);
  const target = await prisma.alumniProfile.findUnique({
    where: { candidateId: toCandidateId },
    include: { candidate: { select: { collegeId: true, userId: true } } },
  });
  // Someone outside the college, or not opted in, answers exactly like nobody.
  if (!target || target.candidate.collegeId !== me.collegeId || !target.available) {
    throw notFound('That senior is not taking requests.');
  }
  if (!target.canRefer) throw conflict('That senior has not offered to refer. You can still ask them a question.');

  const open = await prisma.referralRequest.count({
    where: { fromCandidateId, status: 'SENT' },
  });
  if (open >= MAX_OPEN_REFERRALS) {
    throw new AppError(
      429,
      'TOO_MANY_OPEN',
      `You have ${open} referral requests waiting. Wait for an answer before asking someone else.`,
    );
  }
  return { me, target };
}

/* ========================================================================== */
/* Pooled drives                                                               */
/* ========================================================================== */

/** The college, with its institution - pools never cross institutions. */
export async function campusCollege(collegeId: string) {
  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: { id: true, name: true, tenantId: true },
  });
  if (!college) throw notFound('No such college.');
  return college;
}

/**
 * One of the college's own open drives, of the pool's type.
 *
 * A college joins a pool through a drive it already runs, so every rule that
 * drive carries - its batches, its one-offer rule, its own approvals - keeps
 * applying to whatever reaches it through the pool.
 */
export async function ownOpenPlacement(collegeId: string, placementId: string, type: string) {
  const placement = await prisma.placement.findFirst({
    where: { id: placementId, collegeId },
    select: { id: true, isOpen: true, type: true, name: true },
  });
  if (!placement) throw notFound('That drive does not belong to your college.');
  if (!placement.isOpen) throw conflict('That drive is closed. Choose an open one.');
  if (placement.type !== (type as PlacementType)) {
    throw conflict(`This pool is for ${type === 'FINAL' ? 'final placements' : 'internships'}. Choose a drive of the same kind.`);
  }
  return placement;
}

/** Students in a drive's batches - the headcount a company decides a visit on. */
export async function studentsInPlacement(placementId: string): Promise<number> {
  return prisma.batchMembership.count({
    where: { batch: { placements: { some: { id: placementId } } } },
  });
}

/** A pool as its members and the companies see it. */
export async function describePool(poolId: string) {
  const pool = await prisma.pooledDrive.findUnique({
    where: { id: poolId },
    include: { members: { orderBy: { createdAt: 'asc' } } },
  });
  if (!pool) throw notFound('No such pool.');

  const collegeIds = [pool.hostCollegeId, ...pool.members.map((m) => m.collegeId)];
  const colleges = await prisma.college.findMany({
    where: { id: { in: collegeIds } },
    select: { id: true, name: true, code: true, city: true },
  });
  const byId = new Map(colleges.map((c) => [c.id, c]));

  const members = await Promise.all(
    pool.members.map(async (m) => ({
      collegeId: m.collegeId,
      collegeName: byId.get(m.collegeId)?.name ?? 'A college',
      collegeCode: byId.get(m.collegeId)?.code ?? null,
      city: byId.get(m.collegeId)?.city ?? null,
      status: m.status,
      placementId: m.placementId,
      students: m.status === 'JOINED' && m.placementId ? await studentsInPlacement(m.placementId) : 0,
    })),
  );

  return {
    id: pool.id,
    name: pool.name,
    year: pool.year,
    type: pool.type,
    hostCollegeId: pool.hostCollegeId,
    hostName: byId.get(pool.hostCollegeId)?.name ?? 'A college',
    createdAt: pool.createdAt,
    members,
    joined: members.filter((m) => m.status === 'JOINED').length,
    students: members.reduce((n, m) => n + m.students, 0),
  };
}

/** Only a verified company may reach a pool - the same gate as posting anywhere. */
export async function verifiedCompany(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, status: true },
  });
  if (!company) throw notFound('No such company.');
  if (company.status !== CompanyStatus.VERIFIED) {
    throw forbidden('Your company must be verified before it can send roles to colleges.');
  }
  return company;
}

/**
 * Pools a company may see: at least one college has joined, and the
 * institution running it has pooled drives switched on.
 */
export async function openPoolsForCompanies() {
  const pools = await prisma.pooledDrive.findMany({
    where: { members: { some: { status: 'JOINED' } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, tenantId: true },
  });
  const visible = [];
  for (const p of pools) {
    if (p.tenantId && !(await tenantHasModule(p.tenantId, 'ops.pooledDrives'))) continue;
    visible.push(await describePool(p.id));
  }
  return visible;
}

/**
 * Sends one published role to every college that has joined a pool.
 *
 * Each becomes an ordinary PENDING posting on that college's own drive - the
 * pool saves the company from choosing colleges one by one, never from each
 * college's own decision. Running it twice adds nothing: a drive that already
 * has this role (in any state) is left as it is.
 */
export async function sendRoleToPool(poolId: string, companyId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, companyId }, select: { id: true, status: true, title: true } });
  if (!job) throw notFound('That role does not belong to your company.');
  if (job.status !== JobStatus.PUBLISHED) throw conflict('Publish the role first - colleges only see published roles.');

  const pool = await prisma.pooledDrive.findUnique({
    where: { id: poolId },
    include: { members: true },
  });
  if (!pool) throw notFound('No such pool.');
  if (pool.tenantId && !(await tenantHasModule(pool.tenantId, 'ops.pooledDrives'))) throw notFound('No such pool.');

  const targets = pool.members
    .filter((m) => m.status === 'JOINED' && m.placementId)
    .map((m) => m.placementId as string);
  if (targets.length === 0) throw conflict('No college has joined this pool yet.');

  // Closed drives take no new roles, pool or not.
  const open = await prisma.placement.findMany({
    where: { id: { in: targets }, isOpen: true },
    select: { id: true, college: { select: { tenantId: true } } },
  });

  // A pool may span institutions. Those that approve companies themselves and
  // have not approved this one are skipped, and named, rather than failing the
  // whole send - the other colleges in the pool still get the role.
  const missing = await unreachableTenants(companyId, open.map((p) => p.college.tenantId));
  const missingIds = new Set(missing.map((t) => t.id));
  const openIds = open.filter((p) => !p.college.tenantId || !missingIds.has(p.college.tenantId)).map((p) => p.id);
  const skippedNeedsApproval = open.length - openIds.length;

  const existing = await prisma.jobPosting.findMany({
    where: { jobId, placementId: { in: openIds } },
    select: { placementId: true },
  });
  const already = new Set(existing.map((e) => e.placementId));
  const toAdd = openIds.filter((id) => !already.has(id));

  if (toAdd.length > 0) {
    await prisma.jobPosting.createMany({
      data: toAdd.map((placementId) => ({ jobId, placementId, status: PostingStatus.PENDING })),
    });
  }

  return {
    created: toAdd.length,
    alreadyThere: already.size,
    skippedClosed: targets.length - open.length,
    skippedNeedsApproval,
    needsApproval: missing.map((t) => t.name),
    jobTitle: job.title,
  };
}
