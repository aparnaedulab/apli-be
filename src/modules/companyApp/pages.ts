import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * The pages inside one task: what a student reads, and the quick checks they
 * answer, before they hand the task in.
 *
 *   read   - a page of text, with an optional YouTube or Vimeo video
 *   check  - a few questions, each one of:
 *              text    a written answer, in their own words - read by the reviewer
 *              choice  pick one right answer, or several (`multiple`)
 *              sort    put each item into the right group (dragged, or tapped)
 *              order   put the items in the right order (dragged, or moved)
 *
 * Every kind but `text` is marked here; a written answer goes to the reviewer.
 *
 * The company writes them with the answers. Students are sent them without -
 * `forStudent` strips every answer - and the server marks what they send
 * back, so the right answer never reaches a browser before it is earned.
 */

const VIDEO = /^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|vimeo\.com\/)\S+$/i;

/** Short, readable ids for pages and questions, made here when missing. */
const newId = () => randomBytes(5).toString('hex');
const id = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{4,40}$/i)
  .optional();

const textSchema = z.object({
  id,
  kind: z.literal('text'),
  prompt: z.string().trim().min(5, 'Write the question.').max(600),
  /** Shown under the box: what a good answer covers, or how long it should be. */
  hint: z.string().trim().max(300).optional().nullable(),
  /** The fewest words that count as an answer; 0 for any. */
  minWords: z.coerce.number().int().min(0).max(500).optional().default(0),
  /** Shown once answered: what the company was looking for. */
  explain: z.string().trim().max(800).optional().nullable(),
});

const choiceSchema = z
  .object({
    id,
    kind: z.literal('choice'),
    prompt: z.string().trim().min(5, 'Write the question.').max(600),
    options: z.array(z.string().trim().min(1, 'An option cannot be empty.').max(300)).min(2, 'Give at least two options.').max(6),
    /** "Pick several" when true; "pick one" when false. Left out, it follows how many are right. */
    multiple: z.boolean().optional(),
    /** Which options are right, by position. */
    correct: z.array(z.number().int().min(0)).min(1, 'Mark the right answer.'),
    explain: z.string().trim().max(800).optional().nullable(),
  })
  .refine((q) => q.correct.every((c) => c < q.options.length), { message: 'Mark an answer that exists.', path: ['correct'] })
  .refine((q) => q.multiple !== false || q.correct.length === 1, {
    message: 'A "pick one" question has exactly one right answer.',
    path: ['correct'],
  })
  .transform((q) => ({ ...q, multiple: q.multiple ?? q.correct.length > 1 }));

const sortSchema = z
  .object({
    id,
    kind: z.literal('sort'),
    prompt: z.string().trim().min(5, 'Write the question.').max(600),
    groups: z.array(z.string().trim().min(1, 'A group needs a name.').max(80)).min(2, 'Give at least two groups.').max(6),
    items: z
      .array(
        z.object({
          text: z.string().trim().min(1, 'An item cannot be empty.').max(300),
          /** Which group it belongs in, by position. */
          group: z.number().int().min(0),
        }),
      )
      .min(2, 'Give at least two items to sort.')
      .max(10),
    explain: z.string().trim().max(800).optional().nullable(),
  })
  .refine((q) => q.items.every((i) => i.group < q.groups.length), { message: 'Put every item in a group.', path: ['items'] });

const orderSchema = z.object({
  id,
  kind: z.literal('order'),
  prompt: z.string().trim().min(5, 'Write the question.').max(600),
  /** The items in the right order. Students get them shuffled. */
  items: z.array(z.string().trim().min(1, 'An item cannot be empty.').max(300)).min(3, 'Give at least three items.').max(8),
  explain: z.string().trim().max(800).optional().nullable(),
});

const questionSchema = z.union([textSchema, choiceSchema, sortSchema, orderSchema]);

const readSchema = z.object({
  id,
  kind: z.literal('read'),
  title: z.string().trim().min(2, 'Give the page a title.').max(120),
  body: z.string().trim().min(20, 'Write a few sentences.').max(8000),
  videoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || VIDEO.test(v), 'Paste a YouTube or Vimeo link.')
    .optional()
    .nullable(),
});

const checkSchema = z.object({
  id,
  kind: z.literal('check'),
  title: z.string().trim().min(2, 'Give the check a title.').max(120),
  questions: z.array(questionSchema).min(1, 'Add at least one question.').max(8, 'Up to eight questions.'),
});

