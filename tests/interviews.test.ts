import { describe, expect, it } from 'vitest';
import { db } from './setup.js';
import { makeCompany } from './factories.js';
import { checkSimulation, createSimulation, submitSimulation } from '../src/modules/companyApp/companyApp.service.js';
import { explainWork, startSimulation, submitTask } from '../src/modules/studentApp/studentApp.service.js';
import {
  createProcess,
  duplicateProcess,
  getProcess,
  questionPacks,
  removeProcess,
  setProcessRounds,
  type RoundInput,
} from '../src/modules/companyApp/interviewProcess.service.js';
import {
  getInviteForCompany,
  listInvitesForStudent,
  recordRoundFeedback,
  respondToInvite,
  saveVideoAnswer,
  sendInterviewInvite,
  withdrawInvite,
} from '../src/modules/companyApp/interviewInvite.service.js';

/**
 * A company's own interviews: it builds a process of rounds, invites a
 * student whose work it has seen, and takes them through the rounds - a
 * recorded interview done in the app, a work simulation, a live interview.
 */

let n = 0;

async function user(role: 'COMPANY' | 'CANDIDATE') {
  n += 1;
  return db.user.create({ data: { email: `iv${n}@demo.example`, fullName: `Sample Person ${n}`, passwordHash: 'x', role } });
}

async function student() {
  const u = await user('CANDIDATE');
  return db.candidate.create({ data: { userId: u.id, interests: ['Finance'], city: 'Pune' } });
}

const SIM = {
  title: 'Sample month-end',
  summary: 'Reconcile a month of payments for a small shop, using sample statements and invoices.',
  field: 'Finance',
  level: 'BEGINNER' as const,
  hours: 2,
  skills: ['Reconciliation'],
  tasks: [
    { title: 'Match payments', brief: 'Match each payment on the statement to an invoice.', minutes: 30 },
    { title: 'Explain the gaps', brief: 'Say why the unmatched ones did not match.', minutes: 30 },
  ],
};

/** A verified company with a live simulation, and a student who handed it in. */
async function setUp() {
  const company = await makeCompany(`Sample Interviewing Co ${++n}`, true);
  const author = await user('COMPANY');
  const sim = await createSimulation(company.id, author.id, SIM);
  await submitSimulation(company.id, sim.id);
  await checkSimulation(sim.id, { decision: 'approve' });
  const shown = await student();
  const started = await startSimulation(shown.id, sim.slug);
  for (const t of started.tasks) await submitTask(shown.id, sim.slug, t.id, { answer: 'Done.' });
  await explainWork(shown.id, sim.slug, {
    how: 'I matched every payment I could first, then looked at what was left one by one.',
    change: 'I would ask the bank about the unknown payer sooner.',
  });
  return { company, author, sim, shown };
}

const rounds = (simulationId: string): RoundInput[] => [
  {
    order: 1,
    name: 'Tell us about yourself',
    type: 'VIDEO_INTERVIEW',
    isElimination: false,
    isOnline: true,
    questionTimeSec: 60,
    prepTimeSec: 20,
    questions: [
      { text: 'Tell us about yourself in a minute.', type: 'intro' },
      { text: 'Why this role?', hint: 'Be specific.', type: 'motivation' },
    ],
  },
  { order: 2, name: 'A second simulation', type: 'WORK_SIMULATION', isElimination: false, isOnline: true, simulationId },
  {
    order: 3,
    name: 'Meet the team',
    type: 'LIVE_INTERVIEW',
    isElimination: true,
    isOnline: true,
    meetingLink: 'https://meet.example/abc',
    durationMin: 30,
  },
];

