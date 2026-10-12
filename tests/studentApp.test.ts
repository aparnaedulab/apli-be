import { describe, expect, it } from 'vitest';
import { db } from './setup.js';
import { makeCollege, makeCompany } from './factories.js';
import {
  checkWorkCertificate,
  dashboard,
  dismiss,
  explainWork,
  listSimulations,
  profile,
  review,
  reviewQueue,
  saveProfile,
  setShares,
  shareOptions,
  simulationDetail,
  startSimulation,
  submitTask,
} from '../src/modules/studentApp/studentApp.service.js';

/**
 * The rebuilt student app: what the board shows, and a work simulation from
 * start, through hand-in, explanation and review, to a verified certificate
 * the student chooses who sees.
 */

let n = 0;

async function student(interests: string[] = [], collegeId: string | null = null) {
  n += 1;
  const user = await db.user.create({
    data: { email: `app${n}@demo-student.example`, fullName: 'Sample Student', passwordHash: 'x', role: 'CANDIDATE' },
  });
  return db.candidate.create({ data: { userId: user.id, interests, collegeId } });
}

async function simulation(field: string, slug: string, tasks = 2, status: 'LIVE' | 'DRAFT' = 'LIVE') {
  const company = await makeCompany();
  return db.workSimulation.create({
    data: {
      slug,
      companyId: company.id,
      title: `Sample ${field} project`,
      summary: 'A short sample project.',
      field,
      status,
      publishedAt: new Date(),
      tasks: {
        create: Array.from({ length: tasks }, (_, i) => ({ position: i + 1, title: `Task ${i + 1}`, brief: 'Do it.' })),
      },
    },
  });
}

const EXPLAIN = {
  how: 'I cleaned the data first, then compared the months, then wrote up the three numbers that moved.',
  change: 'I would check the returns data before trusting the totals.',
};

/** Starts, hands in every task, explains, and sends to review. */
async function handInAll(candidateId: string, slug: string) {
  const started = await startSimulation(candidateId, slug);
  for (const t of started.tasks) await submitTask(candidateId, slug, t.id, { answer: `My answer for ${t.title}` });
  return explainWork(candidateId, slug, EXPLAIN);
}

const admin = async () =>
  (await db.user.create({ data: { email: `rev${++n}@demo.example`, fullName: 'Reviewer', passwordHash: 'x', role: 'ADMIN' } })).id;

describe('the board', () => {
  it('suggests the fields the student picked first, only live ones, three at most', async () => {
    await simulation('Finance', 'sample-finance');
    await simulation('Data', 'sample-data');
    await simulation('Law', 'sample-law');
    await simulation('Design', 'sample-design');
    await simulation('Data', 'sample-draft', 2, 'DRAFT');
    const me = await student(['Data']);

    const d = await dashboard(me.id);
    expect(d.firstName).toBe('Sample');
    expect(d.suggested).toHaveLength(3);
    expect(d.suggested[0]!.slug).toBe('sample-data');
    expect(d.suggested.map((s) => s.slug)).not.toContain('sample-draft');
    expect(d.moreToTry).toBe(1);
  });

  it('keeps a closed suggestion closed, and moves a started one to "working on"', async () => {
    await simulation('Data', 'sample-close');
    await simulation('Design', 'sample-start');
    const me = await student();
    const closed = await db.workSimulation.findUniqueOrThrow({ where: { slug: 'sample-close' } });

    await dismiss(me.id, 'suggestion', closed.id);
    await startSimulation(me.id, 'sample-start');

    const d = await dashboard(me.id);
    expect(d.suggested).toHaveLength(0);
    expect(d.inProgress.map((r) => r.simulation.slug)).toEqual(['sample-start']);
    expect(d.inProgress[0]).toMatchObject({ status: 'ACTIVE', tasksDone: 0, tasksLeft: 2, readyToExplain: false });
    expect(d.inProgress[0]!.nextTask?.title).toBe('Task 1');
  });

  it('says how many from the same college finished a suggestion', async () => {
    const college = await makeCollege('Sample College');
    const sim = await simulation('Data', 'sample-peers', 1);
    const peer = await student([], college.id);
    await db.workSimulationRun.create({ data: { simulationId: sim.id, candidateId: peer.id, status: 'COMPLETED' } });
    const me = await student(['Data'], college.id);

    const d = await dashboard(me.id);
    expect(d.suggested.find((s) => s.slug === 'sample-peers')?.fromCollege).toBe(1);
  });
});

