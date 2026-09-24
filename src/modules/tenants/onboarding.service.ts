import {
  InviteKind,
  Prisma,
  RoleScope,
  TenantKind,
  TenantStatus,
  type Tenant,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { portalFor, sendInviteEmail } from '../invites/invite.mail.js';
import { isModuleKey, MODULES, planFor, resolveModules } from './catalogue.js';
import { looksLikeSameBranch } from './branches.js';
import type {
  AcademicsInput,
  CollegesInput,
  IdentityInput,
} from './onboarding.schemas.js';

/**
 * Onboarding an institution, one step at a time.
 *
 * Each step saves on its own and marks itself done, so the wizard can be left
 * half-way and resumed by somebody else next week. Nothing becomes visible to
 * anybody outside the platform team until `launch`, which refuses while a
 * required step is still missing - the checklist that screen shows is the
 * same function that guards the button.
 */

export const STEP_KEYS = [
  'identity',
  'academics',
  'colleges',
  'mapping',
  'batches',
  'features',
  'people',
  'review',
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

const nil = (v: string | undefined | null) => (v ? v : null);

function stepsOf(tenant: Pick<Tenant, 'completedSteps'>): StepKey[] {
  const raw = Array.isArray(tenant.completedSteps) ? tenant.completedSteps : [];
  return STEP_KEYS.filter((k) => (raw as unknown[]).includes(k));
}

async function markStep(
  tx: Prisma.TransactionClient,
  tenant: Pick<Tenant, 'id' | 'completedSteps'>,
  step: StepKey,
): Promise<void> {
  const done = new Set(stepsOf(tenant));
  if (done.has(step)) return;
  done.add(step);
  await tx.tenant.update({
    where: { id: tenant.id },
    data: { completedSteps: STEP_KEYS.filter((k) => done.has(k)) },
  });
}

/** Marks a step done, for callers outside a transaction. */
export async function markStepById(id: string, step: StepKey): Promise<void> {
  const tenant = await loadTenant(id);
  await prisma.$transaction((tx) => markStep(tx, tenant, step));
}

/** Steps a person may pass without adding anything. */
const SKIPPABLE: StepKey[] = ['mapping', 'batches'];

export async function completeOptionalStep(id: string, step: string): Promise<void> {
  if (!SKIPPABLE.includes(step as StepKey)) throw badRequest('That step cannot be skipped.');
  await markStepById(id, step as StepKey);
}

export async function loadTenant(id: string): Promise<Tenant> {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw notFound('That institution does not exist.');
  return tenant;
}

/* -------------------------------------------------------------------------- */
/* The console list                                                            */
/* -------------------------------------------------------------------------- */

export async function listTenants() {
  const tenants = await prisma.tenant.findMany({
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    include: {
      _count: { select: { colleges: true, adminMembers: true } },
    },
  });

  // One count per tenant. The console lists tens of institutions, not
  // thousands, and a grouped count across the college join would need raw SQL.
  const studentCounts = await Promise.all(
    tenants.map((t) =>
      prisma.candidate
        .count({ where: { college: { tenantId: t.id } } })
        .then((n) => [t.id, n] as const),
    ),
  );
  const studentsBy = new Map(studentCounts);

  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    slug: t.slug,
    kind: t.kind,
    status: t.status,
    plan: t.plan,
    brandColor: t.brandColor,
    logoUrl: t.logoUrl,
    city: t.city,
    state: t.state,
    completedSteps: stepsOf(t),
    colleges: t._count.colleges,
    admins: t._count.adminMembers,
    students: studentsBy.get(t.id) ?? 0,
    launchedAt: t.launchedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
}

/* -------------------------------------------------------------------------- */
/* Slugs                                                                       */
/* -------------------------------------------------------------------------- */

/** Whether an address is free, and a free one near it if not. */
export async function slugAvailability(slug: string, excludeId?: string) {
  const taken = async (s: string) => {
    const hit = await prisma.tenant.findUnique({ where: { slug: s }, select: { id: true } });
    return hit !== null && hit.id !== excludeId;
  };

  if (!(await taken(slug))) return { available: true, suggestion: null as string | null };

  for (let n = 2; n < 50; n++) {
    const candidate = `${slug}-${n}`;
    if (!(await taken(candidate))) return { available: false, suggestion: candidate };
  }
  return { available: false, suggestion: null };
}

/* -------------------------------------------------------------------------- */
/* Step 1 - identity                                                           */
/* -------------------------------------------------------------------------- */

const identityData = (d: IdentityInput) => ({
  name: d.name,
  shortName: nil(d.shortName),
  slug: d.slug,
  kind: d.kind,
  legalName: nil(d.legalName),
  website: nil(d.website),
  logoUrl: nil(d.logoUrl),
  faviconUrl: nil(d.faviconUrl),
  brandColor: d.brandColor,
  tagline: nil(d.tagline),
  city: nil(d.city),
  state: nil(d.state),
  address: nil(d.address),
  pincode: nil(d.pincode),
  contactName: d.contactName,
  contactEmail: d.contactEmail,
  contactPhone: nil(d.contactPhone),
  supportEmail: nil(d.supportEmail),
  supportPhone: nil(d.supportPhone),
  supportAltPhone: nil(d.supportAltPhone),
  supportWhatsapp: nil(d.supportWhatsapp),
  officeHours: nil(d.officeHours),
});

export async function createTenant(input: IdentityInput, createdById: string) {
  const { available, suggestion } = await slugAvailability(input.slug);
  if (!available) {
    throw conflict(
      `/${input.slug} is taken.${suggestion ? ` /${suggestion} is free.` : ''}`,
      { field: 'slug', suggestion },
    );
  }

  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { ...identityData(input), createdById, completedSteps: [] },
    });
    await markStep(tx, tenant, 'identity');
    return tenant;
  });
}

