import { ensureBranch } from '../modules/tenants/branches.js';
import { prisma, disconnectPrisma } from '../lib/prisma.js';

/**
 * Fills the course catalogue from the courses already in use.
 *
 * Course and branch were free text on batches and students before they were a
 * list operations keeps. Everything already recorded is therefore the real
 * catalogue, and inventing a different one would leave every existing batch
 * pointing at a course that is no longer offered.
 *
 * Idempotent: it adds what is missing and leaves what is there, so it can be
 * run after an import that brought in a course nobody had seen.
 */
async function main(): Promise<void> {
  const [batchCourses, candidateCourses, branches] = await Promise.all([
    prisma.batch.findMany({
      where: { course: { not: null } },
      select: { course: true, specialisation: true },
    }),
    prisma.candidate.findMany({
      where: { course: { not: null } },
      select: { course: true, specialisation: true },
    }),
    prisma.candidate.findMany({
      where: { specialisation: { not: null } },
      select: { course: true, specialisation: true },
    }),
  ]);

  const rows = [...batchCourses, ...candidateCourses, ...branches];
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);

  const courseNames = [...new Set(rows.map((r) => clean(r.course)).filter(Boolean))] as string[];

  let addedCourses = 0;
  for (const name of courseNames.sort()) {
    const existing = await prisma.course.findFirst({ where: { name } });
    if (!existing) {
      await prisma.course.create({ data: { name } });
      addedCourses++;
    }
  }

  const courses = new Map((await prisma.course.findMany()).map((c) => [c.name, c.id]));

  // A branch is kept against the course it was seen with, so the branch list
  // can later be narrowed to whatever course somebody picked.
  const pairs = new Map<string, { name: string; courseId: string | null }>();
  for (const row of rows) {
    const name = clean(row.specialisation);
    if (!name) continue;
    const courseId = courses.get(clean(row.course) ?? '') ?? null;
    pairs.set(`${name}::${courseId ?? ''}`, { name, courseId });
  }

  let addedBranches = 0;
  for (const { name, courseId } of pairs.values()) {
    const existing = await prisma.specialisation.findFirst({ where: { name, courseId } });
    if (!existing) {
      const master = await ensureBranch(prisma, name);
      await prisma.specialisation.create({ data: { name: master.name, courseId, branchId: master.id } });
      addedBranches++;
    }
  }

  console.log(`Courses: ${addedCourses} added, ${courses.size} in the catalogue.`);
  console.log(`Branches: ${addedBranches} added, ${pairs.size} seen in the data.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