/** What a company may send as a task's pages; ids are filled in where missing. */
export const pagesSchema = z
  .array(z.discriminatedUnion('kind', [readSchema, checkSchema]))
  .max(10, 'Up to ten pages in a task.')
  .default([])
  .transform((pages) =>
    pages.map((p) =>
      p.kind === 'read'
        ? { ...p, id: p.id ?? newId(), videoUrl: p.videoUrl || null }
        : {
            ...p,
            id: p.id ?? newId(),
            questions: p.questions.map((q) => ({
              ...q,
              id: q.id ?? newId(),
              explain: q.explain || null,
              ...(q.kind === 'text' ? { hint: q.hint || null } : {}),
            })),
          },
    ),
  );

export type Page = z.output<typeof pagesSchema>[number];
export type CheckPage = Extract<Page, { kind: 'check' }>;
type Question = CheckPage['questions'][number];

/** Pages as stored; anything that is not a list reads as none. */
export function readPages(raw: unknown): Page[] {
  if (!Array.isArray(raw)) return [];
  // Choices written before "pick one" and "pick several" were chosen follow how many are right.
  return (raw as Page[]).map((p) =>
    p.kind === 'check'
      ? {
          ...p,
          questions: p.questions.map((q) => (q.kind === 'choice' ? { ...q, multiple: q.multiple ?? q.correct.length > 1 } : q)),
        }
      : p,
  );
}

/**
 * How an order question's items are shown: a shuffle fixed by the question's
 * id, so it is the same every time and the server can map answers back, and
 * never already in the right order.
 */
export function shownOrder(qid: string, n: number): number[] {
  const seed = createHash('sha256').update(qid).digest();
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = seed[i % seed.length]! % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // A shuffle that changed nothing would give the answer away.
  if (order.every((v, i) => v === i)) order.push(order.shift()!);
  return order;
}

/** The pages as a student is sent them: every answer taken out. */
export function forStudent(pages: Page[]) {
  return pages.map((p) =>
    p.kind === 'read'
      ? p
      : {
          id: p.id,
          kind: p.kind,
          title: p.title,
          questions: p.questions.map((q) =>
            q.kind === 'text'
              ? { id: q.id, kind: q.kind, prompt: q.prompt, hint: q.hint ?? null, minWords: q.minWords ?? 0 }
              : q.kind === 'choice'
              ? { id: q.id, kind: q.kind, prompt: q.prompt, options: q.options, multiple: q.multiple ?? q.correct.length > 1 }
              : q.kind === 'sort'
                ? { id: q.id, kind: q.kind, prompt: q.prompt, groups: q.groups, items: q.items.map((i) => i.text) }
                : { id: q.id, kind: q.kind, prompt: q.prompt, items: shownOrder(q.id, q.items.length).map((i) => q.items[i]!) },
          ),
        },
  );
}

/**
 * A student's answers: for a written answer, the text; for a choice, the
 * options picked; for a sort, the group picked for each item; for an order,
 * the items as shown, in the order the student put them.
 */
export const answersSchema = z.record(
  z.string().max(40),
  z.union([z.array(z.number().int().min(-1).max(20)).max(20), z.string().max(5000)]),
);
export type Answers = z.infer<typeof answersSchema>;