export async function updateIdentity(id: string, input: IdentityInput) {
  const tenant = await loadTenant(id);

  if (input.slug !== tenant.slug) {
    // An address that has been live has been printed and bookmarked. Changing
    // it breaks every one of those, so a launched tenant keeps its own.
    if (tenant.launchedAt) {
      throw conflict('This institution is live, so its address can no longer change.', {
        field: 'slug',
      });
    }
    const { available, suggestion } = await slugAvailability(input.slug, id);
    if (!available) {
      throw conflict(
        `/${input.slug} is taken.${suggestion ? ` /${suggestion} is free.` : ''}`,
        { field: 'slug', suggestion },
      );
    }
  }

  // A single-college institution with several colleges already cannot become
  // one: which of them would it be?
  if (input.kind === TenantKind.COLLEGE) {
    const count = await prisma.college.count({ where: { tenantId: id } });
    if (count > 1) {
      throw conflict(
        `This institution already has ${count} colleges. Remove all but one before making it a single college.`,
        { field: 'kind' },
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.tenant.update({ where: { id }, data: identityData(input) });
    await markStep(tx, updated, 'identity');
    return updated;
  });
}

/* -------------------------------------------------------------------------- */
/* Step 2 - academics                                                          */
/* -------------------------------------------------------------------------- */

export async function saveAcademics(id: string, input: AcademicsInput) {
  const tenant = await loadTenant(id);

  const courseIds = [...new Set(input.programs.map((p) => p.courseId))];
  const courses = await prisma.course.findMany({
    where: { id: { in: courseIds } },
    include: { specialisations: { select: { id: true } } },
  });
  const byId = new Map(courses.map((c) => [c.id, c]));

  const rows: { courseId: string; specialisationId: string | null }[] = [];
  for (const program of input.programs) {
    const course = byId.get(program.courseId);
    if (!course) throw badRequest('One of those courses no longer exists. Reload and try again.');

    const ownBranches = new Set(course.specialisations.map((s) => s.id));
    const branches = [...new Set(program.specialisationIds)];
    const stray = branches.find((b) => !ownBranches.has(b));
    if (stray) throw badRequest(`A branch was chosen that ${course.name} does not have.`);

    if (branches.length === 0) rows.push({ courseId: course.id, specialisationId: null });
    for (const b of branches) rows.push({ courseId: course.id, specialisationId: b });
  }

  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id },
      data: {
        ...(input.gradingScale ? { gradingScale: input.gradingScale } : {}),
        ...(input.academicYearStartMonth ? { academicYearStartMonth: input.academicYearStartMonth } : {}),
        oneOfferDefault: input.oneOfferDefault,
        allowSelfJoin: input.allowSelfJoin,
        ...(input.responseDays ? { responseDays: input.responseDays } : {}),
        ...(input.companyApprovalRequired !== undefined
          ? { companyApprovalRequired: input.companyApprovalRequired }
          : {}),
        ...(input.unverifiedCompanyAccess !== undefined
          ? { unverifiedCompanyAccess: input.unverifiedCompanyAccess }
          : {}),
      },
    });
    // Replaced wholesale: the screen always sends the full selection, and a
    // diff would only be a slower way of arriving at the same rows.
    await tx.tenantProgram.deleteMany({ where: { tenantId: id } });
    if (rows.length > 0) {
      await tx.tenantProgram.createMany({ data: rows.map((r) => ({ ...r, tenantId: id })) });
    }
    if (rows.length > 0) await markStep(tx, tenant, 'academics');
  });
}

