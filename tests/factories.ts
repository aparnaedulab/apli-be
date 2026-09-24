import { SYSTEM_ROLES } from '../src/modules/roles/permissions.js';
import {
  ApplicationStatus,
  CompanyStatus,
  JobStatus,
  PostingStatus,
  Role,
  RoleScope,
} from '@prisma/client';
import { db } from './setup.js';

/**
 * Just enough of a world to test against. Each helper returns the row it made,
 * so a test reads as the story it is checking rather than twenty lines of
 * setup.
 */

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

/** An institution. Live by default, because most tests are about one in use. */
export async function makeTenant(
  name = `Tenant ${uniq()}`,
  overrides: Partial<{ slug: string; status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' }> = {},
) {
  return db.tenant.create({
    data: {
      name,
      slug: overrides.slug ?? `t-${uniq()}`.toLowerCase(),
      status: overrides.status ?? 'ACTIVE',
      completedSteps: [],
    },
  });
}

/**
 * The tenant a test gets when it does not care which one.
 *
 * Looked up rather than cached: every test starts from an empty database, so
 * a remembered id would point at a row the last test's cleanup deleted.
 */
export async function defaultTenant() {
  return (
    (await db.tenant.findUnique({ where: { slug: 'test-default' } })) ??
    makeTenant('Test University', { slug: 'test-default' })
  );
}

export async function makeCollege(name = 'Test College', tenantId?: string) {
  const id = uniq();
  return db.college.create({
    data: {
      name,
      code: `TC${id}`.slice(0, 16),
      city: 'Pune',
      state: 'Maharashtra',
      tenantId: tenantId ?? (await defaultTenant()).id,
    },
  });
}

export async function makeCompany(name = `Company ${uniq()}`, verified = true) {
  return db.company.create({
    data: {
      name,
      status: verified ? CompanyStatus.VERIFIED : CompanyStatus.PENDING,
    },
  });
}

export async function makeRecruiter(companyId: string) {
  const user = await db.user.create({
    data: {
      email: `rec-${uniq()}@test.local`,
      fullName: 'Test Recruiter',
      passwordHash: 'x',
      role: Role.COMPANY,
    },
  });
  await db.companyMember.create({
    data: { userId: user.id, companyId, roleId: (await systemRole('company.owner')).id },
  });
  return user;
}

/**
 * The roles a test needs, created on demand.
 *
 * Each test starts from an empty database, so the seeded roles are not there.
 * Rather than every test knowing about permissions, it asks for one by its
 * key and gets the real definition from the same catalogue the app ships.
 */
export async function systemRole(key: string) {
  const existing = await db.platformRole.findUnique({ where: { key } });
  if (existing) return existing;

  const spec = SYSTEM_ROLES.find((r) => r.key === key);
  if (!spec) throw new Error(`No system role called ${key}`);

  return db.platformRole.create({
    data: {
      key: spec.key,
      name: spec.name,
      description: spec.description,
      scope: spec.scope as RoleScope,
      permissions: spec.permissions,
      isSystem: true,
    },
  });
}

export async function makeBatch(collegeId: string, overrides: Partial<{ course: string; graduationYear: number }> = {}) {
  const { tenantId } = await db.college.findUniqueOrThrow({
    where: { id: collegeId },
    select: { tenantId: true },
  });
  return db.batch.create({
    data: {
      collegeId,
      tenantId,
      name: `Batch ${uniq()}`,
      course: overrides.course ?? 'B.Tech',
      graduationYear: overrides.graduationYear ?? 2026,
    },
  });
}

export async function makeDrive(
  collegeId: string,
  batchId: string,
  opts: { oneOfferRule?: boolean } = {},
) {
  return db.placement.create({
    data: {
      collegeId,
      name: `Drive ${uniq()}`,
      year: 2026,
      oneOfferRule: opts.oneOfferRule ?? true,
      batches: { connect: { id: batchId } },
    },
  });
}

export async function makeStudent(
  batchId: string,
  opts: {
    cgpa?: number;
    frozen?: boolean;
    collegeId?: string;
    specialisation?: string;
    backlogs?: number;
    activeBacklogs?: number;
    gapYears?: number;
    lateral?: boolean;
  } = {},
) {
  const user = await db.user.create({
    data: {
      email: `stu-${uniq()}@test.local`,
      fullName: 'Test Student',
      passwordHash: 'x',
      role: Role.CANDIDATE,
    },
  });
  const candidate = await db.candidate.create({
    data: {
      userId: user.id,
      collegeId: opts.collegeId ?? null,
      graduationYear: 2026,
      cgpa: opts.cgpa ?? 8.5,
      tenthPct: 90,
      twelfthPct: 88,
      specialisation: opts.specialisation ?? null,
      backlogs: opts.backlogs ?? 0,
      activeBacklogs: opts.activeBacklogs ?? 0,
      gapYears: opts.gapYears ?? 0,
      isLateralEntry: opts.lateral ?? false,
    },
  });
  await db.batchMembership.create({
    data: {
      batchId,
      candidateId: candidate.id,
      isFrozen: opts.frozen ?? true,
      verifiedAt: opts.frozen === false ? null : new Date(),
    },
  });
  return { user, candidate };
}

export async function makeJob(
  companyId: string,
  createdById: string,
  opts: {
    minCgpa?: number;
    rounds?: number;
    courses?: string[];
    specialisations?: string[];
    years?: number[];
    maxBacklogs?: number;
    maxActiveBacklogs?: number;
    maxGapYears?: number;
    allowsLateralEntry?: boolean;
  } = {},
) {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 30);

  const job = await db.job.create({
    data: {
      companyId,
      createdById,
      title: `Role ${uniq()}`,
      description: 'A role for testing.',
      deadline,
      status: JobStatus.PUBLISHED,
      publishedAt: new Date(),
      minCgpa: opts.minCgpa ?? null,
      maxBacklogs: opts.maxBacklogs ?? null,
      maxActiveBacklogs: opts.maxActiveBacklogs ?? null,
      maxGapYears: opts.maxGapYears ?? null,
      allowsLateralEntry: opts.allowsLateralEntry ?? true,
      courses: { create: (opts.courses ?? []).map((course) => ({ course })) },
      specialisations: {
        create: (opts.specialisations ?? []).map((specialisation) => ({ specialisation })),
      },
      gradYears: { create: (opts.years ?? []).map((year) => ({ year })) },
    },
  });

  const count = opts.rounds ?? 2;
  for (let i = 1; i <= count; i++) {
    await db.round.create({
      data: { jobId: job.id, order: i, name: `Round ${i}`, type: 'RESUME_SCREEN' },
    });
  }

  return job;
}

/** Puts a job in front of a drive, accepted by default. */
export async function makePosting(
  jobId: string,
  placementId: string,
  status: PostingStatus = PostingStatus.ACCEPTED,
) {
  return db.jobPosting.create({ data: { jobId, placementId, status } });
}

export async function makeApplication(
  candidateId: string,
  jobId: string,
  placementId: string,
  status: ApplicationStatus = ApplicationStatus.APPLIED,
) {
  return db.application.create({ data: { candidateId, jobId, placementId, status } });
}
