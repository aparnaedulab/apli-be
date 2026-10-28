/**
 * Demo students at every stage of a work simulation, for testing reviews and
 * certificates locally:
 *
 *   npm run seed:certificates
 *
 * Needs the demo simulations first (`npx tsx src/scripts/seedWorkSimulations.ts`).
 * Safe to run again: students are matched by email and runs by student and
 * simulation, and anything already there is left as it is.
 *
 * Every name, email and answer is made up. No invites are created and no mail
 * is sent. Logins use DEMO_PASSWORD, or CampusHire2026 like the other seeds.
 */
import { PrismaClient, RunStatus } from '@prisma/client';
import { hashPassword } from '../modules/auth/auth.service.js';

const prisma = new PrismaClient();
const PASSWORD = process.env.DEMO_PASSWORD || 'CampusHire2026';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

type Stage =
  /** Started; `tasks` of them handed in. */
  | { status: 'ACTIVE'; tasks: number }
  /** Every task handed in and explained, waiting for the company. */
  | { status: 'IN_REVIEW' }
  /** The company asked for changes. */
  | { status: 'NEEDS_WORK'; note: string }
  /** Approved, with a certificate. `shareWith` is company names. */
  | { status: 'COMPLETED'; code: string; stars: number; comment: string; shareWith?: string[] };

interface DemoStudent {
  name: string;
  email: string;
  course: string;
  interests: string[];
  runs: { slug: string; startedDaysAgo: number; stage: Stage }[];
}