/** How the wizard lists a course: its active branches, each tied to the master list. */
const COURSE_SELECT = {
  id: true,
  name: true,
  specialisations: {
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, branchId: true },
  },
} as const;

/**
 * Adds a branch to the master list.
 *
 * The same name in any letter case is the same branch, and comes back as it
 * is. A near match - "Computer Engg" beside "Computer Engineering" - is
 * refused with the look-alikes named, unless the person confirms it really is
 * a different branch. That refusal is where spelling mistakes are caught.
 */
export async function addBranch(input: { name: string; confirm: boolean }) {
  const exact = await prisma.branch.findFirst({ where: { name: input.name } });
  if (exact) {
    if (!exact.isActive) await prisma.branch.update({ where: { id: exact.id }, data: { isActive: true } });
    return { branch: { id: exact.id, name: exact.name }, existed: true };
  }

  if (!input.confirm) {
    const all = await prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true } });
    const similar = all.filter((b) => looksLikeSameBranch(b.name, input.name));
    if (similar.length > 0) {
      throw conflict(`Did you mean ${similar.map((b) => b.name).join(' or ')}?`, {
        code: 'SIMILAR_BRANCH',
        similar,
      });
    }
  }

  const branch = await prisma.branch.create({ data: { name: input.name } });
  return { branch: { id: branch.id, name: branch.name }, existed: false };
}

async function masterBranches(tx: Prisma.TransactionClient, ids: string[]) {
  const unique = [...new Set(ids)];
  const found = await tx.branch.findMany({ where: { id: { in: unique }, isActive: true } });
  if (found.length !== unique.length) throw badRequest('One of those branches no longer exists. Reload and try again.');
  return found;
}

/** Offers master branches under a course, skipping any it already has. */
async function linkBranches(tx: Prisma.TransactionClient, courseId: string, branchIds: string[]) {
  const branches = await masterBranches(tx, branchIds);
  const have = await tx.specialisation.findMany({ where: { courseId }, select: { id: true, branchId: true, isActive: true } });
  for (const b of branches) {
    const already = have.find((h) => h.branchId === b.id);
    if (already) {
      if (!already.isActive) await tx.specialisation.update({ where: { id: already.id }, data: { isActive: true } });
      continue;
    }
    await tx.specialisation.create({ data: { name: b.name, courseId, branchId: b.id } });
  }
}

/**
 * Adds a course to the shared catalogue, with branches picked from the
 * master list. A course name that already exists (in any letter case) is not
 * duplicated: the branches are added to the existing course instead.
 */
export async function addCourse(input: { name: string; branchIds: string[] }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.course.findFirst({ where: { name: input.name } });
    const course = existing ?? (await tx.course.create({ data: { name: input.name } }));
    if (existing && !existing.isActive) {
      await tx.course.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    if (input.branchIds.length > 0) await linkBranches(tx, course.id, input.branchIds);

    return {
      course: await tx.course.findUniqueOrThrow({ where: { id: course.id }, select: COURSE_SELECT }),
      existed: Boolean(existing),
    };
  });
}

/* --- in bulk -------------------------------------------------------------- */

type BranchRow = { id: string; name: string };

/**
 * How one typed branch name maps onto the master list.
 *
 *   matched  - the same name, ignoring case: that branch.
 *   similar  - a look-alike of an existing branch ("Mech Engg" beside
 *              "Mechanical"): the existing one is used, and the preview says so.
 *   missing  - nothing like it on the list.
 */
type Resolution =
  | { input: string; status: 'matched'; branch: BranchRow }
  | { input: string; status: 'similar'; branch: BranchRow }
  | { input: string; status: 'missing' };

function resolveBranch(input: string, list: BranchRow[]): Resolution {
  const exact = list.find((b) => b.name.toLowerCase() === input.toLowerCase());
  if (exact) return { input, status: 'matched', branch: exact };
  const like = list.find((b) => looksLikeSameBranch(b.name, input));
  if (like) return { input, status: 'similar', branch: like };
  return { input, status: 'missing' };
}

/**
 * Adds a pasted list of branches. Each goes through the same check as one
 * typed by hand, against the list as it grows - so "Mechanical" and "Mech"
 * in the same paste do not both get in. Look-alikes are reported, not added.
 */
