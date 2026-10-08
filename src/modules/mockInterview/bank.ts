import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  defaultQuestions,
  idealFor,
  isRole,
  pickFrom,
  QUESTION_TYPES,
  type InterviewKind,
  type Question,
  type QuestionType,
  type RoleKey,
} from './questions.js';

/**
 * The mock-interview question bank, per institution.
 *
 * Each round (HR, managerial, and technical per role) is a list an
 * institution's admin can edit. A round the institution has never saved uses
 * the platform's built-in questions, so the tool always works. Saving a round
 * replaces that round's list as a whole, in the order given.
 */

export const roundSchema = z
  .object({
    kind: z.enum(['HR', 'TECHNICAL', 'MANAGERIAL']),
    role: z.string().default(''),
  })
  .refine((r) => (r.kind === 'TECHNICAL' ? isRole(r.role) : true), {
    message: 'Choose a role for a technical round.',
    path: ['role'],
  });

export const saveRoundSchema = z.object({
  questions: z
    .array(
      z.object({
        text: z.string().trim().min(8, 'Write the question.').max(400),
        type: z.enum(QUESTION_TYPES as [QuestionType, ...QuestionType[]]),
        isVisible: z.boolean().default(true),
      }),
    )
    .max(80, 'Eighty questions in one round is plenty.'),
});

const roleOf = (kind: InterviewKind, role: string) => (kind === 'TECHNICAL' ? role : '');

/** One round, as an admin edits it. `isDefault` until the institution saves it. */
export async function adminRound(tenantId: string, kind: InterviewKind, role: string) {
  const rows = await prisma.interviewQuestion.findMany({
    where: { tenantId, kind, role: roleOf(kind, role) },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, text: true, type: true, isVisible: true },
  });
  if (rows.length > 0) return { questions: rows, isDefault: false };
  return {
    questions: defaultQuestions(kind, roleOf(kind, role) as RoleKey | '').map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      isVisible: true,
    })),
    isDefault: true,
  };
}

export async function saveRound(
  tenantId: string,
  kind: InterviewKind,
  role: string,
  input: z.infer<typeof saveRoundSchema>,
) {
  const r = roleOf(kind, role);
  await prisma.$transaction([
    prisma.interviewQuestion.deleteMany({ where: { tenantId, kind, role: r } }),
    prisma.interviewQuestion.createMany({
      data: input.questions.map((q, i) => ({ tenantId, kind, role: r, text: q.text, type: q.type, isVisible: q.isVisible, order: i })),
    }),
  ]);
  return adminRound(tenantId, kind, role);
}

/** The questions a student can be asked in this round: the institution's visible ones, or the defaults. */
async function poolFor(tenantId: string | undefined, kind: InterviewKind, role: RoleKey): Promise<Question[]> {
  if (tenantId) {
    const rows = await prisma.interviewQuestion.findMany({
      where: { tenantId, kind, role: roleOf(kind, role) },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    if (rows.length > 0) {
      return rows
        .filter((x) => x.isVisible)
        .map((x) => ({ id: x.id, text: x.text, type: x.type as QuestionType, ideal: idealFor(x.type as QuestionType) }));
    }
  }
  return defaultQuestions(kind, roleOf(kind, role) as RoleKey | '');
}

/** The five questions for a new session, fixed at the start. */
export async function questionsForNewSession(
  tenantId: string | undefined,
  kind: InterviewKind,
  role: RoleKey,
  sessionId: string,
): Promise<Question[]> {
  const pool = await poolFor(tenantId, kind, role);
  return pickFrom(pool, kind, sessionId);
}