describe('a simulation, from start to verified certificate', () => {
  it('takes tasks in order, with an answer or a link', async () => {
    await simulation('Data', 'sample-order', 2);
    const me = await student();
    const started = await startSimulation(me.id, 'sample-order');
    const [first, second] = started.tasks;

    await expect(submitTask(me.id, 'sample-order', second!.id, { answer: 'too early' })).rejects.toThrow('in order');
    await expect(submitTask(me.id, 'sample-order', first!.id, {})).rejects.toThrow('To hand this in, write your answer or add a link or upload a file.');

    const after = await submitTask(me.id, 'sample-order', first!.id, { link: 'https://example.com/my-sheet' });
    expect(after.tasks[0]!.handedIn).toMatchObject({ link: 'https://example.com/my-sheet', answer: null });

    // A task can take only what the company chose: here, files only.
    await db.workSimulationTask.update({ where: { id: second!.id }, data: { handInKinds: ['file'] } });
    const detail = await simulationDetail(me.id, 'sample-order');
    expect(detail.tasks[1]!.handInKinds).toEqual(['file']);

    // A file alone is a hand-in too, kept with its name.
    const withFile = await submitTask(me.id, 'sample-order', first!.id, { fileUrl: '/api/files/abc123.pdf', fileName: 'my-work.pdf' });
    expect(withFile.tasks[0]!.handedIn).toMatchObject({ fileUrl: '/api/files/abc123.pdf', fileName: 'my-work.pdf', answer: null });
    await expect(submitTask(me.id, 'sample-order', second!.id, { answer: 'Words, not a file.' })).rejects.toThrow('upload a file.');
    const filed = await submitTask(me.id, 'sample-order', second!.id, { answer: 'Ignored', fileUrl: '/api/files/def456.png', fileName: 'chart.png' });
    expect(filed.tasks[1]!.handedIn).toMatchObject({ answer: null, fileName: 'chart.png' });
  });

  it('cannot be explained before every task is in', async () => {
    await simulation('Data', 'sample-early', 2);
    const me = await student();
    await startSimulation(me.id, 'sample-early');
    await expect(explainWork(me.id, 'sample-early', EXPLAIN)).rejects.toThrow('Hand in every task first.');
  });

  it('goes to review, comes back for changes, and is approved with a code anyone can check', async () => {
    await simulation('Data', 'sample-review', 2);
    const me = await student();
    const reviewer = await admin();

    const inReview = await handInAll(me.id, 'sample-review');
    expect(inReview.run?.status).toBe('IN_REVIEW');
    await expect(submitTask(me.id, 'sample-review', inReview.tasks[0]!.id, { answer: 'x' })).rejects.toThrow('reviewer');

    const queue = await reviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.tasks.map((t) => t.answer)).toEqual(['My answer for Task 1', 'My answer for Task 2']);
    expect(queue[0]!.explainHow).toContain('cleaned the data');

    // Sent back: a note is required, and any task can be redone.
    await expect(review(reviewer, queue[0]!.runId, { decision: 'changes' })).rejects.toThrow('Say what needs changing.');
    await review(reviewer, queue[0]!.runId, { decision: 'changes', note: 'Show how you got the totals in task 2.' });
    let d = await dashboard(me.id);
    expect(d.inProgress[0]).toMatchObject({ status: 'NEEDS_WORK', reviewNote: 'Show how you got the totals in task 2.' });
    await submitTask(me.id, 'sample-review', inReview.tasks[1]!.id, { answer: 'Totals: summed by month, returns removed.' });
    await explainWork(me.id, 'sample-review', EXPLAIN);

    await review(reviewer, queue[0]!.runId, { decision: 'approve' });
    d = await dashboard(me.id);
    expect(d.inProgress).toHaveLength(0);
    const cert = d.certificates[0]!;
    expect(cert.certificateCode).toMatch(/^APLI-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await reviewQueue()).toHaveLength(0);

    const check = await checkWorkCertificate(cert.certificateCode!.toLowerCase());
    expect(check).toMatchObject({ student: 'Sample Student', simulation: 'Sample Data project' });
    expect(await checkWorkCertificate('APLI-0000-0000')).toBeNull();
  });

  it('is shown only to the companies the student picks', async () => {
    const sim = await simulation('Data', 'sample-share', 1);
    const other = await simulation('Law', 'sample-other', 1);
    const me = await student();
    await handInAll(me.id, 'sample-share');
    await review(await admin(), (await reviewQueue())[0]!.runId, { decision: 'approve' });
    const runId = (await dashboard(me.id)).certificates[0]!.runId;

    const options = await shareOptions(me.id, runId);
    expect(options.companies[0]).toMatchObject({ id: sim.companyId, isOwner: true, shared: false });

    await setShares(me.id, runId, [sim.companyId, other.companyId]);
    expect((await dashboard(me.id)).sharedCount).toBe(2);
    await setShares(me.id, runId, [other.companyId]);
    const d = await dashboard(me.id);
    expect(d.certificates[0]!.sharedWith.map((c) => c.id)).toEqual([other.companyId]);

    const stranger = await makeCompany('Sample Unrelated Co', true);
    await expect(setShares(me.id, runId, [stranger.id])).rejects.toThrow('Pick companies from the list.');
  });

  it('hides drafts from the catalogue and from a direct address', async () => {
    const draft = await simulation('Data', 'sample-hidden', 1, 'DRAFT');
    await simulation('Data', 'sample-open', 1);
    const me = await student();
    await expect(simulationDetail(me.id, draft.slug)).rejects.toThrow('That simulation is not open.');
    const list = await listSimulations(me.id, { field: 'Data' });
    expect(list.simulations.map((i) => i.slug)).toEqual(['sample-open']);
  });
});