export async function addBranchesInBulk(names: string[]) {
  const list: BranchRow[] = await prisma.branch.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });

  const results: (
    | { name: string; status: 'added' | 'existed'; branch: BranchRow }
    | { name: string; status: 'similar'; similar: BranchRow[] }
    | { name: string; status: 'invalid'; reason: string }
  )[] = [];

  for (const name of names) {
    if (name.length < 2) {
      results.push({ name, status: 'invalid', reason: 'Too short.' });
      continue;
    }
    const exact = list.find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (exact) {
      results.push({ name, status: 'existed', branch: exact });
      continue;
    }
    const similar = list.filter((b) => looksLikeSameBranch(b.name, name));
    if (similar.length > 0) {
      results.push({ name, status: 'similar', similar });
      continue;
    }
    // A name retired earlier comes back rather than clashing on the unique index.
    const retired = await prisma.branch.findFirst({ where: { name } });
    const branch = retired
      ? await prisma.branch.update({ where: { id: retired.id }, data: { isActive: true } })
      : await prisma.branch.create({ data: { name } });
    const row = { id: branch.id, name: branch.name };
    list.push(row);
    results.push({ name, status: 'added', branch: row });
  }

  return {
    results,
    added: results.filter((r) => r.status === 'added').length,
    held: results.filter((r) => r.status === 'similar').length,
  };
}

/**
 * Adds a pasted list of courses with their branches.
 *
 * Always worked out in full first: with `preview` set nothing is written and
 * the caller shows how every branch name was read. Committing then does
 * exactly what the preview showed.
 */
export async function addCoursesInBulk(input: {
  rows: { course: string; branches: string[] }[];
  addMissingBranches: boolean;
  preview: boolean;
}) {
  const branches: BranchRow[] = await prisma.branch.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });
  const courses = await prisma.course.findMany({ select: { id: true, name: true } });

  // The same course twice in a paste is one course with both lines' branches.
  const merged = new Map<string, { course: string; branches: string[] }>();
  for (const r of input.rows) {
    const key = r.course.toLowerCase();
    const prev = merged.get(key);
    merged.set(key, { course: prev?.course ?? r.course, branches: [...(prev?.branches ?? []), ...r.branches] });
  }

  // Missing names are resolved against each other too, so one unknown branch
  // typed on three lines is created once, and a look-alike of a name added
  // earlier in the same paste maps onto it.
  const pending: BranchRow[] = [];
  const plan = [...merged.values()].map((r) => {
    const existing = courses.find((c) => c.name.toLowerCase() === r.course.toLowerCase());
    const seen = new Set<string>();
    const resolved = r.branches
      .filter((b) => b.length > 0 && !seen.has(b.toLowerCase()) && seen.add(b.toLowerCase()))
      .map((b) => {
        const res = resolveBranch(b, [...branches, ...pending]);
        if (res.status === 'missing' && input.addMissingBranches && b.length >= 2) {
          const row = { id: `new:${b.toLowerCase()}`, name: b };
          pending.push(row);
          return { input: b, status: 'new' as const, branch: row };
        }
        return res;
      });
    return { course: existing?.name ?? r.course, courseId: existing?.id ?? null, branches: resolved };
  });

  const summary = {
    courses: plan.length,
    newCourses: plan.filter((p) => !p.courseId).length,
    newBranches: pending.length,
    mapped: plan.reduce((n, p) => n + p.branches.filter((b) => b.status === 'similar').length, 0),
    missing: plan.reduce((n, p) => n + p.branches.filter((b) => b.status === 'missing').length, 0),
  };

  if (input.preview) return { preview: true as const, plan, summary };

  const saved = await prisma.$transaction(async (tx) => {
    const created = new Map<string, string>();
    for (const b of pending) {
      const retired = await tx.branch.findFirst({ where: { name: b.name } });
      const row = retired
        ? await tx.branch.update({ where: { id: retired.id }, data: { isActive: true } })
        : await tx.branch.create({ data: { name: b.name } });
      created.set(b.id, row.id);
    }

    const out = [];
    for (const p of plan) {
      const course =
        (p.courseId && (await tx.course.update({ where: { id: p.courseId }, data: { isActive: true } }))) ||
        (await tx.course.create({ data: { name: p.course } }));
      const ids = p.branches
        .filter((b) => b.status !== 'missing')
        .map((b) => ('branch' in b ? (created.get(b.branch.id) ?? b.branch.id) : null))
        .filter((id): id is string => Boolean(id));
      if (ids.length > 0) await linkBranches(tx, course.id, ids);
      out.push(await tx.course.findUniqueOrThrow({ where: { id: course.id }, select: COURSE_SELECT }));
    }
    return out;
  });

  const allBranches = await prisma.branch.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return { preview: false as const, plan, summary, courses: saved, branches: allBranches };
}

