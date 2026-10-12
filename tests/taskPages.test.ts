import { describe, expect, it } from 'vitest';
import {
  complete,
  forStudent,
  handInKindsSchema,
  mark,
  pagesSchema,
  readHandInKinds,
  shownOrder,
  writtenAnswers,
  type CheckPage,
} from '../src/modules/companyApp/pages.js';

/**
 * Quick checks inside a task, marked on the server: what a student is sent,
 * and how each kind of question is marked.
 */

const [check] = pagesSchema.parse([
  {
    kind: 'check',
    title: 'Quick check',
    questions: [
      { id: 'q-order', kind: 'order', prompt: 'Put the month-end steps in order.', items: ['Download', 'Match', 'Explain', 'File'] },
      { id: 'q-many', kind: 'choice', prompt: 'Which are payments?', options: ['Rent', 'Invoice', 'Salary'], correct: [0, 2] },
    ],
  },
]) as [CheckPage];

describe('an order question', () => {
  it('is shown shuffled - never already right - and the same way every time', () => {
    const shown = shownOrder('q-order', 4);
    expect(shown).not.toEqual([0, 1, 2, 3]);
    expect(shownOrder('q-order', 4)).toEqual(shown);
    expect([...shown].sort()).toEqual([0, 1, 2, 3]);

    const sent = forStudent([check])[0] as { questions: { items?: string[] }[] };
    expect(sent.questions[0]!.items).toEqual(shown.map((i) => ['Download', 'Match', 'Explain', 'File'][i]));
    expect(JSON.stringify(sent)).not.toContain('correct');
  });

  it('is right when the shown items are put back in the right order', () => {
    const shown = shownOrder('q-order', 4);
    const rightly = [0, 1, 2, 3].map((right) => shown.indexOf(right));
    const marked = mark(check, { 'q-order': rightly, 'q-many': [2, 0] });
    expect(marked.score).toBe(2);
    expect(marked.questions['q-order']!.solution).toEqual(rightly);

    const wrong = mark(check, { 'q-order': [...rightly].reverse(), 'q-many': [0] });
    expect(wrong.score).toBe(0);
  });
});

describe('the kinds of question a company chooses', () => {
  const [page] = pagesSchema.parse([
    {
      kind: 'check',
      title: 'Mixed',
      questions: [
        { id: 'q-text', kind: 'text', prompt: 'In your words, what is a reconciliation?', minWords: 3 },
        { id: 'q-one', kind: 'choice', multiple: false, prompt: 'Which comes first?', options: ['Match', 'Download'], correct: [1] },
        { id: 'q-many', kind: 'choice', multiple: true, prompt: 'Which are bank-only?', options: ['Fee', 'Invoice', 'Interest'], correct: [0, 2] },
      ],
    },
  ]) as [CheckPage];

  it('does not score a written answer, and keeps it for the reviewer', () => {
    const answers = { 'q-text': 'Matching the bank to the books.', 'q-one': [1], 'q-many': [0, 2] };
    expect(complete(page, answers)).toBe(true);
    const marked = mark(page, answers);
    expect(marked).toMatchObject({ score: 2, total: 2 });
    expect(marked.questions['q-text']!.correct).toBeNull();
    expect(writtenAnswers(page, answers)).toEqual([{ prompt: 'In your words, what is a reconciliation?', answer: 'Matching the bank to the books.' }]);
  });

  it('wants a written answer long enough, and every other question answered', () => {
    expect(complete(page, { 'q-text': 'Too short', 'q-one': [1], 'q-many': [0] })).toBe(false);
    expect(complete(page, { 'q-text': 'Long enough answer here', 'q-one': [1] })).toBe(false);
  });

  it('tells students which choice questions are "pick several"', () => {
    const sent = forStudent([page])[0] as { questions: { id: string; multiple?: boolean; minWords?: number }[] };
    expect(sent.questions.map((q) => q.multiple)).toEqual([undefined, false, true]);
    expect(sent.questions[0]!.minWords).toBe(3);
  });

  it('refuses a "pick one" with more than one right answer', () => {
    expect(() =>
      pagesSchema.parse([
        { kind: 'check', title: 'x', questions: [{ kind: 'choice', multiple: false, prompt: 'Pick the one?', options: ['a', 'b'], correct: [0, 1] }] },
      ]),
    ).toThrow('exactly one right answer');
  });
});

describe('how a task is handed in', () => {
  it('allows all three ways unless the company chose', () => {
    expect(handInKindsSchema.parse(undefined)).toEqual(['text', 'link', 'file']);
    expect(handInKindsSchema.parse(['file', 'text'])).toEqual(['text', 'file']);
    expect(() => handInKindsSchema.parse([])).toThrow('at least one');
    expect(readHandInKinds(null)).toEqual(['text', 'link', 'file']);
  });
});
