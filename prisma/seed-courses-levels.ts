/**
 * The course list, filled in for every level of study.
 *
 *   npx tsx prisma/seed-courses-levels.ts      (or npm run db:seed:courses-levels)
 *
 * Sign-up asks for a level (Diploma, Undergraduate, Postgraduate, PhD) and then
 * offers the courses of that level, and for a course its branches. This adds
 * the common Indian courses at each level, with how long they run and their
 * usual branches, so no level is empty.
 *
 * Safe to run again: courses are matched by name and branches by name within
 * the course; anything already there is kept, and nothing is removed.
 */
import { StudyLevel } from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';

/** Course -> level, years, branches. */
const CATALOGUE: [string, StudyLevel, number, string[]][] = [
  // Diploma
  ['Diploma in Engineering', 'DIPLOMA', 3, ['Computer Engineering', 'Information Technology', 'Mechanical Engineering', 'Civil', 'Electrical', 'Electronics and Telecommunication', 'Automobile Engineering']],
  ['D.Pharm', 'DIPLOMA', 2, ['Pharmacy']],
  ['Diploma in Computer Applications', 'DIPLOMA', 1, ['Computer Applications']],
  ['Diploma in Hotel Management', 'DIPLOMA', 3, ['Hospitality']],
  ['Diploma in Architecture', 'DIPLOMA', 3, ['Architecture']],

  // Undergraduate
  ['B.Tech', 'UG', 4, ['Computer Science', 'Information Technology', 'Electronics and Telecommunication', 'Electrical', 'Mechanical Engineering', 'Civil', 'Artificial Intelligence and Machine Learning', 'Data Science', 'Artificial Intelligence and Data Science', 'Chemical Engineering']],
  ['B.E.', 'UG', 4, ['Computer Science', 'Computer Engineering', 'Information Technology', 'Electronics and Telecommunication', 'Electrical', 'Mechanical Engineering', 'Civil', 'Artificial Intelligence and Data Science', 'Instrumentation']],
  ['B.Sc', 'UG', 3, ['Computer Science', 'Data Science', 'Physics', 'Chemistry', 'Mathematics', 'Statistics', 'Biotechnology', 'Microbiology']],
  ['B.Com', 'UG', 3, ['Accounting and Finance', 'Banking and Insurance', 'Taxation', 'General']],
  ['BCA', 'UG', 3, ['Computer Applications', 'Data Science', 'Cloud Computing']],
  ['BBA', 'UG', 3, ['Finance', 'Marketing', 'Human Resources', 'International Business']],
  ['BMS', 'UG', 3, ['Finance', 'Marketing', 'Human Resources']],
  ['B.A.', 'UG', 3, ['Economics', 'English', 'Psychology', 'Political Science', 'History', 'Sociology']],
  ['B.Pharm', 'UG', 4, ['Pharmacy']],
  ['B.Arch', 'UG', 5, ['Architecture']],
  ['B.Des', 'UG', 4, ['Product Design', 'Communication Design', 'Fashion Design', 'UX Design']],
  ['B.A. LL.B', 'UG', 5, ['Law']],
  ['BBA LL.B', 'UG', 5, ['Law']],

  // Postgraduate
  ['M.Tech', 'PG', 2, ['Computer Science', 'Electronics and Telecommunication', 'Data Science', 'Mechanical Engineering', 'Artificial Intelligence and Machine Learning', 'Civil']],
  ['M.E.', 'PG', 2, ['Computer Engineering', 'Electronics and Telecommunication', 'Mechanical Engineering', 'Civil', 'Electrical']],
  ['MCA', 'PG', 2, ['Computer Science', 'Data Science', 'Cloud Computing']],
  ['MBA', 'PG', 2, ['Finance', 'Marketing', 'Human Resources', 'Operations', 'Business Analytics', 'International Business', 'Information Technology']],
  ['PGDM', 'PG', 2, ['Finance', 'Marketing', 'Human Resources', 'Operations', 'Business Analytics']],
  ['M.Sc', 'PG', 2, ['Computer Science', 'Data Science', 'Physics', 'Chemistry', 'Mathematics', 'Statistics', 'Biotechnology']],
  ['M.Com', 'PG', 2, ['Accounting and Finance', 'Banking and Insurance', 'Taxation']],
  ['M.A.', 'PG', 2, ['Economics', 'English', 'Psychology', 'Political Science']],
  ['M.Pharm', 'PG', 2, ['Pharmaceutics', 'Pharmacology']],
  ['M.Des', 'PG', 2, ['Product Design', 'UX Design']],
  ['LL.M', 'PG', 1, ['Corporate Law', 'Constitutional Law']],

  // PhD
  ['Ph.D.', 'PHD', 5, ['Computer Science', 'Electronics and Telecommunication', 'Mechanical Engineering', 'Civil', 'Physics', 'Chemistry', 'Mathematics', 'Management', 'Economics', 'Commerce', 'Pharmacy']],
];

async function main() {
  let courses = 0;
  let branches = 0;
  for (const [name, level, years, specs] of CATALOGUE) {
    const existing = await prisma.course.findUnique({ where: { name } });
    const course = existing
      ? await prisma.course.update({ where: { id: existing.id }, data: { level, years, isActive: true } })
      : await prisma.course.create({ data: { name, level, years } });
    if (!existing) courses++;
    for (const spec of specs) {
      if (await prisma.specialisation.findFirst({ where: { courseId: course.id, name: spec } })) continue;
      // Each branch sits under a discipline of the same name.
      const discipline = await prisma.branch.upsert({ where: { name: spec }, create: { name: spec }, update: {} });
      await prisma.specialisation.create({ data: { name: spec, courseId: course.id, branchId: discipline.id } });
      branches++;
    }
  }
  const byLevel = await prisma.course.groupBy({ by: ['level'], where: { isActive: true }, _count: { _all: true } });
  console.log(`added ${courses} courses and ${branches} branches`);
  console.log(byLevel.map((l) => `${l.level}: ${l._count._all} courses`).join(' | '));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