/** Offers more master branches under an existing course. */
export async function attachBranches(courseId: string, branchIds: string[]) {
  return prisma.$transaction(async (tx) => {
    const course = await tx.course.findUnique({ where: { id: courseId } });
    if (!course) throw notFound('That course does not exist.');
    await linkBranches(tx, courseId, branchIds);
    return tx.course.findUniqueOrThrow({ where: { id: courseId }, select: COURSE_SELECT });
  });
}

/* -------------------------------------------------------------------------- */
/* Step 3 - colleges, their batches, and their placement officers              */
/* -------------------------------------------------------------------------- */

interface InviteOutcome {
  email: string;
  where: string;
  link?: string;
  emailed?: 'sent' | 'failed';
  note?: string;
}

export async function officerRole() {
  const role = await prisma.platformRole.findUnique({ where: { key: 'campus.officer' } });
  if (!role || !role.isActive) {
    throw badRequest(
      'The placement officer role is missing. Run `npm run sync:roles` on the server, then try again.',
    );
  }
  return role;
}

export async function senderName(userId: string): Promise<string> {
  const sender = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
  return sender?.fullName ?? 'The platform team';
}

export async function saveColleges(id: string, input: CollegesInput, userId: string) {
  const tenant = await loadTenant(id);

  if (tenant.kind === TenantKind.COLLEGE && input.colleges.length > 1) {
    throw badRequest('A single-college institution has exactly one college.');
  }

  // Codes are unique across the whole platform - a recruiter types "PICT" and
  // must get one college - so clashes are checked against every tenant.
  const codes = input.colleges.map((c) => c.code);
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup) throw badRequest(`${dup} appears twice in the list.`, { field: 'code', code: dup });

  const existing = await prisma.college.findMany({
    where: { tenantId: id },
    select: { id: true, name: true },
  });
  const ownIds = new Set(existing.map((c) => c.id));

  const stranger = input.colleges.find((c) => c.id && !ownIds.has(c.id));
  if (stranger) throw notFound('One of those colleges does not belong to this institution.');

  const clashes = await prisma.college.findMany({
    where: { code: { in: codes }, NOT: { tenantId: id } },
    select: { code: true },
  });
  if (clashes.length > 0) {
    const list = clashes.map((c) => c.code).join(', ');
    throw conflict(`${list} ${clashes.length === 1 ? 'is' : 'are'} already on the platform.`, {
      field: 'code',
      codes: clashes.map((c) => c.code),
    });
  }

  // Removing a college that has people in it would take their records with
  // it. Only an empty one - a typo, a duplicate - may simply go.
  const keep = new Set(input.colleges.map((c) => c.id).filter(Boolean) as string[]);
  const leaving = existing.filter((c) => !keep.has(c.id));
  if (leaving.length > 0) {
    const inUse = await prisma.college.findMany({
      where: {
        id: { in: leaving.map((c) => c.id) },
        OR: [
          { candidates: { some: {} } },
          { members: { some: {} } },
          { placements: { some: {} } },
        ],
      },
      select: { name: true },
    });
    if (inUse.length > 0) {
      throw conflict(
        `${inUse.map((c) => c.name).join(', ')} already ${inUse.length === 1 ? 'has' : 'have'} students, staff or drives, so ${inUse.length === 1 ? 'it stays' : 'they stay'}.`,
      );
    }
  }

  const collegeTypes = new Set(
    (await prisma.collegeType.findMany({ where: { isActive: true }, select: { id: true } })).map(
      (t) => t.id,
    ),
  );

  const saved = await prisma.$transaction(async (tx) => {
    if (leaving.length > 0) {
      await tx.college.deleteMany({ where: { id: { in: leaving.map((c) => c.id) } } });
    }

    const out: { id: string; name: string; courses: string[]; officerName?: string; officerEmail?: string }[] = [];
    let batchesCreated = 0;

    for (const row of input.colleges) {
      const data = {
        name: row.name,
        code: row.code,
        city: row.city,
        state: row.state,
        collegeTypeId: row.collegeTypeId && collegeTypes.has(row.collegeTypeId) ? row.collegeTypeId : null,
        naacGrade: nil(row.naacGrade),
        affiliation: tenant.kind === TenantKind.UNIVERSITY ? tenant.name : null,
      };

      const college = row.id
        ? await tx.college.update({ where: { id: row.id }, data })
        : await tx.college.create({ data: { ...data, tenantId: id } });

      // Starter batches: one per course this college runs, per passing year.
      // Existing names are left alone, so saving twice creates nothing twice.
      for (const course of new Set(row.courses)) {
        for (const year of new Set(input.passingYears)) {
          const name = `${course} ${year}`;
          const hit = await tx.batch.findFirst({ where: { collegeId: college.id, name } });
          if (hit) continue;
          await tx.batch.create({
            data: { name, course, graduationYear: year, collegeId: college.id, tenantId: id },
          });
          batchesCreated++;
        }
      }

      out.push({
        id: college.id,
        name: college.name,
        courses: row.courses,
        officerName: row.officerName || undefined,
        officerEmail: row.officerEmail || undefined,
      });
    }

    if (out.length > 0) await markStep(tx, tenant, 'colleges');
    return { colleges: out, batchesCreated };
  });

  // Officer invitations go out after the colleges exist, and one that cannot
  // be sent is reported rather than rolling back a whole college list.
  const invites: InviteOutcome[] = [];
  const wanted = saved.colleges.filter((c) => c.officerEmail);
  if (wanted.length > 0) {
    const role = await officerRole();
    const invitedBy = await senderName(userId);

    for (const college of wanted) {
      const email = college.officerEmail!;
      const already = await prisma.campusMember.findFirst({
        where: { collegeId: college.id, user: { email } },
        select: { id: true },
      });
      if (already) continue;
      const pending = await prisma.invite.findFirst({
        where: { collegeId: college.id, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (pending) continue;

      try {
        const { invite, token } = await createInvite({
          kind: InviteKind.CAMPUS_MEMBER,
          email,
          invitedName: college.officerName,
          collegeId: college.id,
          roleId: role.id,
          sentById: userId,
        });
        const link = inviteLinkFor(token);
        const mail = await sendInviteEmail({
          to: email,
          name: college.officerName ?? '',
          link,
          role: role.name,
          where: college.name,
          expiresAt: invite.expiresAt,
          invitedBy,
          ...(await portalFor(id)),
        });
        invites.push({ email, where: college.name, link, emailed: mail.sent ? 'sent' : 'failed' });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        invites.push({ email, where: college.name, note: err.message });
      }
    }
  }

  return { batchesCreated: saved.batchesCreated, invites };
}

/* -------------------------------------------------------------------------- */
/* Step 4 - features                                                           */
/* -------------------------------------------------------------------------- */

export async function saveFeatures(
  id: string,
  selected: string[],
  rules: { unverifiedCompanyAccess?: boolean } = {},
) {
  const tenant = await loadTenant(id);
  const unknown = selected.find((k) => !isModuleKey(k));
  if (unknown) throw badRequest(`There is no module called ${unknown}.`);

  const { enabled, added } = resolveModules(selected);
  const on = new Set(enabled);
  const plan = planFor(enabled);

  await prisma.$transaction(async (tx) => {
    // A row for every module in the catalogue, on or off, so "switched off on
    // purpose" is recorded and a module added to the catalogue later is
    // distinguishable from one this tenant declined.
    for (const m of MODULES) {
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId: id, moduleKey: m.key } },
        update: { enabled: on.has(m.key) },
        create: { tenantId: id, moduleKey: m.key, enabled: on.has(m.key) },
      });
    }
    await tx.tenant.update({ where: { id }, data: { plan } });
    if (rules.unverifiedCompanyAccess !== undefined) {
      await tx.tenant.update({
        where: { id },
        data: { unverifiedCompanyAccess: rules.unverifiedCompanyAccess },
      });
    }

    await markStep(tx, tenant, 'features');
  });

  return { enabled, added, plan };
}

