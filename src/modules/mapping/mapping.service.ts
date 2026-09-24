import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { inTenant } from '../tenants/tenant.context.js';
import { UNASSIGNED } from '../campus/students.service.js';

/**
 * Map data: tying the lists the university onboarded to each other.
 *
 * Colleges, courses, branches and students are each added on their own, in
 * whatever order the university has them. Mapping is the second pass that
 * says how they fit together:
 *
 *   college  ->  the course + branch pairs it runs (CollegeProgram)
 *   student  ->  one of those pairs (Candidate.collegeProgramId)
 *
 * The university does it for any of its colleges; a college does it for
 * itself, choosing only from what the university offers.
 *
 * A student's `course` and `specialisation` names are written alongside the
 * link, because every eligibility check in the product reads those names.
 * The link is what says the pair is real at this college; the names are what
 * the rest of the product already understands.
 */

/* -------------------------------------------------------------------------- */
/* What a college may choose from                                              */
/* -------------------------------------------------------------------------- */

export interface OfferedCourse {
  id: string;
  name: string;
  branches: { id: string; name: string }[];
}

/**
 * The courses and branches the university offers.
 *
 * TenantProgram is the university's own selection; a row with no branch means
 * the whole course, every branch of it. A university that has not made a
 * selection yet is offered the shared catalogue, and `fromCatalogue` says so,
 * so a screen can nudge somebody to narrow it.
 */
export async function offeredPrograms(
  tenantId: string,
): Promise<{ courses: OfferedCourse[]; fromCatalogue: boolean }> {
  const selection = await prisma.tenantProgram.findMany({
    where: { tenantId },
    select: { courseId: true, specialisationId: true },
  });

  const courses = await prisma.course.findMany({
    where: selection.length
      ? { id: { in: [...new Set(selection.map((s) => s.courseId))] } }
      : { isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      specialisations: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      },
    },
  });

  if (selection.length === 0) {
    return {
      courses: courses.map((c) => ({ id: c.id, name: c.name, branches: c.specialisations })),
      fromCatalogue: true,
    };
  }

  const whole = new Set(selection.filter((s) => !s.specialisationId).map((s) => s.courseId));
  const chosen = new Set(selection.map((s) => s.specialisationId).filter(Boolean));

  return {
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      branches: whole.has(c.id)
        ? c.specialisations
        : c.specialisations.filter((b) => chosen.has(b.id)),
    })),
    fromCatalogue: false,
  };
}

/* -------------------------------------------------------------------------- */
/* A college's programmes                                                      */
/* -------------------------------------------------------------------------- */

export async function collegeOf(tenantId: string, collegeId: string) {
  const college = await prisma.college.findFirst({
    where: { id: collegeId, ...inTenant.college(tenantId) },
    select: { id: true, name: true, code: true },
  });
  if (!college) throw notFound('No such college.');
  return college;
}

export async function collegePrograms(collegeId: string) {
  const programs = await prisma.collegeProgram.findMany({
    where: { collegeId },
    select: {
      id: true,
      intake: true,
      course: { select: { id: true, name: true } },
      specialisation: { select: { id: true, name: true } },
      _count: { select: { candidates: true } },
    },
  });

  return programs
    .map((p) => ({
      id: p.id,
      courseId: p.course.id,
      course: p.course.name,
      branchId: p.specialisation?.id ?? null,
      branch: p.specialisation?.name ?? null,
      intake: p.intake,
      students: p._count.candidates,
    }))
    .sort((a, z) => a.course.localeCompare(z.course) || (a.branch ?? '').localeCompare(z.branch ?? ''));
}

export interface ProgramChoice {
  courseId: string;
  branchId: string | null;
  intake?: number | null;
}

const choiceKey = (c: { courseId: string; branchId: string | null }) => `${c.courseId}|${c.branchId ?? ''}`;

/**
 * Replaces the set of programmes a college runs.
 *
 * Every choice must be something the university offers, and a course that has
 * branches is chosen branch by branch - "B.E." on its own says nothing a
 * recruiter can filter on. Nothing with students in it is removed: those
 * students would be left pointing at a programme the college no longer runs.
 *
 * Students already at the college whose course and branch names match a newly
 * added programme are linked to it straight away. That is how a college whose
 * roster was uploaded before any mapping existed gets mapped in one save.
 */
