import { describe, expect, it } from 'vitest';
import { db } from './setup.js';
import { makeCompany } from './factories.js';
import {
  checkSimulation,
  companyReview,
  companyReviewQueue,
  createSimulation,
  deleteSimulation,
  overview,
  retireSimulation,
  sharedWithCompany,
  simulationsToCheck,
  submitSimulation,
  updateSimulation,
  withdrawSimulation,
} from '../src/modules/companyApp/companyApp.service.js';
import {
  answerCheck,
  dashboard,
  explainWork,
  listSimulations,
  saveReview,
  setShares,
  simulationDetail,
  simulationReviews,
  startSimulation,
  submitTask,
} from '../src/modules/studentApp/studentApp.service.js';

/**
 * The company side of work simulations: a company writes one, Apli.ai
 * checks it, students do it, and the company reviews their work and meets
 * the students who choose to share it.
 */

let n = 0;

const DRAFT = {
  title: 'Sample pricing check',
  summary: 'Work out whether a small shop should raise its prices, using a month of sample sales.',
  field: 'Finance',
  level: 'BEGINNER' as const,
  hours: 3,
  skills: ['Spreadsheets', 'Pricing'],
  tasks: [
    { title: 'Read the sales', brief: 'Find the ten best-selling items and their margins.', handIn: 'A short table', minutes: 45 },
    { title: 'Recommend a price', brief: 'Pick one item and say what it should cost, and why.', minutes: 45 },
  ],
};

async function user(role: 'COMPANY' | 'CANDIDATE' | 'ADMIN') {
  n += 1;
  return db.user.create({ data: { email: `c${n}@demo.example`, fullName: 'Sample Person', passwordHash: 'x', role } });
}

async function student() {
  const u = await user('CANDIDATE');
  return db.candidate.create({ data: { userId: u.id, interests: ['Finance'], city: 'Pune' } });
}

/** A company with a live simulation, as Apli.ai would leave it. */
async function liveCompany(name = `Sample Co ${++n}`) {
  const company = await makeCompany(name, true);
  const author = await user('COMPANY');
  const sim = await createSimulation(company.id, author.id, DRAFT);
  await submitSimulation(company.id, sim.id);
  await checkSimulation(sim.id, { decision: 'approve' });
  return { company, sim, author };
}

describe('writing a simulation', () => {
  it('starts as a draft with its tasks in order and an address of its own', async () => {
    const company = await makeCompany('Sample Bakery Co', true);
    const sim = await createSimulation(company.id, (await user('COMPANY')).id, DRAFT);
    expect(sim).toMatchObject({ status: 'DRAFT', editable: true, slug: 'sample-bakery-co-sample-pricing-check' });
    expect(sim.tasks.map((t) => [t.position, t.title, t.handIn])).toEqual([
      [1, 'Read the sales', 'A short table'],
      [2, 'Recommend a price', null],
    ]);
    // Students never see a draft.
    const me = await student();
    expect((await listSimulations(me.id, {})).simulations).toHaveLength(0);
  });

  it('needs a verified company and two tasks before it can be sent to be checked', async () => {
    const pending = await makeCompany('Sample Pending Co', false);
    const draft = await createSimulation(pending.id, (await user('COMPANY')).id, DRAFT);
    await expect(submitSimulation(pending.id, draft.id)).rejects.toThrow('not verified');

    const company = await makeCompany('Sample Verified Co', true);
    const one = await createSimulation(company.id, (await user('COMPANY')).id, { ...DRAFT, tasks: [DRAFT.tasks[0]!] });
    await expect(submitSimulation(company.id, one.id)).rejects.toThrow('at least two tasks');
  });

  it('is checked by Apli.ai: sent back with a note, changed, then made live', async () => {
    const company = await makeCompany('Sample Checked Co', true);
    const sim = await createSimulation(company.id, (await user('COMPANY')).id, DRAFT);
    await submitSimulation(company.id, sim.id);
    await expect(updateSimulation(company.id, sim.id, DRAFT)).rejects.toThrow('Withdraw it');
    expect((await simulationsToCheck()).map((s) => s.id)).toEqual([sim.id]);

    await expect(checkSimulation(sim.id, { decision: 'changes' })).rejects.toThrow('Say what needs changing.');
    await checkSimulation(sim.id, { decision: 'changes', note: 'Give task 2 a sample answer length.' });
    const back = await updateSimulation(company.id, sim.id, { ...DRAFT, title: 'Sample pricing check, revised' });
    expect(back).toMatchObject({ status: 'CHANGES_ASKED', reviewNote: 'Give task 2 a sample answer length.' });

    await submitSimulation(company.id, sim.id);
    await checkSimulation(sim.id, { decision: 'approve' });
    const me = await student();
    const open = await listSimulations(me.id, {});
    expect(open.simulations.map((s) => s.title)).toEqual(['Sample pricing check, revised']);

    // Live means fixed: students may be part way through.
    await expect(updateSimulation(company.id, sim.id, DRAFT)).rejects.toThrow('Retire it');
    await expect(deleteSimulation(company.id, sim.id)).rejects.toThrow('Only a draft');
    await retireSimulation(company.id, sim.id);
    expect((await listSimulations(me.id, {})).simulations).toHaveLength(0);
  });

  it('can be withdrawn while waiting, and a company sees only its own', async () => {
    const a = await makeCompany('Sample A Co', true);
    const b = await makeCompany('Sample B Co', true);
    const sim = await createSimulation(a.id, (await user('COMPANY')).id, DRAFT);
    await submitSimulation(a.id, sim.id);
    await expect(withdrawSimulation(b.id, sim.id)).rejects.toThrow('No such simulation.');
    expect((await withdrawSimulation(a.id, sim.id)).status).toBe('DRAFT');
  });
});