/* -------------------------------------------------------------------------- */
/* Step 5 - people                                                             */
/* -------------------------------------------------------------------------- */

export async function adminRoles() {
  return prisma.platformRole.findMany({
    where: { scope: RoleScope.ADMIN, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, key: true, name: true, description: true },
  });
}

export async function inviteTenantAdmin(
  id: string,
  input: { fullName: string; email: string; phone?: string; roleId?: string; sendEmail: boolean },
  userId: string,
) {
  const tenant = await loadTenant(id);

  const role = input.roleId
    ? await prisma.platformRole.findUnique({ where: { id: input.roleId } })
    : await prisma.platformRole.findUnique({ where: { key: 'admin.super' } });
  if (!role || !role.isActive || role.scope !== RoleScope.ADMIN) {
    throw badRequest('Choose an operations role for this person.');
  }

  const { invite, token } = await createInvite({
    kind: InviteKind.ADMIN_MEMBER,
    email: input.email,
    invitedName: input.fullName,
    invitedPhone: input.phone || undefined,
    tenantId: id,
    roleId: role.id,
    sentById: userId,
  });
  const link = inviteLinkFor(token);

  let emailed: 'sent' | 'failed' | 'not asked' = 'not asked';
  let reason: string | undefined;
  if (input.sendEmail) {
    const mail = await sendInviteEmail({
      to: invite.email,
      name: input.fullName,
      link,
      role: role.name,
      where: tenant.name,
      expiresAt: invite.expiresAt,
      invitedBy: await senderName(userId),
      ...(await portalFor(id)),
    });
    emailed = mail.sent ? 'sent' : 'failed';
    if (!mail.sent) reason = mail.reason;
  }

  await prisma.$transaction((tx) => markStep(tx, tenant, 'people'));

  return {
    invite: { id: invite.id, email: invite.email, invitedName: invite.invitedName, roleName: role.name, expiresAt: invite.expiresAt },
    link,
    emailed,
    reason,
  };
}