export interface Marked {
  score: number;
  total: number;
  /**
   * Per question: right or not, the right answer, and the company's
   * explanation. A written answer is not marked here: `correct` is null.
   */
  questions: Record<string, { correct: boolean | null; solution: number[]; explain: string | null }>;
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** The right answer, in the same terms as a student's answer. */
function solutionOf(q: Exclude<Question, { kind: 'text' }>): number[] {
  if (q.kind === 'choice') return q.correct;
  if (q.kind === 'sort') return q.items.map((i) => i.group);
  // Shown position of each item, taken in the right order.
  const shown = shownOrder(q.id, q.items.length);
  return q.items.map((_, right) => shown.indexOf(right));
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Marks one quick check. A question counts only when it is wholly right; a
 * written answer is not counted at all - the reviewer reads it.
 */
export function mark(page: CheckPage, answers: Answers): Marked {
  const questions: Marked['questions'] = {};
  let score = 0;
  let total = 0;
  for (const q of page.questions) {
    if (q.kind === 'text') {
      questions[q.id] = { correct: null, solution: [], explain: q.explain ?? null };
      continue;
    }
    total += 1;
    const raw = answers[q.id];
    const given = Array.isArray(raw) ? raw : [];
    const solution = solutionOf(q);
    const correct =
      q.kind === 'choice' ? sameSet(given, solution) : given.length === solution.length && given.every((g, i) => g === solution[i]);
    if (correct) score += 1;
    questions[q.id] = { correct, solution, explain: q.explain ?? null };
  }
  return { score, total, questions };
}

/** Whether every question has an answer that counts - a written one long enough, the rest given. */
export function complete(page: CheckPage, answers: Answers): boolean {
  return page.questions.every((q) => {
    const a = answers[q.id];
    if (q.kind === 'text') return typeof a === 'string' && a.trim().length > 0 && words(a) >= (q.minWords ?? 0);
    return Array.isArray(a) && a.length > 0;
  });
}

/** The written answers in a check, for the reviewer: each question and what was written. */
export function writtenAnswers(page: CheckPage, answers: Answers): { prompt: string; answer: string }[] {
  return page.questions
    .filter((q) => q.kind === 'text')
    .map((q) => ({ prompt: q.prompt, answer: typeof answers[q.id] === 'string' ? (answers[q.id] as string) : '' }));
}

/**
 * One marked try as the student sees it before choosing to see the answers:
 * right or not for each question, but not what the right answer is, nor the
 * company's explanation. Afterwards, everything.
 */
export function asShown(marked: Marked, revealed: boolean): Marked {
  if (revealed) return marked;
  return {
    ...marked,
    questions: Object.fromEntries(
      Object.entries(marked.questions).map(([id, q]) => [id, { correct: q.correct, solution: [], explain: null }]),
    ),
  };
}

/**
 * A try written out in words, for the company reading it: each question, what
 * the student answered, the right answer, and whether they had it.
 */
export function inWords(page: CheckPage, answers: Answers) {
  const { questions } = mark(page, answers);
  return page.questions.map((q) => {
    const raw = answers[q.id];
    const given = Array.isArray(raw) ? raw : [];
    const correct = questions[q.id]?.correct ?? null;
    if (q.kind === 'text') {
      return { prompt: q.prompt, kind: q.kind, answer: [typeof raw === 'string' ? raw : ''], right: [] as string[], correct };
    }
    if (q.kind === 'choice') {
      return {
        prompt: q.prompt,
        kind: q.kind,
        answer: given.map((i) => q.options[i] ?? '?'),
        right: q.correct.map((i) => q.options[i]!),
        correct,
      };
    }
    if (q.kind === 'sort') {
      return {
        prompt: q.prompt,
        kind: q.kind,
        answer: q.items.map((it, i) => `${it.text} → ${q.groups[given[i] ?? -1] ?? 'not placed'}`),
        right: q.items.map((it) => `${it.text} → ${q.groups[it.group]}`),
        correct,
      };
    }
    // Order: the student's answer is shown positions; map them back to the items.
    const shown = shownOrder(q.id, q.items.length);
    return {
      prompt: q.prompt,
      kind: q.kind,
      answer: given.map((k) => q.items[shown[k] ?? -1] ?? '?'),
      right: q.items,
      correct,
    };
  });
}

/** The ways a task can be handed in. */
export const HAND_IN_KINDS = ['text', 'link', 'file'] as const;
export type HandInKind = (typeof HAND_IN_KINDS)[number];
export const handInKindsSchema = z
  .array(z.enum(HAND_IN_KINDS))
  .min(1, 'Allow at least one way to hand in.')
  .default(['text', 'link', 'file'])
  .transform((l) => HAND_IN_KINDS.filter((k) => l.includes(k)));

/** A task's hand-in kinds as stored; anything unreadable allows all three. */
export function readHandInKinds(raw: unknown): HandInKind[] {
  const l = Array.isArray(raw) ? (raw as string[]).filter((k): k is HandInKind => (HAND_IN_KINDS as readonly string[]).includes(k)) : [];
  return l.length ? l : [...HAND_IN_KINDS];
}

/** Every quick check in a task must be answered before the task is handed in. */
export function checkPageIds(pages: Page[]): string[] {
  return pages.filter((p) => p.kind === 'check').map((p) => p.id);
}