export async function setCollegePrograms(tenantId: string, collegeId: string, choices: ProgramChoice[]) {
  const { courses } = await offeredPrograms(tenantId);
  const byCourse = new Map(courses.map((c) => [c.id, c]));

  const wanted = new Map<string, ProgramChoice>();
  for (const choice of choices) {
    const course = byCourse.get(choice.courseId);
    if (!course) throw badRequest('One of those courses is not offered by the university.');

    if (choice.branchId) {
      if (!course.branches.some((b) => b.id === choice.branchId)) {
        throw badRequest(`A branch was chosen that the university does not offer under ${course.name}.`);
      }
    } else if (course.branches.length > 0) {
      throw badRequest(`Choose which branches of ${course.name} this college runs.`);
    }
    wanted.set(choiceKey(choice), choice);
  }

  const existing = await collegePrograms(collegeId);
  const current = new Map(existing.map((p) => [choiceKey({ courseId: p.courseId, branchId: p.branchId }), p]));

  const removing = existing.filter((p) => !wanted.has(choiceKey({ courseId: p.courseId, branchId: p.branchId })));
  const blocked = removing.filter((p) => p.students > 0);
  if (blocked.length > 0) {
    const names = blocked.map((p) => `${p.course}${p.branch ? ` – ${p.branch}` : ''} (${p.students})`);
    throw conflict(
      `Students are still mapped to ${names.join(', ')}. Move or unmap them first, then remove the programme.`,
    );
  }

  const adding = [...wanted.entries()].filter(([k]) => !current.has(k)).map(([, v]) => v);
  const keeping = [...wanted.entries()].filter(([k]) => current.has(k));

  await prisma.$transaction(async (tx) => {
    if (removing.length > 0) {
      await tx.collegeProgram.deleteMany({ where: { id: { in: removing.map((p) => p.id) } } });
    }
    for (const [key, choice] of keeping) {
      const row = current.get(key)!;
      if (choice.intake !== undefined && choice.intake !== row.intake) {
        await tx.collegeProgram.update({ where: { id: row.id }, data: { intake: choice.intake } });
      }
    }
    for (const choice of adding) {
      const created = await tx.collegeProgram.create({
        data: {
          collegeId,
          courseId: choice.courseId,
          specialisationId: choice.branchId,
          intake: choice.intake ?? null,
        },
        select: { id: true, course: { select: { name: true } }, specialisation: { select: { name: true } } },
      });

      // Students uploaded with this course and branch already written on them.
      await tx.candidate.updateMany({
        where: {
          collegeId,
          collegeProgramId: null,
          course: created.course.name,
          ...(created.specialisation
            ? { specialisation: created.specialisation.name }
            : { OR: [{ specialisation: null }, { specialisation: '' }] }),
        },
        data: { collegeProgramId: created.id },
      });
    }
  });

  return collegePrograms(collegeId);
}

/* -------------------------------------------------------------------------- */
/* The whole university at a glance                                            */
/* -------------------------------------------------------------------------- */

export async function mappingOverview(tenantId: string) {
  const [colleges, programCounts, studentCounts, mappedCounts, unplaced] = await Promise.all([
    prisma.college.findMany({
      where: inTenant.college(tenantId),
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, city: true },
    }),
    prisma.collegeProgram.groupBy({
      by: ['collegeId'],
      where: { college: inTenant.college(tenantId) },
      _count: { _all: true },
    }),
    prisma.candidate.groupBy({
      by: ['collegeId'],
      where: { college: inTenant.college(tenantId) },
      _count: { _all: true },
    }),
    prisma.candidate.groupBy({
      by: ['collegeId'],
      where: { college: inTenant.college(tenantId), collegeProgramId: { not: null } },
      _count: { _all: true },
    }),
    // Students the university added without saying which college.
    prisma.candidate.count({ where: { ...inTenant.candidate(tenantId), collegeId: null } }),
  ]);

  const count = (rows: { collegeId: string | null; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.collegeId, r._count._all]));
  const programs = count(programCounts);
  const students = count(studentCounts);
  const mapped = count(mappedCounts);

  return {
    colleges: colleges.map((c) => ({
      ...c,
      programs: programs.get(c.id) ?? 0,
      students: students.get(c.id) ?? 0,
      mapped: mapped.get(c.id) ?? 0,
    })),
    unplacedStudents: unplaced,
  };
}

