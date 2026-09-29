import { RefKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The small vocabularies a student record is checked against.
 *
 * One reader, used by both doors. The student's own form has offered gender
 * as a list from `RefValue` for a long time; the import took free text, so a
 * roster full of "M", "MALE" and "male" quietly made every one-gender role
 * invisible to those students - `visibility.ts` groups on the recorded
 * spelling.
 */

/** The genders operations keeps, in the order they are listed. */
export async function activeGenders(): Promise<string[]> {
  const rows = await prisma.refValue.findMany({
    where: { kind: RefKind.GENDER, isActive: true },
    orderBy: [{ position: 'asc' }, { value: 'asc' }],
    select: { value: true },
  });
  return rows.map((r) => r.value);
}

/**
 * The listed spelling of what somebody typed, or why it cannot be used.
 *
 * Matched loosely - case and spacing as a spreadsheet happened to have them
 * are not a different answer - and rewritten to the list's own spelling, so
 * one roster cannot record "female" where another records "Female" and have
 * a role see only one of them.
 *
 * An institution whose list is empty has nothing to check against, so the
 * text is taken as given. That is the same fallback the programme check
 * uses: refusing everything because nobody has set the list up yet would
 * block a roster on a step that has nothing to do with the roster.
 */
export function matchGender(
  value: string | null,
  allowed: readonly string[],
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (!value) return { ok: true, value: null };
  if (allowed.length === 0) return { ok: true, value };

  const want = value.trim().toLowerCase();
  const hit = allowed.find((a) => a.trim().toLowerCase() === want);
  if (hit) return { ok: true, value: hit };

  return {
    ok: false,
    reason: `"${value}" is not one of the genders this portal lists (${allowed.join(', ')})`,
  };
}
