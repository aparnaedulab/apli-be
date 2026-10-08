import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { loadTenant, markStepById } from '../tenants/onboarding.service.js';

/**
 * The questions and answers in the student help panel.
 *
 * Each institution keeps its own list, set up in onboarding ("Student help")
 * and editable afterwards. The platform's defaults below are what an
 * institution starts from, and what its students see until it has saved a
 * list of its own - so the panel is never empty.
 *
 * The defaults say only what the product actually does. An institution may
 * reword them to fit its own rules; that is the point of letting it.
 */
export const DEFAULT_QUESTIONS: { question: string; answer: string }[] = [
  {
    question: 'Why can’t I apply to a job?',
    answer:
      'Two things have to be true: your college has verified your record, and the role is open to your course, branch, passing year and marks. The Jobs page only shows roles you qualify for, and lists the ones you don’t with the reason.',
  },
  {
    question: 'What does the match % mean?',
    answer:
      'How many of the skills a role asks for are on your profile. It does not stop you applying - it shows what to add, or learn, to be a stronger fit.',
  },
  {
    question: 'How do I know a company has seen my application?',
    answer:
      'Open Applied. Each card shows where your application stands and the company’s latest update. Companies have to reply within the time your college sets.',
  },
  {
    question: 'Do I have to pay anything?',
    answer:
      'Never. No company on Apli.ai may charge a student at any stage. If anyone asks you for money, tell your placement cell straight away.',
  },
  {
    question: 'What happens when I accept an offer?',
    answer:
      'Under the one-offer rule your other applications in that drive close. After that, your joining date and documents are tracked until your first day.',
  },
  {
    question: 'My marks are wrong. How do I fix them?',
    answer:
      'Your marks come from your college’s records, so recruiters can trust them. Ask your placement cell to correct them - they update it for you.',
  },
  {
    question: 'Who can see my profile?',
    answer:
      'Your college, and the companies whose roles you apply to. Nobody else - and practice tools like mock interviews are never shown to recruiters.',
  },
];

export const helpListSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(5, 'Write the question.').max(300),
        answer: z.string().trim().min(5, 'Write the answer.').max(3000),
        isVisible: z.boolean().default(true),
      }),
    )
    .max(40, 'Forty questions is more than anybody will read.'),
});

export type HelpList = z.infer<typeof helpListSchema>;

/**
 * An institution's list as its admins edit it. `isDefault` is true when it
 * has never saved one: the defaults are handed over to start from.
 */
export async function tenantHelp(tenantId: string) {
  await loadTenant(tenantId);
  const rows = await prisma.helpQuestion.findMany({
    where: { tenantId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, question: true, answer: true, isVisible: true },
  });
  if (rows.length > 0) return { questions: rows, isDefault: false };
  return {
    questions: DEFAULT_QUESTIONS.map((q, i) => ({ id: `default-${i}`, ...q, isVisible: true })),
    isDefault: true,
  };
}

/** Replaces the institution's list with this one, in this order. */
export async function saveTenantHelp(tenantId: string, input: HelpList) {
  await loadTenant(tenantId);
  await prisma.$transaction([
    prisma.helpQuestion.deleteMany({ where: { tenantId } }),
    prisma.helpQuestion.createMany({
      data: input.questions.map((q, i) => ({
        tenantId,
        question: q.question,
        answer: q.answer,
        isVisible: q.isVisible,
        order: i,
      })),
    }),
  ]);
  await markStepById(tenantId, 'help');
  return tenantHelp(tenantId);
}

/** What a student sees: the visible questions, or the defaults if none were saved. */
export async function studentHelp(tenantId: string | undefined) {
  if (tenantId) {
    const rows = await prisma.helpQuestion.findMany({
      where: { tenantId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { question: true, answer: true, isVisible: true },
    });
    if (rows.length > 0) {
      return rows.filter((r) => r.isVisible).map(({ question, answer }) => ({ question, answer }));
    }
  }
  return DEFAULT_QUESTIONS;
}