/* -------------------------------------------------------------------------- */
/* Students                                                                    */
/* -------------------------------------------------------------------------- */

export interface StudentQuery {
  collegeId?: string;
  programId?: string;
  /** Unmapped: not in any programme yet. */
  status: 'mapped' | 'unmapped' | 'all';
  /** Also list students the university has not placed in any college. */
  includeUnplaced?: boolean;
  q?: string;
  page: number;
  pageSize: number;
}

export async function listStudents(tenantId: string, query: StudentQuery) {
  const and: Prisma.CandidateWhereInput[] = [inTenant.candidate(tenantId)];

  if (query.collegeId) {
    and.push(
      query.includeUnplaced
        ? { OR: [{ collegeId: query.collegeId }, { collegeId: null }] }
        : { collegeId: query.collegeId },
    );
  } else if (query.includeUnplaced) {
    and.push({ collegeId: null });
  }
  if (query.programId) and.push({ collegeProgramId: query.programId });
  if (query.status === 'mapped') and.push({ collegeProgramId: { not: null } });
  if (query.status === 'unmapped') and.push({ collegeProgramId: null });
  if (query.q) {
    and.push({
      OR: [
        { user: { fullName: { contains: query.q } } },
        { user: { email: { contains: query.q } } },
        { prn: { contains: query.q } },
      ],
    });
  }

  const where: Prisma.CandidateWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    prisma.candidate.count({ where }),
    prisma.candidate.findMany({
      where,
      orderBy: [{ user: { fullName: 'asc' } }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        prn: true,
        course: true,
        specialisation: true,
        graduationYear: true,
        collegeProgramId: true,
        user: { select: { fullName: true, email: true } },
        college: { select: { id: true, name: true, code: true } },
        batchMemberships: { select: { rollNo: true, batch: { select: { name: true } } } },
      },
    }),
  ]);

  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    rows: rows.map((c) => ({
      id: c.id,
      name: c.user.fullName,
      email: c.user.email,
      prn: c.prn,
      rollNo: c.batchMemberships.find((m) => m.rollNo)?.rollNo ?? null,
      batches: c.batchMemberships.map((m) => m.batch.name),
      graduationYear: c.graduationYear,
      college: c.college,
      course: c.course,
      branch: c.specialisation,
      programId: c.collegeProgramId,
    })),
  };
}

export interface MapResult {
  mapped: number;
  skipped: { name: string; reason: string }[];
}

/**
 * Puts students into one programme of one college.
 *
 * A student the university had not placed in any college joins this one, and
 * moves from the university's holding batch into the college's own
 * "Unassigned" batch, so they appear on the college's roster straight away.
 * A student who already belongs to a different college is refused: moving
 * somebody between colleges is a transfer, not a mapping.
 *
 * `ownCollegeOnly` is how a college calls this - it may map its own students
 * and nobody else's, including the university's unplaced ones.
 */