describe('the details students read', () => {
  it('carries the story, the video, the cover and what each task teaches through to the student', async () => {
    const company = await makeCompany('Sample Detail Co', true);
    const sim = await createSimulation(company.id, (await user('COMPANY')).id, {
      ...DRAFT,
      about: 'Pricing is half guesswork in a small shop. This is how we take the guessing out.',
      videoUrl: 'https://www.youtube.com/watch?v=sample',
      coverUrl: '/uploads/sample-cover.jpg',
      tasks: DRAFT.tasks.map((t, i) => ({
        ...t,
        learn: i === 0 ? ['Reading a sales sheet', 'Margins'] : [],
        steps: i === 0 ? ['Open the sheet', 'Sort by sales'] : [],
      })),
    });
    expect(sim.tasks[0]!.learn).toEqual(['Reading a sales sheet', 'Margins']);
    await submitSimulation(company.id, sim.id);
    expect((await simulationsToCheck())[0]).toMatchObject({ about: expect.stringContaining('guesswork'), videoUrl: expect.any(String) });
    await checkSimulation(sim.id, { decision: 'approve' });

    const me = await student();
    const page = await simulationDetail(me.id, sim.slug);
    expect(page.simulation).toMatchObject({
      about: expect.stringContaining('guesswork'),
      videoUrl: 'https://www.youtube.com/watch?v=sample',
      coverUrl: '/uploads/sample-cover.jpg',
      myStatus: null,
    });
    expect(page.tasks[0]!.learn).toEqual(['Reading a sales sheet', 'Margins']);
    expect(page.tasks[0]!.steps).toEqual(['Open the sheet', 'Sort by sales']);
    expect(page.tasks[1]!.steps).toEqual([]);

    await startSimulation(me.id, sim.slug);
    const card = (await listSimulations(me.id, {})).simulations[0]!;
    expect(card).toMatchObject({ coverUrl: '/uploads/sample-cover.jpg', myStatus: 'ACTIVE' });
  });
});