describe('the overview', () => {
  it('sums up the work, the skills practised, the fields and what happened lately', async () => {
    const sim = await simulation('Data', 'sample-overview', 2);
    await db.workSimulation.update({ where: { id: sim.id }, data: { skills: ['Spreadsheets', 'Charts'], hours: 3 } });
    await simulation('Data', 'sample-open-data', 1);
    const me = await student(['Data', 'Law']);
    await handInAll(me.id, 'sample-overview');
    await review(await admin(), (await reviewQueue())[0]!.runId, { decision: 'approve' });

    const d = await dashboard(me.id);
    expect(d.stats).toEqual({ tasksHandedIn: 2, hoursVerified: 3 });
    expect(d.skills).toEqual([
      { name: 'Charts', times: 1, verified: true },
      { name: 'Spreadsheets', times: 1, verified: true },
    ]);
    expect(d.fields).toEqual([
      { field: 'Data', open: 2, started: 0, verified: 1 },
      { field: 'Law', open: 0, started: 0, verified: 0 },
    ]);
    expect(d.activity[0]).toMatchObject({ kind: 'verified', slug: 'sample-overview' });
    expect(d.activity.map((a) => a.kind)).toEqual(expect.arrayContaining(['started', 'handed-in', 'sent', 'verified']));
  });
});

describe('the profile', () => {
  it('says what is missing and how complete it is', async () => {
    const me = await student(['Data']);
    const before = await profile(me.id);
    expect(before.complete).toBe(20);
    expect(before.missing.map((m) => m.key)).toEqual(['city', 'phone', 'specialisation', 'cgpa']);

    const after = await saveProfile(me.id, {
      interests: ['Data', 'Finance'],
      city: 'Pune',
      phone: '+91 90000 00000',
      specialisation: 'Computer Science',
      cgpa: 8.4,
    });
    expect(after.complete).toBe(100);
    expect((await dashboard(me.id)).profile.missing).toEqual([]);
  });
});