describe('interview processes', () => {
  it('takes only round types the company knows, with what each one needs', async () => {
    const { company, author, sim } = await setUp();
    const p = await createProcess(company.id, author.id, { title: 'Finance intern', processType: 'INTERNSHIP' });
    expect(p).toMatchObject({ status: 'DRAFT', editable: true, rounds: [] });

    await expect(
      setProcessRounds(company.id, p.id, [{ order: 1, name: 'x', type: 'TAROT_READING', isElimination: false, isOnline: true }]),
    ).rejects.toThrow('not one of the choices');
    await expect(
      setProcessRounds(company.id, p.id, [{ ...rounds(sim.id)[0]!, questions: [] }]),
    ).rejects.toThrow('add at least one question');
    await expect(
      setProcessRounds(company.id, p.id, [{ ...rounds(sim.id)[1]!, simulationId: null }]),
    ).rejects.toThrow('pick which one');

    const saved = await setProcessRounds(company.id, p.id, rounds(sim.id));
    expect(saved.rounds.map((r) => [r.order, r.type, r.typeLabel])).toEqual([
      [1, 'VIDEO_INTERVIEW', 'Recorded interview'],
      [2, 'WORK_SIMULATION', 'Work simulation'],
      [3, 'LIVE_INTERVIEW', 'Live interview'],
    ]);
    expect(saved.rounds[0]).toMatchObject({ questionTimeSec: 60, prepTimeSec: 20, questions: [{ order: 1 }, { order: 2, hint: 'Be specific.' }] });
    expect(saved.rounds[1]).toMatchObject({ simulationId: sim.id, simulationTitle: SIM.title });

    // Another company cannot read it.
    const other = await makeCompany('Sample Nosy Interviewer', true);
    await expect(getProcess(other.id, p.id)).rejects.toThrow('another company');
    // Apli.ai's own question packs are there to pull from.
    expect((await questionPacks()).length).toBeGreaterThanOrEqual(3);
  });
});