describe('pages and quick checks inside a task', () => {
  it('never sends the answers, marks on the server, and holds the hand-in until checks are done', async () => {
    const company = await makeCompany('Sample Pages Co', true);
    const author = await user('COMPANY');
    const sim = await createSimulation(company.id, author.id, {
      ...DRAFT,
      tasks: [
        {
          ...DRAFT.tasks[0]!,
          pages: [
            { kind: 'read', title: 'How a shop prices', body: 'Most small shops price by adding a fixed margin to what they paid.' },
            {
              kind: 'check',
              title: 'Quick check',
              questions: [
                { kind: 'choice', prompt: 'Which number tells you profit per item?', options: ['Price', 'Margin', 'Footfall'], correct: [1], explain: 'Margin is what is left.' },
                {
                  kind: 'sort',
                  prompt: 'Sort each cost into its kind.',
                  groups: ['Fixed', 'Variable'],
                  items: [
                    { text: 'Shop rent', group: 0 },
                    { text: 'Flour', group: 1 },
                  ],
                },
              ],
            },
          ],
        },
        DRAFT.tasks[1]!,
      ],
    });
    // The company sees its own answers, with ids filled in.
    const check = sim.tasks[0]!.pages[1]!;
    expect(check.kind).toBe('check');
    const pageId = check.id;
    await submitSimulation(company.id, sim.id);
    await checkSimulation(sim.id, { decision: 'approve' });

    const me = await student();
    const page = await startSimulation(me.id, sim.slug);
    const sent = JSON.stringify(page.tasks[0]!.pages);
    expect(sent).not.toContain('correct');
    expect(sent).not.toContain('"group"');
    expect(sent).not.toContain('Margin is what is left');
    expect(page.tasks[0]!.pages[1]).toMatchObject({ kind: 'check', questions: [{ multiple: false }, { items: ['Shop rent', 'Flour'] }] });

    const taskId = page.tasks[0]!.id;
    await expect(submitTask(me.id, sim.slug, taskId, { answer: 'Done.' })).rejects.toThrow('quick checks');

    const qs = (page.tasks[0]!.pages[1] as { questions: { id: string }[] }).questions;
    const first = await answerCheck(me.id, sim.slug, taskId, pageId, { [qs[0]!.id]: [0], [qs[1]!.id]: [0, 1] });
    expect(first.tasks[0]!.checks[pageId]).toMatchObject({ score: 1, total: 2 });
    expect(first.tasks[0]!.checks[pageId]!.questions[qs[0]!.id]).toEqual({ correct: false, solution: [1], explain: 'Margin is what is left.' });

    const again = await answerCheck(me.id, sim.slug, taskId, pageId, { [qs[0]!.id]: [1], [qs[1]!.id]: [0, 1] });
    expect(again.tasks[0]!.checks[pageId]).toMatchObject({ score: 2, total: 2 });

    // A later task cannot be answered out of order; this one can now be handed in.
    await expect(answerCheck(me.id, sim.slug, page.tasks[1]!.id, pageId, {})).rejects.toThrow('in order');
    await submitTask(me.id, sim.slug, taskId, { answer: 'Margins first, then rent.' });
    await submitTask(me.id, sim.slug, page.tasks[1]!.id, { answer: 'Raise bread by five rupees.' });
    await explainWork(me.id, sim.slug, {
      how: 'I read the margins, sorted the costs, then priced the item with the thinnest margin.',
      change: 'I would compare with the shop next door.',
    });
    const queued = (await companyReviewQueue(company.id))[0]!;
    expect(queued.tasks[0]!.checks).toEqual([{ title: 'Quick check', score: 2, total: 2, written: [] }]);
  });
});

