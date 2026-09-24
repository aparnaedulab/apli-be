import { ensureBranch } from '../modules/tenants/branches.js';
import { prisma, disconnectPrisma } from '../lib/prisma.js';

/**
 * A starter catalogue: the branches and courses an Indian university actually
 * runs, so a fresh platform is not asking its first operator to type in a
 * hundred rows before anybody can be enrolled.
 *
 * This is deliberately not the same job as `seedCourses.ts`, which is a
 * backfill - it reads the courses already recorded against batches and
 * students and makes a catalogue out of them. That one is right after an
 * import; this one is right on an empty database.
 *
 * Why it matters more than a convenience:
 *
 * Course and branch are matched exactly when a job decides who can see it
 * (`course: { in: [...] }` in modules/jobs/reach.ts). A catalogue is what
 * keeps every batch, every student record and every job posting spelling
 * "B.Tech" the same way. With the lists empty the fields fall back to free
 * text, "BTech" and "B.Tech." get typed, and those students quietly match no
 * job at all - a failure with no error message anywhere.
 *
 * Idempotent, by name: it adds what is missing and leaves everything else
 * alone, so it is safe to run on a database that already has a catalogue and
 * safe to run twice.
 *
 *   npm run seed:catalogue
 */

/** The master branch list. One spelling each, and every course picks from it. */
const BRANCHES = [
  // Engineering and technology
  'Computer Engineering',
  'Computer Science and Engineering',
  'Information Technology',
  'Artificial Intelligence and Data Science',
  'Artificial Intelligence and Machine Learning',
  'Electronics and Telecommunication Engineering',
  'Electronics Engineering',
  'Electrical Engineering',
  'Mechanical Engineering',
  'Civil Engineering',
  'Chemical Engineering',
  'Production Engineering',
  'Instrumentation Engineering',
  'Automobile Engineering',
  'Biotechnology',
  'Biomedical Engineering',
  'Robotics and Automation',
  'Metallurgical Engineering',
  'Textile Engineering',
  'Environmental Engineering',
  // Science
  'Physics',
  'Chemistry',
  'Mathematics',
  'Statistics',
  'Botany',
  'Zoology',
  'Microbiology',
  'Computer Science',
  'Electronic Science',
  // Commerce and management
  'Accounting and Finance',
  'Banking and Insurance',
  'Marketing',
  'Human Resource Management',
  'Operations Management',
  'Business Analytics',
  'International Business',
  // Arts
  'English',
  'Economics',
  'Psychology',
  'Political Science',
  'History',
  'Sociology',
  // Computer applications, pharmacy, design, law
  'Computer Applications',
  'Pharmaceutics',
  'Pharmacology',
  'Pharmaceutical Chemistry',
  'Architecture',
  'Interior Design',
  'Constitutional Law',
  'Corporate Law',
];

/**
 * The courses, each with the branches it is taught in.
 *
 * A branch named here must exist in BRANCHES above - it is the same master
 * row, attached to a course, which is what lets the branch list be narrowed
 * to whatever course somebody has already chosen.
 */