const STUDENTS: DemoStudent[] = [
  {
    name: 'Aditya Kulkarni',
    email: 'aditya.kulkarni@demo-student.example',
    course: 'B.E. Computer Engineering',
    interests: ['Data', 'Consulting'],
    runs: [
      {
        slug: 'northwind-sales-dashboard',
        startedDaysAgo: 20,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0001', stars: 5, comment: 'The cleaning task taught me more than any lab.', shareWith: ['Northwind Analytics', 'Greycell Consulting'] },
      },
      {
        slug: 'greycell-market-entry',
        startedDaysAgo: 12,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0002', stars: 4, comment: 'Hard to size a market with so little data, but fun.' },
      },
      { slug: 'zenith-fix-the-bug', startedDaysAgo: 3, stage: { status: 'ACTIVE', tasks: 2 } },
    ],
  },
  {
    name: 'Sana Shaikh',
    email: 'sana.shaikh@demo-student.example',
    course: 'BBA',
    interests: ['Healthcare', 'Finance'],
    runs: [
      {
        slug: 'solace-clinic-waiting-time',
        startedDaysAgo: 18,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0003', stars: 5, comment: 'Mapping the visit made the problem obvious.', shareWith: ['Solace Health'] },
      },
      { slug: 'harbour-loan-check', startedDaysAgo: 6, stage: { status: 'IN_REVIEW' } },
    ],
  },
  {
    name: 'Rohit Pawar',
    email: 'rohit.pawar@demo-student.example',
    course: 'B.E. Information Technology',
    interests: ['Software', 'Marketing'],
    runs: [
      {
        slug: 'zenith-fix-the-bug',
        startedDaysAgo: 25,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0004', stars: 5, comment: 'Writing the test before the fix was new for me.', shareWith: ['Zenith Labs'] },
      },
      {
        slug: 'orbit-festive-campaign',
        startedDaysAgo: 9,
        stage: { status: 'NEEDS_WORK', note: 'The budget split adds up to more than the total. Fix the numbers and say what you expect back from each channel.' },
      },
    ],
  },
  {
    name: 'Pooja Deshmukh',
    email: 'pooja.deshmukh@demo-student.example',
    course: 'B.Com',
    interests: ['Finance', 'Data'],
    runs: [
      {
        slug: 'harbour-loan-check',
        startedDaysAgo: 15,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0005', stars: 4, comment: 'Good practice for reading real accounts.', shareWith: ['Harbour Fintech'] },
      },
      { slug: 'northwind-sales-dashboard', startedDaysAgo: 4, stage: { status: 'ACTIVE', tasks: 2 } },
    ],
  },
  {
    name: 'Kunal Jadhav',
    email: 'kunal.jadhav@demo-student.example',
    course: 'BMS',
    interests: ['Marketing', 'Consulting'],
    runs: [
      {
        slug: 'orbit-festive-campaign',
        startedDaysAgo: 16,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0006', stars: 5, comment: 'Choosing one audience was the hardest part.' },
      },
      { slug: 'greycell-market-entry', startedDaysAgo: 5, stage: { status: 'IN_REVIEW' } },
    ],
  },
  {
    name: 'Isha Gokhale',
    email: 'isha.gokhale@demo-student.example',
    course: 'B.Sc. Statistics',
    interests: ['Data', 'Healthcare'],
    runs: [
      { slug: 'northwind-sales-dashboard', startedDaysAgo: 7, stage: { status: 'IN_REVIEW' } },
      { slug: 'solace-clinic-waiting-time', startedDaysAgo: 2, stage: { status: 'ACTIVE', tasks: 1 } },
    ],
  },
  {
    name: 'Nikhil More',
    email: 'nikhil.more@demo-student.example',
    course: 'B.E. Mechanical Engineering',
    interests: ['Consulting', 'Software'],
    runs: [
      {
        slug: 'greycell-market-entry',
        startedDaysAgo: 10,
        stage: { status: 'NEEDS_WORK', note: 'Your two estimates are far apart and the slides do not say why. Explain the gap, then pick one.' },
      },
      { slug: 'zenith-fix-the-bug', startedDaysAgo: 4, stage: { status: 'ACTIVE', tasks: 2 } },
    ],
  },
  {
    name: 'Tanvi Bhosale',
    email: 'tanvi.bhosale@demo-student.example',
    course: 'B.Com (Accounting)',
    interests: ['Finance', 'Marketing'],
    runs: [
      {
        slug: 'sample-ledger-works-reconcile-a-month-of-payments',
        startedDaysAgo: 14,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0007', stars: 4, comment: 'Matching the payments line by line was satisfying.', shareWith: ['Sample Ledger Works'] },
      },
      { slug: 'orbit-festive-campaign', startedDaysAgo: 3, stage: { status: 'IN_REVIEW' } },
    ],
  },
  {
    name: 'Omkar Shinde',
    email: 'omkar.shinde@demo-student.example',
    course: 'B.Sc. Computer Science',
    interests: ['Data'],
    runs: [{ slug: 'northwind-sales-dashboard', startedDaysAgo: 1, stage: { status: 'ACTIVE', tasks: 1 } }],
  },
  {
    name: 'Riya Chavan',
    email: 'riya.chavan@demo-student.example',
    course: 'BBA (Healthcare Management)',
    interests: ['Healthcare', 'Data'],
    runs: [
      {
        slug: 'solace-clinic-waiting-time',
        startedDaysAgo: 22,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0008', stars: 5, comment: 'I would do this again with a real clinic.', shareWith: ['Solace Health', 'Northwind Analytics'] },
      },
      {
        slug: 'northwind-sales-dashboard',
        startedDaysAgo: 11,
        stage: { status: 'COMPLETED', code: 'APLI-TEST-0009', stars: 4, comment: 'Short and clear.' },
      },
      { slug: 'harbour-loan-check', startedDaysAgo: 0, stage: { status: 'ACTIVE', tasks: 0 } },
    ],
  },
];

/** What a student hands in for a task: made-up, but reads like real work. */
function answerFor(taskTitle: string, student: string): string {
  const first = student.split(' ')[0];
  return [
    `${taskTitle}: done.`,
    'I went through the material first, wrote down what I was unsure of, and checked each figure twice before writing it up.',
    `The main finding is in the first paragraph; the working is below it. - ${first}`,
  ].join(' ');
}