describe('reviews and the company on the page', () => {
  it('lets only finished students review, signs them lightly, and shows the company', async () => {
    const { company, sim, author } = await liveCompany('Sample Reviewed Co');
    await db.company.update({ where: { id: company.id }, data: { about: 'We keep small shops solvent.', city: 'Pune' } });
    const me = await student();
    await db.user.update({ where: { id: (await db.candidate.findUniqueOrThrow({ where: { id: me.id } })).userId }, data: { fullName: 'Asha Kulkarni' } });

    const page = await simulationDetail(me.id, sim.slug);
    expect(page.company).toMatchObject({ name: 'Sample Reviewed Co', about: 'We keep small shops solvent.', city: 'Pune' });
    expect(page.reviews).toEqual({ average: null, count: 0, mine: null, canReview: false });
    await expect(saveReview(me.id, sim.slug, { stars: 5 })).rejects.toThrow('Finish the simulation first');

    const started = await startSimulation(me.id, sim.slug);
    for (const t of started.tasks) await submitTask(me.id, sim.slug, t.id, { answer: 'Done.' });
    await explainWork(me.id, sim.slug, {
      how: 'I matched the sales to the prices first, then worked out each margin before choosing.',
      change: 'I would ask the owner what customers grumble about.',
    });
    await companyReview(company.id, author.id, (await companyReviewQueue(company.id))[0]!.runId, { decision: 'approve' });

    const after = await saveReview(me.id, sim.slug, { stars: 4, comment: 'Clear tasks, fair feedback.' });
    expect(after.reviews).toEqual({ average: 4, count: 1, mine: { stars: 4, comment: 'Clear tasks, fair feedback.' }, canReview: true });
    expect(await simulationReviews(me.id, sim.slug)).toEqual([
      expect.objectContaining({ stars: 4, comment: 'Clear tasks, fair feedback.', by: 'Asha K.' }),
    ]);
  });
});

describe('a simulation that closes part way through', () => {
  it('stays open to students who started it, and closes to new ones', async () => {
    const { company, sim } = await liveCompany('Sample Closing Co');
    const started = await student();
    const first = await startSimulation(started.id, sim.slug);
    await retireSimulation(company.id, sim.id);

    // Their own work stays theirs: they can open it and keep handing in.
    const page = await simulationDetail(started.id, sim.slug);
    expect(page.run?.status).toBe('ACTIVE');
    await submitTask(started.id, sim.slug, first.tasks[0]!.id, { answer: 'Still working on it.' });

    // A suspended company does not take it away either.
    await db.company.update({ where: { id: company.id }, data: { status: 'SUSPENDED' } });
    expect((await simulationDetail(started.id, sim.slug)).tasks[0]!.done).toBe(true);

    const newcomer = await student();
    await expect(simulationDetail(newcomer.id, sim.slug)).rejects.toThrow('not open');
    await expect(startSimulation(newcomer.id, sim.slug)).rejects.toThrow('not open');
  });
});

describe("students' work, reviewed by the company", () => {
  it('shows a company only its own students, lets it decide, and counts it all', async () => {
    const { company, sim, author } = await liveCompany('Sample Reviewing Co');
    const other = await liveCompany('Sample Other Co');
    const me = await student();

    const started = await startSimulation(me.id, sim.slug);
    for (const t of started.tasks) await submitTask(me.id, sim.slug, t.id, { answer: `Answer for ${t.title}` });
    await explainWork(me.id, sim.slug, {
      how: 'I sorted the items by margin, then compared prices with two nearby shops before choosing.',
      change: 'I would ask the owner which items customers ask about most.',
    });

    expect(await companyReviewQueue(other.company.id)).toHaveLength(0);
    const queue = await companyReviewQueue(company.id);
    expect(queue).toHaveLength(1);
    await expect(companyReview(other.company.id, other.author.id, queue[0]!.runId, { decision: 'approve' })).rejects.toThrow(
      'No such submission.',
    );

    await companyReview(company.id, author.id, queue[0]!.runId, { decision: 'approve' });
    const runId = (await dashboard(me.id)).certificates[0]!.runId;
    expect((await overview(company.id)).students).toMatchObject({ toReview: 0, verified: 1, sharedWithYou: 0 });

    // Nothing is shown until the student shares it.
    expect(await sharedWithCompany(company.id)).toHaveLength(0);
    await setShares(me.id, runId, [company.id]);
    const shared = await sharedWithCompany(company.id);
    expect(shared[0]).toMatchObject({ student: { name: 'Sample Person', city: 'Pune' }, simulation: { title: DRAFT.title } });
    expect(shared[0]!.tasks.map((t) => t.answer)).toEqual(['Answer for Read the sales', 'Answer for Recommend a price']);
    expect((await overview(company.id)).students.sharedWithYou).toBe(1);
  });
});
