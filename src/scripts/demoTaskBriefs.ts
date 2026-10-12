/**
 * Gives the demo work simulations' tasks a real brief - the situation, what
 * is needed back - with numbered steps and what to hand in, so a student can
 * tell what the task is asking: `npx tsx src/scripts/demoTaskBriefs.ts`.
 *
 * Only tasks whose brief is still one short line are changed. Made up.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Brief = { brief: string; steps: string[]; handIn: string };

const BRIEFS: Record<string, Brief[]> = {
  'solace-clinic-waiting-time': [
    {
      brief:
        'On Mondays, patients at our outpatient clinic wait over an hour before seeing a doctor. Before anyone can fix that, we need to know what actually happens to a patient from the moment they walk in until they leave.\n\nWrite down every step of one patient\'s visit, in order, and who or what is involved at each step.',
      steps: [
        'Imagine a patient arriving at 9:00 on a Monday for a routine visit.',
        'List every step they go through until they leave - registration, waiting, vitals, the doctor, the pharmacy, paying.',
        'For each step, note who does it (receptionist, nurse, doctor) and where it happens.',
        'Mark the steps where the patient is only waiting.',
      ],
      handIn: 'A numbered list of the steps (or a simple flow diagram), with the waiting steps marked.',
    },
    {
      brief:
        'Our front desk timed twenty patients last Monday: when each one arrived, registered, saw the nurse, saw the doctor and left. Use those timings to find where the hour goes.\n\nWork out how long patients spend at each step and in each wait, and name the one step that adds the most time.',
      steps: [
        'For each patient, work out the minutes spent between each pair of steps.',
        'Find the average time for each step and each wait.',
        'Pick the step or wait that adds the most time overall.',
        'Check it is not just one unusual patient pulling the average up.',
      ],
      handIn: 'A short table of average minutes per step, and two or three sentences on the slowest one.',
    },
    {
      brief:
        'You have found where patients wait longest. Now suggest one change that would cut that wait - something the clinic could actually try next Monday.\n\nSay what you would change, what it would cost in staff time or money, and how the clinic would know it worked.',
      steps: [
        'Describe the change in one or two sentences.',
        'Say what it needs: people, time, money, or a different rota.',
        'Say what could go wrong, and how to avoid it.',
        'Choose one number the clinic should measure before and after.',
      ],
      handIn: 'A half-page proposal: the change, what it costs, the risk, and how to measure it.',
    },
  ],
  'northwind-sales-dashboard': [
    {
      brief:
        'You have one month of sales from our forty stores in a spreadsheet. Before anyone can read it, it needs cleaning: some dates are typed as text, some orders appear twice, and a few stores\' totals do not add up.\n\nClean the sheet, and keep a note of everything you changed and anything you could not trust.',
      steps: [
        'Fix dates written as text so they sort properly.',
        'Find and remove orders that appear twice.',
        'Check each store\'s total against the sum of its orders.',
        'Flag any rows you could not fix or trust, and say why.',
      ],
      handIn: 'A link to your cleaned sheet, and a short list of what you changed.',
    },
    {
      brief:
        'A regional manager has two minutes on Monday morning. From your cleaned sales, pick the three numbers they most need to see, and say why each one earns its place.',
      steps: [
        'Read the page on what a manager reads first.',
        'Choose one number that says whether the month was good.',
        'Choose one that says where to look, and one that says what to do next.',
        'Write one line on why each matters.',
      ],
      handIn: 'Your three numbers, each with one line on why it matters.',
    },
    {
      brief:
        'Put it together: one page the manager can read in two minutes. Your three numbers at the top, a chart or two that shows what changed, and a two-line summary in plain words.',
      steps: [
        'Lay out the page with your three numbers first.',
        'Add one or two charts that show the change, not everything.',
        'Write a two-line summary that leads with what changed.',
        'Ask yourself: could someone act on this in two minutes?',
      ],
      handIn: 'Your one-page dashboard as a PDF, picture or link.',
    },
  ],
};

async function main() {
  let changed = 0;
  for (const [slug, briefs] of Object.entries(BRIEFS)) {
    const tasks = await prisma.workSimulationTask.findMany({
      where: { simulation: { slug } },
      orderBy: { position: 'asc' },
      select: { id: true, brief: true },
    });
    for (const [i, t] of tasks.entries()) {
      const b = briefs[i];
      if (!b || t.brief.length >= 120) continue;
      await prisma.workSimulationTask.update({ where: { id: t.id }, data: { brief: b.brief, steps: b.steps, handIn: b.handIn } });
      changed += 1;
    }
  }
  console.log(`demo task briefs filled in: ${changed}`);
}

main().finally(() => prisma.$disconnect());