const COURSES: { name: string; branches: string[] }[] = [
  {
    name: 'B.E.',
    branches: [
      'Computer Engineering',
      'Information Technology',
      'Artificial Intelligence and Data Science',
      'Electronics and Telecommunication Engineering',
      'Electrical Engineering',
      'Mechanical Engineering',
      'Civil Engineering',
      'Chemical Engineering',
      'Production Engineering',
      'Instrumentation Engineering',
      'Metallurgical Engineering',
      'Textile Engineering',
      'Environmental Engineering',
    ],
  },
  {
    name: 'B.Tech',
    branches: [
      'Computer Science and Engineering',
      'Information Technology',
      'Artificial Intelligence and Machine Learning',
      'Artificial Intelligence and Data Science',
      'Electronics Engineering',
      'Electrical Engineering',
      'Mechanical Engineering',
      'Civil Engineering',
      'Chemical Engineering',
      'Biotechnology',
      'Robotics and Automation',
      'Automobile Engineering',
    ],
  },
  {
    name: 'M.E.',
    branches: [
      'Computer Engineering',
      'Electronics and Telecommunication Engineering',
      'Mechanical Engineering',
      'Civil Engineering',
      'Electrical Engineering',
    ],
  },
  {
    name: 'M.Tech',
    branches: [
      'Computer Science and Engineering',
      'Artificial Intelligence and Machine Learning',
      'Mechanical Engineering',
      'Civil Engineering',
      'Chemical Engineering',
      'Biomedical Engineering',
    ],
  },
  {
    name: 'Diploma in Engineering',
    branches: [
      'Computer Engineering',
      'Information Technology',
      'Electronics Engineering',
      'Electrical Engineering',
      'Mechanical Engineering',
      'Civil Engineering',
      'Automobile Engineering',
    ],
  },
  {
    name: 'B.Sc',
    branches: [
      'Physics',
      'Chemistry',
      'Mathematics',
      'Statistics',
      'Botany',
      'Zoology',
      'Microbiology',
      'Computer Science',
      'Electronic Science',
      'Biotechnology',
    ],
  },
  {
    name: 'M.Sc',
    branches: [
      'Physics',
      'Chemistry',
      'Mathematics',
      'Statistics',
      'Microbiology',
      'Computer Science',
      'Biotechnology',
    ],
  },
  { name: 'BCA', branches: ['Computer Applications'] },
  { name: 'MCA', branches: ['Computer Applications'] },
  {
    name: 'B.Com',
    branches: ['Accounting and Finance', 'Banking and Insurance', 'Marketing'],
  },
  { name: 'M.Com', branches: ['Accounting and Finance', 'Business Analytics'] },
  {
    name: 'BBA',
    branches: ['Marketing', 'Human Resource Management', 'International Business'],
  },
  {
    name: 'MBA',
    branches: [
      'Marketing',
      'Human Resource Management',
      'Operations Management',
      'Business Analytics',
      'International Business',
      'Accounting and Finance',
    ],
  },
  { name: 'B.Pharm', branches: ['Pharmaceutics', 'Pharmacology', 'Pharmaceutical Chemistry'] },
  { name: 'M.Pharm', branches: ['Pharmaceutics', 'Pharmacology', 'Pharmaceutical Chemistry'] },
  { name: 'B.Arch', branches: ['Architecture', 'Interior Design'] },
  {
    name: 'BA',
    branches: ['English', 'Economics', 'Psychology', 'Political Science', 'History', 'Sociology'],
  },
  { name: 'MA', branches: ['English', 'Economics', 'Psychology', 'Political Science'] },
  { name: 'LL.B', branches: ['Constitutional Law', 'Corporate Law'] },
];

async function main(): Promise<void> {
  // 1. The master list first: a course's branch is the same row as the master
  //    branch, so nothing can be attached that is not on the list.
  let newBranches = 0;
  const master = new Map<string, string>();
  for (const name of BRANCHES) {
    const before = await prisma.branch.findFirst({ where: { name } });
    const row = await ensureBranch(prisma, name);
    if (!before) newBranches++;
    master.set(row.name, row.id);
  }

  // 2. The courses, and the branches each is taught in.
  let newCourses = 0;
  let newLinks = 0;
  for (const { name, branches } of COURSES) {
    let course = await prisma.course.findFirst({ where: { name } });
    if (!course) {
      course = await prisma.course.create({ data: { name } });
      newCourses++;
    }

    for (const branchName of branches) {
      const branchId = master.get(branchName);
      if (!branchId) {
        // A typo here would otherwise create a second master branch silently.
        console.warn(`  ! "${branchName}" is not in BRANCHES - skipped for ${name}.`);
        continue;
      }
      const existing = await prisma.specialisation.findFirst({
        where: { name: branchName, courseId: course.id },
      });
      if (!existing) {
        await prisma.specialisation.create({
          data: { name: branchName, courseId: course.id, branchId },
        });
        newLinks++;
      }
    }
  }

  const [branchTotal, courseTotal, linkTotal] = await Promise.all([
    prisma.branch.count(),
    prisma.course.count(),
    prisma.specialisation.count(),
  ]);

  console.log('Catalogue seeded.');
  console.log(`  branches : ${newBranches} added, ${branchTotal} on the master list`);
  console.log(`  courses  : ${newCourses} added, ${courseTotal} in the catalogue`);
  console.log(`  branches on courses : ${newLinks} added, ${linkTotal} in all`);
  console.log('');
  console.log('This is the platform catalogue. Each institution still chooses');
  console.log('which of these it runs, on its Academics step.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