export async function mapStudents(
  tenantId: string,
  programId: string,
  candidateIds: string[],
  options: { ownCollegeOnly?: string } = {},
): Promise<MapResult> {
  const program = await prisma.collegeProgram.findFirst({
    where: {
      id: programId,
      college: inTenant.college(tenantId),
      ...(options.ownCollegeOnly ? { collegeId: options.ownCollegeOnly } : {}),
    },
    select: {
      id: true,
      collegeId: true,
      college: { select: { name: true } },
      course: { select: { name: true } },
      specialisation: { select: { name: true } },
    },
  });
  if (!program) throw notFound('No such programme at this college.');
  const target = program; // narrowed, for the helper below

  const students = await prisma.candidate.findMany({
    where: { id: { in: candidateIds }, ...inTenant.candidate(tenantId) },
    select: {
      id: true,
      collegeId: true,
      graduationYear: true,
      user: { select: { fullName: true } },
      college: { select: { name: true } },
      batchMemberships: {
        select: { id: true, rollNo: true, division: true, batch: { select: { id: true, collegeId: true, name: true } } },
      },
    },
  });

  const result: MapResult = { mapped: 0, skipped: [] };
  const found = new Set(students.map((s) => s.id));
  for (const id of candidateIds) {
    if (!found.has(id)) result.skipped.push({ name: id, reason: 'No such student' });
  }

  let collegeHolding: { id: string } | null = null;

  for (const s of students) {
    if (s.collegeId && s.collegeId !== program.collegeId) {
      result.skipped.push({ name: s.user.fullName, reason: `Belongs to ${s.college?.name ?? 'another college'}` });
      continue;
    }
    if (!s.collegeId && options.ownCollegeOnly) {
      result.skipped.push({ name: s.user.fullName, reason: 'Not a student of this college' });
      continue;
    }

    try {
      await mapOne(s);
      result.mapped++;
    } catch (err) {
      collegeHolding = null; // it may have been made in the transaction that failed
      result.skipped.push({
        name: s.user.fullName,
        reason: err instanceof Error ? err.message : 'Could not map this student',
      });
    }
  }

  return result;

  async function mapOne(s: (typeof students)[number]) {
    await prisma.$transaction(async (tx) => {
      await tx.candidate.update({
        where: { id: s.id },
        data: {
          collegeId: target.collegeId,
          collegeProgramId: target.id,
          course: target.course.name,
          specialisation: target.specialisation?.name ?? null,
        },
      });

      // Their batch - this course and branch, their passing year - if the
      // college has one. That is the "later mapped to students" half of
      // creating batches from the mapping.
      const own = s.graduationYear
        ? await tx.batch.findFirst({
            where: {
              collegeId: target.collegeId,
              course: target.course.name,
              specialisation: target.specialisation?.name ?? null,
              graduationYear: s.graduationYear,
            },
            select: { id: true },
          })
        : null;
      if (own && !s.batchMemberships.some((m) => m.batch.id === own.id)) {
        const holding = s.batchMemberships.find((m) => m.batch.name === UNASSIGNED);
        await tx.batchMembership.create({
          data: { batchId: own.id, candidateId: s.id, division: holding?.division ?? null },
        });
        // Out of the holding batch now they are somewhere real.
        if (holding) await tx.batchMembership.delete({ where: { id: holding.id } });
        return;
      }

      if (s.collegeId) return;

      // Joining a college: onto its roster, off the university's holding list.
      const inCollegeBatch = s.batchMemberships.some((m) => m.batch.collegeId === target.collegeId);
      if (!inCollegeBatch) {
        collegeHolding ??=
          (await tx.batch.findFirst({
            where: { collegeId: target.collegeId, name: UNASSIGNED },
            select: { id: true },
          })) ??
          (await tx.batch.create({
            data: { collegeId: target.collegeId, tenantId, name: UNASSIGNED },
            select: { id: true },
          }));

        const holding = s.batchMemberships.find((m) => !m.batch.collegeId && m.batch.name === UNASSIGNED);
        const rollFree =
          holding?.rollNo &&
          !(await tx.batchMembership.findFirst({
            where: { batchId: collegeHolding.id, rollNo: holding.rollNo },
            select: { id: true },
          }));

        await tx.batchMembership.create({
          data: {
            batchId: collegeHolding.id,
            candidateId: s.id,
            rollNo: rollFree ? holding!.rollNo : null,
            division: holding?.division ?? null,
          },
        });
        if (holding) await tx.batchMembership.delete({ where: { id: holding.id } });
      }
    });
  }
}

/** Takes students out of their programme. They stay at their college. */
export async function unmapStudents(
  tenantId: string,
  candidateIds: string[],
  options: { ownCollegeOnly?: string } = {},
): Promise<{ unmapped: number }> {
  const { count } = await prisma.candidate.updateMany({
    where: {
      AND: [
        { id: { in: candidateIds } },
        inTenant.candidate(tenantId),
        options.ownCollegeOnly ? { collegeId: options.ownCollegeOnly } : {},
      ],
    },
    data: { collegeProgramId: null },
  });
  return { unmapped: count };
}

/* -------------------------------------------------------------------------- */
/* The university's own courses and branches                                   */
/* -------------------------------------------------------------------------- */

/** Every active course and branch on the platform - what a university picks from. */
export async function catalogue(): Promise<OfferedCourse[]> {
  const courses = await prisma.course.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      specialisations: { where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } },
    },
  });
  return courses.map((c) => ({ id: c.id, name: c.name, branches: c.specialisations }));
}

