import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The branch master list, and how a new name is checked against it.
 *
 * The point of the list is one spelling per discipline, so adding a branch is
 * where spelling mistakes are caught: an exact match (ignoring case) is the
 * same branch, and a near match ("Computer Engg" beside "Computer
 * Engineering") is flagged for a person to decide rather than silently added.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Short forms people write for the same word. */
const EXPANSIONS: [RegExp, string][] = [
  [/\bengg?\.?\b/g, 'engineering'],
  [/\beng\b/g, 'engineering'],
  [/\bcomp\b/g, 'computer'],
  [/\bsci\b/g, 'science'],
  [/\btech\b/g, 'technology'],
  [/\bmech\b/g, 'mechanical'],
  [/\belec\b/g, 'electrical'],
  [/\bi\.?t\.?\b/g, 'information technology'],
  [/&/g, ' and '],
];

/** A name reduced to what it means: lower case, short forms spelt out, no punctuation. */
export function normaliseBranch(name: string): string {
  let s = name.toLowerCase();
  for (const [re, to] of EXPANSIONS) s = s.replace(re, to);
  return s.replace(/[^a-z0-9]+/g, ' ').replace(/\b(and|of|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Whether two branch names are probably the same branch written differently. */
export function looksLikeSameBranch(a: string, b: string): boolean {
  const x = normaliseBranch(a);
  const y = normaliseBranch(b);
  if (!x || !y) return false;
  if (x === y) return true;

  // Word by word, one name abbreviating the other: "Biotech" / "Biotechnology",
  // "Elec Comm" / "Electronics Communication". Each short word must be the
  // start of its partner and at least three letters, so "IT" matches nothing.
  const xs = x.split(' ');
  const ys = y.split(' ');
  if (
    xs.length === ys.length &&
    xs.every((w, i) => {
      const v = ys[i]!;
      const [short, long] = w.length <= v.length ? [w, v] : [v, w];
      return short === long || (short.length >= 3 && long.startsWith(short));
    })
  ) {
    return true;
  }

  const longest = Math.max(x.length, y.length);
  // Allow roughly one slip per eight letters: "Mechancal" is Mechanical,
  // "Civil" is not "Chemical".
  return distance(x, y) <= Math.max(1, Math.floor(longest / 8));
}

/** The branch with this exact name (ignoring case), creating it if there is none. */
export async function ensureBranch(db: Db, name: string) {
  const clean = name.trim().replace(/\s+/g, ' ');
  const existing = await db.branch.findFirst({ where: { name: clean } });
  if (existing) return existing;
  return db.branch.create({ data: { name: clean } });
}