export async function revokeTenantInvite(id: string, inviteId: string) {
  const invite = await prisma.invite.findFirst({ where: { id: inviteId, tenantId: id } });
  if (!invite) throw notFound('That invitation does not exist.');
  if (invite.acceptedAt) throw conflict('That invitation has already been accepted.');
  await prisma.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
}

/* -------------------------------------------------------------------------- */
/* The whole picture, and the checklist                                        */
/* -------------------------------------------------------------------------- */

export interface ChecklistItem {
  step: StepKey;
  label: string;
  done: boolean;
  required: boolean;
  detail: string;
}

async function readState(id: string) {
  const tenant = await loadTenant(id);

  const [programs, colleges, moduleRows, members, invites, batches] = await Promise.all([
    prisma.tenantProgram.findMany({
      where: { tenantId: id },
      include: {
        course: { select: { name: true } },
        specialisation: { select: { name: true } },
      },
    }),
    prisma.college.findMany({
      where: { tenantId: id },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { batches: true, candidates: true, programs: true } },
        members: {
          where: { role: { key: 'campus.officer' } },
          select: { user: { select: { fullName: true, email: true } } },
          take: 1,
        },
        invites: {
          where: { kind: InviteKind.CAMPUS_MEMBER, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { email: true, invitedName: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        batches: { select: { course: true } },
      },
    }),
    prisma.tenantModule.findMany({ where: { tenantId: id } }),
    prisma.adminMember.findMany({
      where: { tenantId: id },
      include: {
        user: { select: { id: true, fullName: true, email: true, lastLoginAt: true, isActive: true } },
        role: { select: { name: true } },
      },
    }),
    prisma.invite.findMany({
      where: {
        tenantId: id,
        kind: InviteKind.ADMIN_MEMBER,
        acceptedAt: null,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: { role: { select: { name: true } } },
    }),
    prisma.batch.findMany({
      where: { tenantId: id },
      orderBy: [{ collegeId: 'asc' }, { name: 'asc' }],
      include: {
        college: { select: { name: true, code: true } },
        _count: { select: { memberships: true } },
      },
    }),
  ]);

  // Programs grouped back into the shape the screen edits: a course and its branches.
  const grouped = new Map<string, { courseId: string; courseName: string; specialisationIds: string[] }>();
  for (const p of programs) {
    const g = grouped.get(p.courseId) ?? {
      courseId: p.courseId,
      courseName: p.course.name,
      specialisationIds: [],
    };
    if (p.specialisationId) g.specialisationIds.push(p.specialisationId);
    grouped.set(p.courseId, g);
  }

  const hasModuleRows = moduleRows.length > 0;
  const enabledModules = resolveModules(moduleRows.filter((m) => m.enabled).map((m) => m.moduleKey)).enabled;

  const state = {
    tenant: { ...tenant, completedSteps: stepsOf(tenant) },
    programs: [...grouped.values()],
    colleges: colleges.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      city: c.city,
      state: c.state,
      collegeTypeId: c.collegeTypeId,
      naacGrade: c.naacGrade,
      affiliation: c.affiliation,
      address: c.address,
      pincode: c.pincode,
      isVerified: c.isVerified,
      batches: c._count.batches,
      students: c._count.candidates,
      /** Course + branch pairs mapped to this college. */
      programs: c._count.programs,
      courses: [...new Set(c.batches.map((b) => b.course).filter(Boolean) as string[])],
      officer: c.members[0]
        ? { name: c.members[0].user.fullName, email: c.members[0].user.email, status: 'active' as const }
        : c.invites[0]
          ? { name: c.invites[0].invitedName, email: c.invites[0].email, status: 'invited' as const }
          : null,
    })),
    batches: batches.map((b) => ({
      id: b.id,
      name: b.name,
      collegeId: b.collegeId,
      college: b.college ? { name: b.college.name, code: b.college.code } : null,
      course: b.course,
      specialisation: b.specialisation,
      graduationYear: b.graduationYear,
      studyYear: b.studyYear,
      students: b._count.memberships,
    })),
    modules: hasModuleRows ? enabledModules : [],
    admins: [
      ...members.map((m) => ({
        kind: 'member' as const,
        id: m.user.id,
        fullName: m.user.fullName,
        email: m.user.email,
        roleName: m.role.name,
        lastLoginAt: m.user.lastLoginAt,
      })),
      ...invites.map((i) => ({
        kind: 'invite' as const,
        id: i.id,
        fullName: i.invitedName,
        email: i.email,
        roleName: i.role?.name ?? null,
        expiresAt: i.expiresAt,
        expired: i.expiresAt.getTime() < Date.now(),
      })),
    ],
  };

  return { state, hasModuleRows };
}

