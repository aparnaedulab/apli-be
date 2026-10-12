/**
 * Demo work simulations for local use: `npx tsx src/scripts/seedWorkSimulations.ts`.
 *
 * Safe to run again - simulations are matched by their address and left as
 * they are. Uses the demo companies already in the database; the work, the
 * wording and the companies are all made up. Optionally gives one demo
 * student something in progress and a finished certificate, so the
 * dashboard has every section filled:
 *
 *   npx tsx src/scripts/seedWorkSimulations.ts fields.one@demo-student.example
 */
import { PrismaClient, RunStatus, WorkSimulationLevel, WorkSimulationStatus } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO: {
  slug: string;
  company: string;
  title: string;
  field: string;
  level: WorkSimulationLevel;
  hours: number;
  skills: string[];
  summary: string;
  tasks: [string, string, number][];
}[] = [
  {
    slug: 'northwind-sales-dashboard',
    company: 'Northwind Analytics',
    title: 'Build a sales dashboard',
    field: 'Data',
    level: 'BEGINNER',
    hours: 4,
    skills: ['Spreadsheets', 'Charts', 'Storytelling'],
    summary: 'Turn a messy month of store sales into one page a regional manager can read in two minutes.',
    tasks: [
      ['Clean the sales sheet', 'Fix dates, remove duplicates and flag the rows you could not trust.', 60],
      ['Pick the three numbers that matter', 'Decide what the manager needs first and say why.', 45],
      ['Make the one-page dashboard', 'Charts and a two-line summary of what changed this month.', 90],
    ],
  },
  {
    slug: 'harbour-loan-check',
    company: 'Harbour Fintech',
    title: 'Check a small-business loan',
    field: 'Finance',
    level: 'INTERMEDIATE',
    hours: 5,
    skills: ['Financial statements', 'Ratios', 'Written recommendation'],
    summary: 'Read a bakery’s accounts, work out whether it can repay a loan, and write the note a credit team would act on.',
    tasks: [
      ['Read the accounts', 'Pull revenue, costs and cash from two years of statements.', 60],
      ['Work out the ratios', 'Debt, margins and cash cover, and what each one tells you.', 75],
      ['Write your recommendation', 'Lend, lend with conditions, or decline - in under a page.', 60],
    ],
  },
  {
    slug: 'greycell-market-entry',
    company: 'Greycell Consulting',
    title: 'Size a new city for a client',
    field: 'Consulting',
    level: 'BEGINNER',
    hours: 3,
    skills: ['Market sizing', 'Structuring', 'Slides'],
    summary: 'A coffee chain wants to open in a new city. Estimate the market and tell them whether it is worth it.',
    tasks: [
      ['Break the question down', 'Lay out what you need to know before any numbers.', 40],
      ['Estimate the market', 'A top-down and a bottom-up estimate, and where they disagree.', 70],
      ['Three slides for the client', 'Your answer first, then the reasons.', 60],
    ],
  },
  {
    slug: 'zenith-fix-the-bug',
    company: 'Zenith Labs',
    title: 'Find and fix a production bug',
    field: 'Software',
    level: 'INTERMEDIATE',
    hours: 6,
    skills: ['Debugging', 'Testing', 'Writing a fix-up note'],
    summary: 'Customers say their orders show twice. Track down why, fix it, and prove it stays fixed.',
    tasks: [
      ['Reproduce the problem', 'Show the double order happening, step by step.', 60],
      ['Find the cause', 'Point to the line and explain why it misbehaves.', 90],
      ['Fix it and add a test', 'The change, and a test that fails without it.', 90],
      ['Write the note for the team', 'What broke, what you changed, what to watch.', 30],
    ],
  },
  {
    slug: 'solace-clinic-waiting-time',
    company: 'Solace Health',
    title: 'Cut waiting time at a clinic',
    field: 'Healthcare',
    level: 'BEGINNER',
    hours: 3,
    skills: ['Process mapping', 'Data reading', 'Proposals'],
    summary: 'Patients wait over an hour on Mondays. Map the visit, find the slow step and propose a change.',
    tasks: [
      ['Map a patient’s visit', 'Every step from arrival to leaving.', 45],
      ['Find the bottleneck', 'Use the timings sheet to show where the hour goes.', 60],
      ['Propose one change', 'What to change, what it costs, and how to know it worked.', 45],
    ],
  },
  {
    slug: 'orbit-festive-campaign',
    company: 'Orbit Retail',
    title: 'Plan a festive-season campaign',
    field: 'Marketing',
    level: 'BEGINNER',
    hours: 4,
    skills: ['Audience research', 'Campaign planning', 'Budgeting'],
    summary: 'Plan a three-week campaign for a store chain with a fixed budget, and say how you will know it worked.',
    tasks: [
      ['Choose who it is for', 'One audience, described well enough to write for.', 45],
      ['Plan the three weeks', 'Channels, messages and timing.', 75],
      ['Split the budget', 'Where the money goes and what you expect back.', 45],
    ],
  },
];

