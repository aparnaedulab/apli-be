import { InviteKind, TenantKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { portalFor, sendInviteEmail } from '../invites/invite.mail.js';
import { academicYearLabel, deriveBatchName } from '../campus/batch.schemas.js';
import { loadTenant, markStepById, officerRole, senderName } from './onboarding.service.js';
import type { BatchesInput, CollegeInput } from './onboarding.schemas.js';

/**
 * Steps three and four of onboarding: the colleges, one at a time, and then
 * the batches inside them.
 *
 * Colleges are added through a form, one per save, so each is checked as it
 * is entered - a clashing code is caught on that college, not buried in a
 * list of forty. Batches come after, as their own step, because a batch
 * names a college and a course and both must exist first.
 */

const nil = (v: string | undefined | null) => (v ? v : null);

/* -------------------------------------------------------------------------- */
/* Colleges                                                                    */
/* -------------------------------------------------------------------------- */

/** What the college is affiliated to, written onto the row. */
function affiliationFor(tenantName: string, input: CollegeInput): string | null {
  if (input.affiliation === 'THIS_UNIVERSITY') return tenantName;
  if (input.affiliation === 'OTHER') return nil(input.affiliationName);
  return null; // autonomous
}

async function assertCodeFree(code: string, exceptId?: string) {
  const clash = await prisma.college.findFirst({
    where: { code, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { tenantId: true, name: true },
  });
  if (clash) {
    // Never name another institution's college: the code is taken, that is all
    // this tenant needs to know.
    throw conflict(`The code ${code} is already used by another college on the platform.`, { field: 'code' });
  }
}

async function assertTypeUsable(id: string | undefined) {
  if (!id) return;
  const type = await prisma.collegeType.findUnique({ where: { id } });
  if (!type || !type.isActive) throw badRequest('Choose a college type from the list.', { field: 'collegeTypeId' });
}

async function ownCollege(tenantId: string, collegeId: string) {
  const college = await prisma.college.findFirst({ where: { id: collegeId, tenantId } });
  if (!college) throw notFound('That college does not belong to this institution.');
  return college;
}

/**
 * Invites the college's placement officer, unless they are already there or
 * already invited. Reported rather than thrown: the college is saved either
 * way, and a mail server that is down costs a copied link, not a college.
 */
async function inviteOfficer(
  college: { id: string; name: string; tenantId: string },
  name: string | undefined,
  email: string | undefined,
  userId: string,
) {
  if (!email) return null;

  const member = await prisma.campusMember.findFirst({
    where: { collegeId: college.id, user: { email } },
    select: { id: true },
  });
  if (member) return { email, status: 'active' as const };

  const pending = await prisma.invite.findFirst({
    where: { collegeId: college.id, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (pending) return { email, status: 'already invited' as const };

  try {
    const role = await officerRole();
    const { invite, token } = await createInvite({
      kind: InviteKind.CAMPUS_MEMBER,
      email,
      invitedName: name,
      collegeId: college.id,
      roleId: role.id,
      sentById: userId,
    });
    const link = inviteLinkFor(token);
    const mail = await sendInviteEmail({
      to: email,
      name: name ?? '',
      link,
      role: role.name,
      where: college.name,
      expiresAt: invite.expiresAt,
      invitedBy: await senderName(userId),
      ...(await portalFor(college.tenantId)),
    });
    return { email, status: mail.sent ? ('emailed' as const) : ('link' as const), link };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return { email, status: 'failed' as const, note: err.message };
  }
}

function collegeData(tenantName: string, input: CollegeInput) {
  return {
    name: input.name,
    code: input.code,
    collegeTypeId: nil(input.collegeTypeId),
    affiliation: affiliationFor(tenantName, input),
    city: input.city,
    state: input.state,
    address: nil(input.address),
    pincode: nil(input.pincode),
    naacGrade: nil(input.naacGrade),
    isVerified: input.isVerified,
  };
}

export async function createCollege(tenantId: string, input: CollegeInput, userId: string) {
  const tenant = await loadTenant(tenantId);
  if (tenant.kind === TenantKind.COLLEGE && (await prisma.college.count({ where: { tenantId } })) > 0) {
    throw conflict('A single-college institution has exactly one college. Edit it instead.');
  }
  await assertCodeFree(input.code);
  await assertTypeUsable(input.collegeTypeId || undefined);

  const college = await prisma.college.create({ data: { ...collegeData(tenant.name, input), tenantId } });
  await markStepById(tenantId, 'colleges');
  const officer = await inviteOfficer(college, input.officerName || undefined, input.officerEmail || undefined, userId);
  return { college: { id: college.id, name: college.name }, officer };
}

export async function updateCollege(tenantId: string, collegeId: string, input: CollegeInput, userId: string) {
  const tenant = await loadTenant(tenantId);
  await ownCollege(tenantId, collegeId);
  await assertCodeFree(input.code, collegeId);
  await assertTypeUsable(input.collegeTypeId || undefined);

  const college = await prisma.college.update({ where: { id: collegeId }, data: collegeData(tenant.name, input) });
  const officer = await inviteOfficer(college, input.officerName || undefined, input.officerEmail || undefined, userId);
  return { college: { id: college.id, name: college.name }, officer };
}

/** Only an empty college - a typo, a duplicate - may simply go. */
export async function deleteCollege(tenantId: string, collegeId: string) {
  const college = await ownCollege(tenantId, collegeId);
  const inUse = await prisma.college.findFirst({
    where: {
      id: collegeId,
      OR: [{ candidates: { some: {} } }, { members: { some: {} } }, { placements: { some: {} } }],
    },
    select: { id: true },
  });
  if (inUse) throw conflict(`${college.name} already has students, staff or drives, so it stays.`);
  await prisma.college.delete({ where: { id: collegeId } });
}

/* -------------------------------------------------------------------------- */
/* Batches                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Creates one batch, or the same batch in several colleges at once.
 *
 * University-wide ("2026 Batch" across every college) is one batch with no
 * college. Otherwise one batch per chosen college. The name is the one typed,
 * or built from the course, branch and year - "B.Tech Computer Engineering
 * 2026" - and a college that already has a batch of that name is skipped and
 * reported, never given a duplicate.
 */
export async function createBatches(tenantId: string, input: BatchesInput) {
  await loadTenant(tenantId);

  const colleges =
    input.scope === 'UNIVERSITY'
      ? []
      : await prisma.college.findMany({
          where: {
            tenantId,
            ...(input.scope === 'SOME_COLLEGES' ? { id: { in: input.collegeIds } } : {}),
          },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });

  if (input.scope === 'SOME_COLLEGES' && colleges.length !== new Set(input.collegeIds).size) {
    throw notFound('One of those colleges does not belong to this institution.');
  }
  if (input.scope !== 'UNIVERSITY' && colleges.length === 0) {
    throw badRequest('Choose at least one college for this batch.');
  }

  const name =
    input.name ||
    deriveBatchName(
      {
        course: input.course || undefined,
        specialisation: input.specialisation || undefined,
        graduationYear: input.graduationYear,
        studyYear: input.studyYear,
      },
      1,
    );

  const fields = {
    name,
    course: nil(input.course),
    specialisation: nil(input.specialisation),
    graduationYear: input.graduationYear ?? null,
    studyYear: input.studyYear ?? null,
    headOfDept: nil(input.headOfDept),
    tenantId,
  };

  const created: { id: string; name: string; college: string | null }[] = [];
  const skipped: { name: string; college: string | null }[] = [];

  if (input.scope === 'UNIVERSITY') {
    // MySQL lets NULL repeat in a unique index, so the clash is checked here.
    const hit = await prisma.batch.findFirst({ where: { tenantId, collegeId: null, name } });
    if (hit) skipped.push({ name, college: null });
    else {
      const b = await prisma.batch.create({ data: { ...fields, collegeId: null } });
      created.push({ id: b.id, name: b.name, college: null });
    }
  } else {
    for (const c of colleges) {
      const hit = await prisma.batch.findFirst({ where: { collegeId: c.id, name } });
      if (hit) {
        skipped.push({ name, college: c.name });
        continue;
      }
      const b = await prisma.batch.create({ data: { ...fields, collegeId: c.id } });
      created.push({ id: b.id, name: b.name, college: c.name });
    }
  }

  if (created.length > 0) await markStepById(tenantId, 'batches');
  return { created, skipped };
}

/** Only a batch nobody is in yet, and no drive uses. */
export async function deleteBatch(tenantId: string, batchId: string) {
  const batch = await prisma.batch.findFirst({
    where: { id: batchId, tenantId },
    include: { _count: { select: { memberships: true, placements: true } } },
  });
  if (!batch) throw notFound('That batch does not belong to this institution.');
  if (batch._count.memberships > 0 || batch._count.placements > 0) {
    throw conflict(`${batch.name} already has students or a drive, so it stays.`);
  }
  await prisma.batch.delete({ where: { id: batchId } });
}

/**
 * Batches from the mapping: one per college, per course and branch it runs,
 * per passing year - "B.E. Computer Engineering 2026-2027" in PICT.
 *
 * This is the grain a placement cell actually works at: drives, eligibility
 * and reports are all per branch per passing year. Anything that already
 * exists by that name in that college is skipped, so running it again for a
 * new year, or after mapping another college, only adds what is missing.
 */
export async function createBatchesFromMapping(
  tenantId: string,
  input: { graduationYears: number[]; collegeIds?: string[] },
) {
  await loadTenant(tenantId);
  const programs = await prisma.collegeProgram.findMany({
    where: {
      college: { tenantId },
      ...(input.collegeIds?.length ? { collegeId: { in: input.collegeIds } } : {}),
    },
    select: {
      collegeId: true,
      college: { select: { name: true } },
      course: { select: { name: true } },
      specialisation: { select: { name: true } },
    },
  });
  if (programs.length === 0) {
    throw badRequest('No courses are mapped to those colleges yet. Map them first, in the step before this one.');
  }

  const created: { id: string; name: string; college: string | null }[] = [];
  const skipped: { name: string; college: string | null }[] = [];

  for (const year of [...new Set(input.graduationYears)].sort()) {
    for (const p of programs) {
      const course = p.course.name;
      const branch = p.specialisation?.name ?? null;
      const name = [course, branch, academicYearLabel(year)].filter(Boolean).join(' ').slice(0, 120);

      const hit = await prisma.batch.findFirst({ where: { collegeId: p.collegeId, name }, select: { id: true } });
      if (hit) {
        skipped.push({ name, college: p.college.name });
        continue;
      }
      const b = await prisma.batch.create({
        data: { tenantId, collegeId: p.collegeId, name, course, specialisation: branch, graduationYear: year },
      });
      created.push({ id: b.id, name: b.name, college: p.college.name });
    }
  }

  if (created.length > 0) await markStepById(tenantId, 'batches');
  return { created, skipped };
}