describe('interview invites', () => {
  it('goes only to students who showed their work, and walks them through every round', async () => {
    const { company, author, sim, shown } = await setUp();
    const p = await createProcess(company.id, author.id, { title: 'Finance intern', processType: 'INTERNSHIP' });
    await setProcessRounds(company.id, p.id, rounds(sim.id));

    const stranger = await student();
    await expect(
      sendInterviewInvite(company.id, author.id, { candidateId: stranger.id, processId: p.id, role: 'Finance intern' }),
    ).rejects.toThrow('shown you their work');

    const sent = await sendInterviewInvite(company.id, author.id, { candidateId: shown.id, processId: p.id, role: 'Finance intern' });
    expect(sent).toMatchObject({ status: 'PENDING', currentRoundOrder: 1 });
    await expect(
      sendInterviewInvite(company.id, author.id, { candidateId: shown.id, processId: p.id, role: 'Finance intern' }),
    ).rejects.toThrow('already has an open invite');

    // In use: the rounds are fixed, it cannot be deleted, but it can be copied.
    expect((await getProcess(company.id, p.id)).status).toBe('ACTIVE');
    await expect(setProcessRounds(company.id, p.id, rounds(sim.id))).rejects.toThrow('Duplicate it');
    await expect(removeProcess(company.id, p.id)).rejects.toThrow('Archive it');
    const copy = await duplicateProcess(company.id, author.id, p.id);
    expect(copy).toMatchObject({ status: 'DRAFT', editable: true, title: 'Finance intern (copy)' });
    expect(copy.rounds[0]!.questions).toHaveLength(2);

    // Before accepting: no meeting link, no questions; the company cannot judge yet.
    let [mine] = await listInvitesForStudent(shown.id);
    expect(mine!.status).toBe('PENDING');
    expect(mine!.process.rounds[2]!.meetingLink).toBeNull();
    await expect(recordRoundFeedback(company.id, sent.id, { roundOrder: 1, outcome: 'PASSED' })).rejects.toThrow('not accepted');
    await respondToInvite(shown.id, sent.id, 'ACCEPTED');
    await expect(respondToInvite(shown.id, sent.id, 'DECLINED')).rejects.toThrow('already been answered');

    // Round 1: a recorded interview, answered in the app.
    [mine] = await listInvitesForStudent(shown.id);
    const video = mine!.process.rounds[0]!.video!;
    expect(video).toMatchObject({ questionTimeSec: 60, prepTimeSec: 20, count: 2, locked: false });
    expect(mine!.process.rounds[2]!.meetingLink).toBe('https://meet.example/abc');
    const [q1, q2] = video.questions;
    await saveVideoAnswer(shown.id, sent.id, q1!.id, '/api/files/video/one.webm', 41);
    await saveVideoAnswer(shown.id, sent.id, q1!.id, '/api/files/video/one-again.webm', 38);
    await saveVideoAnswer(shown.id, sent.id, q2!.id, '/api/files/video/two.webm', 55);
    await expect(saveVideoAnswer(shown.id, sent.id, copy.rounds[0]!.questions[0]!.id, '/x.webm', 1)).rejects.toThrow(
      'not in this round',
    );

    const seen = await getInviteForCompany(company.id, sent.id);
    expect(seen.process.rounds[0]!.questions.map((q) => q.answer?.fileUrl)).toEqual([
      '/api/files/video/one-again.webm',
      '/api/files/video/two.webm',
    ]);
    await expect(recordRoundFeedback(company.id, sent.id, { roundOrder: 2, outcome: 'PASSED' })).rejects.toThrow('round they are in');
    await recordRoundFeedback(company.id, sent.id, { roundOrder: 1, outcome: 'PASSED', score: 80, notes: 'Clear and calm.' });
    // Judged: the answers are final.
    await expect(saveVideoAnswer(shown.id, sent.id, q1!.id, '/late.webm', 1)).rejects.toThrow();

    // Round 2: a work simulation, linked for the student.
    [mine] = await listInvitesForStudent(shown.id);
    expect(mine).toMatchObject({ currentRoundOrder: 2 });
    expect(mine!.process.rounds[1]!.simulation).toEqual({ slug: sim.slug, title: SIM.title });
    // The student sees the verdict, not the company's notes or score.
    expect(mine!.roundFeedbacks[0]).toMatchObject({ outcome: 'PASSED', notes: null, score: null });
    await recordRoundFeedback(company.id, sent.id, { roundOrder: 2, outcome: 'PASSED' });

    // Round 3 is the last: passing it means the company wants them.
    const done = await recordRoundFeedback(company.id, sent.id, { roundOrder: 3, outcome: 'PASSED' });
    expect(done.status).toBe('OFFERED');
    await expect(withdrawInvite(company.id, sent.id)).rejects.toThrow('cannot be withdrawn');
  });

  it('ends on a failed eliminating round, and a withdrawn invite disappears for the student', async () => {
    const { company, author, sim, shown } = await setUp();
    const p = await createProcess(company.id, author.id, { title: 'Analyst', processType: 'HIRING' });
    await setProcessRounds(company.id, p.id, [rounds(sim.id)[2]!]);

    const first = await sendInterviewInvite(company.id, author.id, { candidateId: shown.id, processId: p.id, role: 'Analyst' });
    await respondToInvite(shown.id, first.id, 'ACCEPTED');
    const out = await recordRoundFeedback(company.id, first.id, { roundOrder: 1, outcome: 'FAILED', notes: 'Not yet.' });
    expect(out.status).toBe('REJECTED');

    const second = await sendInterviewInvite(company.id, author.id, { candidateId: shown.id, processId: p.id, role: 'Analyst' });
    await withdrawInvite(company.id, second.id);
    expect((await listInvitesForStudent(shown.id)).map((i) => i.id)).toEqual([first.id]);

    const pending = await makeCompany('Sample Unverified Interviewer', false);
    await expect(
      sendInterviewInvite(pending.id, author.id, { candidateId: shown.id, processId: p.id, role: 'Analyst' }),
    ).rejects.toThrow('not verified');
  });
});