async function main() {
  let added = 0;
  for (const d of DEMO) {
    const company = await prisma.company.findFirst({ where: { name: d.company }, select: { id: true } });
    if (!company) {
      console.log(`skipped ${d.slug}: no company called ${d.company}`);
      continue;
    }
    if (await prisma.workSimulation.findUnique({ where: { slug: d.slug } })) continue;
    await prisma.workSimulation.create({
      data: {
        slug: d.slug,
        companyId: company.id,
        title: d.title,
        summary: d.summary,
        field: d.field,
        level: d.level,
        hours: d.hours,
        skills: d.skills,
        status: WorkSimulationStatus.LIVE,
        publishedAt: new Date(Date.now() - added * 3 * 24 * 60 * 60 * 1000),
        tasks: { create: d.tasks.map(([title, brief, minutes], i) => ({ position: i + 1, title, brief, minutes })) },
      },
    });
    added += 1;
  }
  console.log(`simulations added: ${added}`);

  const email = process.argv[2];
  if (!email) return;
  const candidate = await prisma.candidate.findFirst({ where: { user: { email } }, select: { id: true } });
  if (!candidate) {
    console.log(`no student with email ${email}`);
    return;
  }

  // One under way, one task done.
  const going = await prisma.workSimulation.findUnique({
    where: { slug: 'northwind-sales-dashboard' },
    select: { id: true, tasks: { orderBy: { position: 'asc' }, select: { id: true } } },
  });
  if (going) {
    const run = await prisma.workSimulationRun.upsert({
      where: { simulationId_candidateId: { simulationId: going.id, candidateId: candidate.id } },
      create: { simulationId: going.id, candidateId: candidate.id },
      update: {},
    });
    await prisma.workSimulationTaskDone.upsert({
      where: { runId_taskId: { runId: run.id, taskId: going.tasks[0]!.id } },
      create: {
        runId: run.id,
        taskId: going.tasks[0]!.id,
        answer: 'Fixed 41 dates written as text, removed 12 duplicate orders, and flagged 3 stores whose totals did not add up.',
      },
      update: {},
    });
  }

  // One finished, with its certificate.
  const done = await prisma.workSimulation.findUnique({
    where: { slug: 'solace-clinic-waiting-time' },
    select: { id: true, tasks: { select: { id: true } } },
  });
  if (done) {
    const run = await prisma.workSimulationRun.upsert({
      where: { simulationId_candidateId: { simulationId: done.id, candidateId: candidate.id } },
      create: {
        simulationId: done.id,
        candidateId: candidate.id,
        status: RunStatus.COMPLETED,
        completedAt: new Date(),
        certificateCode: 'APLI-DEMO-0001',
        explainHow: 'I timed each step from the sheet, found the gap at registration, and tested one change on paper first.',
        explainChange: 'I would ask the front desk staff before proposing anything; they know where the queue really starts.',
        submittedAt: new Date(),
        reviewedAt: new Date(),
      },
      update: {},
    });
    for (const t of done.tasks) {
      await prisma.workSimulationTaskDone.upsert({
        where: { runId_taskId: { runId: run.id, taskId: t.id } },
        create: { runId: run.id, taskId: t.id, answer: 'Handed in for the demo.' },
        update: {},
      });
    }
  }
  console.log(`demo progress given to ${email}`);
}

main().finally(() => prisma.$disconnect());