async function main() {
  const passwordHash = await hashPassword(PASSWORD);
  const college = await prisma.college.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });

  const sims = await prisma.workSimulation.findMany({
    select: {
      id: true,
      slug: true,
      companyId: true,
      company: { select: { members: { take: 1, orderBy: { createdAt: 'asc' }, select: { userId: true } } } },
      tasks: { orderBy: { position: 'asc' }, select: { id: true, title: true } },
    },
  });
  const bySlug = new Map(sims.map((s) => [s.slug, s]));
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const companyId = new Map(companies.map((c) => [c.name, c.id]));

  let students = 0;
  let runs = 0;
  let certificates = 0;

  for (const s of STUDENTS) {
    const user = await prisma.user.upsert({
      where: { email: s.email },
      create: { email: s.email, passwordHash, fullName: s.name, role: 'CANDIDATE' },
      update: {},
      select: { id: true },
    });
    const candidate = await prisma.candidate.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        collegeId: college?.id ?? null,
        degreeLevel: 'UG',
        city: 'Pune',
        course: s.course,
        interests: s.interests,
        graduationYear: 2027,
        startYear: 2023,
      },
      update: {},
      select: { id: true },
    });
    students += 1;

    for (const r of s.runs) {
      const sim = bySlug.get(r.slug);
      if (!sim) {
        console.log(`skipped ${r.slug} for ${s.email}: simulation not found (run seedWorkSimulations.ts first)`);
        continue;
      }
      const existing = await prisma.workSimulationRun.findUnique({
        where: { simulationId_candidateId: { simulationId: sim.id, candidateId: candidate.id } },
        select: { id: true },
      });
      if (existing) continue;

      const st = r.stage;
      const started = daysAgo(r.startedDaysAgo);
      const handedIn = st.status === 'ACTIVE' ? Math.min(st.tasks, sim.tasks.length) : sim.tasks.length;
      // Work still going spreads up to yesterday; handed-in work over the first
      // half, so the submission and the review land on different, earlier days.
      const span = st.status === 'ACTIVE' ? Math.max(r.startedDaysAgo - 1, 0) : Math.floor(r.startedDaysAgo / 2);
      const doneAt = (i: number) => daysAgo(r.startedDaysAgo - Math.round(((i + 1) * span) / (sim.tasks.length + 1)));
      const submittedAt = st.status === 'ACTIVE' ? null : daysAgo(Math.max(r.startedDaysAgo - span, 1));
      const reviewed = st.status === 'COMPLETED' || st.status === 'NEEDS_WORK';
      const reviewedAt = reviewed ? new Date(Math.min(submittedAt!.getTime() + DAY, Date.now())) : null;
      const reviewerId = sim.company.members[0]?.userId ?? null;

      const run = await prisma.workSimulationRun.create({
        data: {
          simulationId: sim.id,
          candidateId: candidate.id,
          status: RunStatus[st.status],
          startedAt: started,
          lastActiveAt: handedIn ? doneAt(handedIn - 1) : started,
          explainHow:
            st.status === 'ACTIVE'
              ? null
              : 'I read every brief first and listed what I did not know. Then I did the tasks in order and checked each one against the brief before handing it in.',
          explainChange:
            st.status === 'ACTIVE' ? null : 'I would ask more questions at the start, and spend less time polishing the last task.',
          submittedAt,
          reviewedAt,
          reviewedById: reviewed ? reviewerId : null,
          reviewNote: st.status === 'NEEDS_WORK' ? st.note : st.status === 'COMPLETED' ? 'Clear, well reasoned work. Approved.' : null,
          completedAt: st.status === 'COMPLETED' ? reviewedAt : null,
          certificateCode: st.status === 'COMPLETED' ? st.code : null,
          done: {
            create: sim.tasks.slice(0, handedIn).map((t, i) => ({
              taskId: t.id,
              answer: answerFor(t.title, s.name),
              doneAt: doneAt(i),
            })),
          },
        },
        select: { id: true },
      });
      runs += 1;

      if (st.status === 'COMPLETED') {
        certificates += 1;
        await prisma.workSimulationReview.create({ data: { runId: run.id, stars: st.stars, comment: st.comment } });
        for (const name of st.shareWith ?? []) {
          const id = companyId.get(name);
          if (id) await prisma.workSimulationShare.create({ data: { runId: run.id, companyId: id } });
        }
      }
    }
  }

  console.log(`demo students: ${students}, new runs: ${runs}, new certificates: ${certificates}`);
  console.log(`log in as any of them with the demo password, e.g. ${STUDENTS[0]!.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