type State = Awaited<ReturnType<typeof readState>>['state'];

/** The whole onboarding picture, with the checklist that decides launch. */
export async function onboardingState(id: string) {
  const { state, hasModuleRows } = await readState(id);
  return { ...state, checklist: checklistFor(state, hasModuleRows) };
}

/**
 * What still stands between this tenant and going live.
 *
 * Pure, so the screen's checklist and the launch guard cannot disagree: both
 * are this function.
 */
export function checklistFor(state: State, hasModuleRows: boolean): ChecklistItem[] {
  const t = state.tenant;
  const collegeCount = state.colleges.length;
  const liveAdmins = state.admins.filter((a) => a.kind === 'member' || !('expired' in a && a.expired));
  const officers = state.colleges.filter((c) => c.officer).length;

  return [
    {
      step: 'identity',
      label: 'Institution details',
      done: Boolean(t.name && t.slug && t.contactEmail),
      required: true,
      detail: t.contactEmail ? `${t.name} · /${t.slug}` : 'Name, address and a contact person.',
    },
    {
      step: 'academics',
      label: 'Courses and grading',
      done: state.programs.length > 0,
      required: true,
      detail:
        state.programs.length > 0
          ? `${state.programs.length} course${state.programs.length === 1 ? '' : 's'}`
          : 'Pick or add at least one course the institution runs.',
    },
    {
      step: 'colleges',
      label: t.kind === TenantKind.COLLEGE ? 'The college' : 'Colleges',
      done: collegeCount > 0,
      required: true,
      detail:
        collegeCount > 0
          ? `${collegeCount} college${collegeCount === 1 ? '' : 's'} · ${officers} with a placement officer`
          : 'Add at least one college.',
    },
    {
      step: 'mapping',
      label: 'Courses mapped to colleges',
      done: state.colleges.some((c) => c.programs > 0) || t.completedSteps.includes('mapping'),
      required: false,
      detail: state.colleges.some((c) => c.programs > 0)
        ? `${state.colleges.filter((c) => c.programs > 0).length} of ${collegeCount} colleges mapped`
        : 'Optional - each college can pick its own courses once it signs in.',
    },
    {
      step: 'batches',
      label: 'Batches',
      done: state.batches.length > 0 || t.completedSteps.includes('batches'),
      required: false,
      detail:
        state.batches.length > 0
          ? `${state.batches.length} batch${state.batches.length === 1 ? '' : 'es'}`
          : 'Optional - placement cells can create their own.',
    },
    {
      step: 'features',
      label: 'Plan and modules',
      done: hasModuleRows,
      required: true,
      detail: hasModuleRows
        ? `${t.plan.toLowerCase()} · ${state.modules.length} modules`
        : 'Choose what this institution gets.',
    },
    {
      step: 'people',
      label: 'Institution admins',
      done: liveAdmins.length > 0,
      required: true,
      detail:
        liveAdmins.length > 0
          ? `${liveAdmins.length} admin${liveAdmins.length === 1 ? '' : 's'} invited or active`
          : 'Invite at least one person to run the portal.',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Launch, suspend, reactivate                                                 */
/* -------------------------------------------------------------------------- */

export async function launchTenant(id: string) {
  const state = await onboardingState(id);
  if (state.tenant.status !== TenantStatus.DRAFT) {
    throw conflict('This institution is already live.');
  }

  const missing = state.checklist.filter((c) => c.required && !c.done);
  if (missing.length > 0) {
    throw conflict(`Not ready yet: ${missing.map((m) => m.label.toLowerCase()).join(', ')}.`, {
      missing: missing.map((m) => m.step),
    });
  }

  return prisma.tenant.update({
    where: { id },
    data: {
      status: TenantStatus.ACTIVE,
      launchedAt: new Date(),
      completedSteps: [...STEP_KEYS],
    },
  });
}

export async function setTenantStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
  const tenant = await loadTenant(id);
  if (tenant.status === TenantStatus.DRAFT) {
    throw conflict('Launch this institution before changing whether it is live.');
  }
  return prisma.tenant.update({ where: { id }, data: { status } });
}
