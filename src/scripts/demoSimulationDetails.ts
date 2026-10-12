/**
 * Fills in the longer story and each task's learning points on the demo work
 * simulations, so the simulation page has something to show locally:
 * `npx tsx src/scripts/demoSimulationDetails.ts`.
 *
 * Safe to run again; it only fills what is empty. All of it is made up.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DETAILS: Record<string, { about: string; learn: string[][] }> = {
  'northwind-sales-dashboard': {
    about:
      'Every Monday our regional managers open one page and decide where the week goes. When that page is wrong or hard to read, stores run short of stock or sit on too much. This simulation is that Monday page: a raw month of sales, and a manager who has two minutes.\n\nYou will clean real-looking data, decide what matters, and present it so someone else can act on it - the three things an analyst does every week.',
    learn: [
      ['Spotting and fixing bad rows in a sales file', 'Deciding which rows you cannot trust, and saying so'],
      ['Choosing a few numbers that drive a decision', 'Writing down why you chose them'],
      ['Laying out one page for a busy reader', 'Writing a two-line summary that leads with the change'],
    ],
  },
  'harbour-loan-check': {
    about:
      'Small businesses ask us for loans every day, and each one is a judgement call made on a few pages of accounts. In this simulation you are the analyst on a bakery\'s application: read what it earns and spends, test whether it can repay, and write the note our credit team acts on.',
    learn: [
      ['Reading a profit and loss account and a balance sheet', 'Finding cash, not just profit'],
      ['What debt, margin and cash-cover ratios tell a lender', 'Comparing two years to see a trend'],
      ['Writing a recommendation someone can act on', 'Stating conditions clearly'],
    ],
  },
  'greycell-market-entry': {
    about:
      'Clients come to us with big questions and little data. "Is this city worth it?" is one of the most common. This simulation walks through how we answer it: break the question down, estimate with what is public, and give a straight answer the client can take to their board.',
    learn: [
      ['Breaking a vague question into parts', 'Listing what you need to know before any numbers'],
      ['Top-down and bottom-up estimates', 'Explaining why two estimates differ'],
      ['Leading with the answer on a slide', 'Keeping a client deck to three slides'],
    ],
  },
  'zenith-fix-the-bug': {
    about:
      'Production bugs are where engineers learn the most, because the code is real and the customer is waiting. Here, customers see their orders twice. You will reproduce it, find the cause, fix it, and write the kind of note our team reads the next morning.',
    learn: [
      ['Reproducing a reported bug step by step', 'Writing a clear reproduction'],
      ['Reading unfamiliar code to find a cause', 'Explaining why the code misbehaves'],
      ['Fixing safely, with a test that proves it', 'Keeping a change small'],
      ['Writing an incident note for the team', 'Saying what to watch next'],
    ],
  },
  'solace-clinic-waiting-time': {
    about:
      'Patients judge a clinic by the wait before they ever see a doctor. On Mondays ours runs past an hour. This simulation gives you the timings and asks the operations question: where does the hour go, and what one change would shorten it?',
    learn: [
      ['Mapping a process from start to finish', 'Seeing a service from the patient\'s side'],
      ['Reading timing data to find a bottleneck', 'Separating the slow step from the busy one'],
      ['Proposing one change and how to measure it', 'Thinking about cost and side effects'],
    ],
  },
  'orbit-festive-campaign': {
    about:
      'Festive weeks decide a store chain\'s year. Our marketing team plans each campaign around one audience, a fixed budget and a clear way to tell if it worked. You will do the same, from choosing who it is for to splitting the money.',
    learn: [
      ['Describing one audience well enough to write for', 'Avoiding "everyone" as a target'],
      ['Planning channels and timing over three weeks', 'Matching messages to moments'],
      ['Splitting a fixed budget and setting expectations', 'Choosing how you will measure it'],
    ],
  },
};

async function main() {
  let filled = 0;
  for (const [slug, d] of Object.entries(DETAILS)) {
    const sim = await prisma.workSimulation.findUnique({
      where: { slug },
      select: { id: true, about: true, tasks: { orderBy: { position: 'asc' }, select: { id: true, learn: true } } },
    });
    if (!sim) continue;
    if (!sim.about) await prisma.workSimulation.update({ where: { id: sim.id }, data: { about: d.about } });
    for (const [i, t] of sim.tasks.entries()) {
      const has = Array.isArray(t.learn) && t.learn.length > 0;
      if (!has && d.learn[i]) await prisma.workSimulationTask.update({ where: { id: t.id }, data: { learn: d.learn[i] } });
    }
    filled += 1;
  }
  console.log(`demo simulations filled in: ${filled}`);
}

main().finally(() => prisma.$disconnect());