/**
 * What the university runs, one row per course + branch, each with how many
 * of its colleges run it. Shaped like a college's programmes so one editor
 * serves both; `students` here counts colleges, which is what locks a row.
 */
export async function universityPrograms(tenantId: string) {
  const [{ courses, fromCatalogue }, used] = await Promise.all([
    offeredPrograms(tenantId),
    prisma.collegeProgram.groupBy({
      by: ['courseId', 'specialisationId'],
      where: { college: inTenant.college(tenantId) },
      _count: { _all: true },
    }),
  ]);
  const colleges = new Map(used.map((u) => [choiceKey({ courseId: u.courseId, branchId: u.specialisationId }), u._count._all]));

  if (fromCatalogue) return [];
  return courses.flatMap((c) =>
    (c.branches.length ? c.branches : [null]).map((b) => ({
      id: choiceKey({ courseId: c.id, branchId: b?.id ?? null }),
      courseId: c.id,
      course: c.name,
      branchId: b?.id ?? null,
      branch: b?.name ?? null,
      intake: null,
      students: colleges.get(choiceKey({ courseId: c.id, branchId: b?.id ?? null })) ?? 0,
    })),
  );
}

/**
 * Replaces the university's courses and branches. Anything a college already
 * runs stays: removing it would leave that college running something the
 * university no longer offers.
 */
export async function setUniversityPrograms(tenantId: string, choices: ProgramChoice[]) {
  const all = await catalogue();
  const byCourse = new Map(all.map((c) => [c.id, c]));
  const wanted = new Map<string, ProgramChoice>();

  for (const choice of choices) {
    const course = byCourse.get(choice.courseId);
    if (!course) throw badRequest('One of those courses is not on the list any more. Reload and try again.');
    if (choice.branchId && !course.branches.some((b) => b.id === choice.branchId)) {
      throw badRequest(`A branch was chosen that ${course.name} does not have.`);
    }
    if (!choice.branchId && course.branches.length > 0) {
      throw badRequest(`Choose which branches of ${course.name} the university runs.`);
    }
    wanted.set(choiceKey(choice), choice);
  }

  const inUse = (await universityPrograms(tenantId)).filter((p) => p.students > 0 && !wanted.has(p.id));
  if (inUse.length > 0) {
    const names = inUse.map((p) => `${p.course}${p.branch ? ` – ${p.branch}` : ''}`);
    throw conflict(`Colleges still run ${names.join(', ')}. Take it off those colleges first.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.tenantProgram.deleteMany({ where: { tenantId } });
    if (wanted.size > 0) {
      await tx.tenantProgram.createMany({
        data: [...wanted.values()].map((c) => ({
          tenantId,
          courseId: c.courseId,
          specialisationId: c.branchId,
        })),
      });
    }
  });

  return universityPrograms(tenantId);
}

/**
 * Everything mapped so far, across the university: each college, the courses
 * it runs, the branches under each, and how many students are in each.
 */
export async function mappingSummary(tenantId: string) {
  const rows = await prisma.collegeProgram.findMany({
    where: { college: inTenant.college(tenantId) },
    select: {
      id: true,
      intake: true,
      college: { select: { id: true, name: true, code: true } },
      course: { select: { name: true } },
      specialisation: { select: { name: true } },
      _count: { select: { candidates: true } },
    },
  });

  const colleges = new Map<
    string,
    {
      id: string;
      name: string;
      code: string;
      courses: Map<string, { branch: string | null; students: number; intake: number | null }[]>;
    }
  >();
  for (const r of rows) {
    const c = colleges.get(r.college.id) ?? { ...r.college, courses: new Map() };
    const list = c.courses.get(r.course.name) ?? [];
    list.push({ branch: r.specialisation?.name ?? null, students: r._count.candidates, intake: r.intake });
    c.courses.set(r.course.name, list);
    colleges.set(r.college.id, c);
  }

  return [...colleges.values()]
    .sort((a, z) => a.name.localeCompare(z.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      courses: [...c.courses.entries()]
        .sort(([a], [z]) => a.localeCompare(z))
        .map(([course, branches]) => ({
          course,
          branches: branches.sort((a, z) => (a.branch ?? '').localeCompare(z.branch ?? '')),
        })),
    }));
}
