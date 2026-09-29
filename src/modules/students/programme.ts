import { prisma } from '../../lib/prisma.js';
import { normalise } from './fields.js';

/**
 * Which programme a student is on, resolved the same way wherever it is asked.
 *
 * ---------------------------------------------------------------------------
 * The problem this exists for
 *
 * A college runs a set of course-and-branch pairs - `CollegeProgram`. A
 * student is on exactly one of them. But the roster upload took Course and
 * Branch as two independent free-text columns and, when they did not match a
 * pair, stored the typed names and left `collegeProgramId` null without
 * saying anything.
 *
 * That is not a cosmetic problem. Every role's course and branch criteria
 * are matched on those names by exact string equality, so a college running
 * BCPM whose sheet said "B.Com" produced students who were invisible to every
 * BCPM role, for the rest of their degree, with nothing on any screen
 * explaining why. The commonest version was not even a wrong course - it was
 * a right course with the branch left blank.
 *
 * ---------------------------------------------------------------------------
 * How it resolves
 *
 * A ladder, cheapest first, and never guessing:
 *
 *   1. the pair, matched with case, spaces and punctuation stripped, so
 *      "B.C.P.M.", "bcpm" and "B C P M" are one answer
 *   2. a course named on its own, when the college runs exactly one branch
 *      of it - an MBA with no branches, or a college with one B.Tech
 *   3. an alias the college has taught, from a previous upload
 *   4. a suggestion, offered and never applied - auto-correcting somebody
 *      into a different degree is worse than refusing them
 *
 * A college with no programmes recorded has nothing to check against, so
 * whatever was typed is taken as given. That is the same fallback the
 * student's own profile form uses, and it is what stops a strict check
 * blocking a roster on a setup step that has nothing to do with the roster.
 */

export interface Programme {
  id: string;
  course: string;
  branch: string | null;
  /** What a person reads: "B.Tech — Computer Science", or "MBA" alone. */
  label: string;
}

export interface ProgrammeIndex {
  /** Empty when the college has recorded none, which turns the check off. */
  all: Programme[];
  byPair: Map<string, Programme>;
  byCourse: Map<string, Programme[]>;
  byAlias: Map<string, Programme>;
}

export const programmeLabel = (course: string, branch: string | null): string =>
  branch ? `${course} — ${branch}` : course;

/** The key a pair is matched on: separators and case carry no meaning. */
const pairKey = (course: string, branch: string | null): string =>
  normalise(`${course}${branch ?? ''}`);

/**
 * Everything one college runs, read once per upload rather than per row.
 *
 * A null college is a university-wide student nobody has placed yet. There
 * is no set of programmes to check against, so the index comes back empty
 * and the check turns itself off.
 */
export async function programmeIndex(collegeId: string | null): Promise<ProgrammeIndex> {
  const empty: ProgrammeIndex = {
    all: [],
    byPair: new Map(),
    byCourse: new Map(),
    byAlias: new Map(),
  };
  if (!collegeId) return empty;

  const [rows, aliases] = await Promise.all([
    prisma.collegeProgram.findMany({
      where: { collegeId },
      select: {
        id: true,
        course: { select: { name: true } },
        specialisation: { select: { name: true } },
      },
    }),
    prisma.programAlias.findMany({
      where: { collegeId },
      select: { alias: true, collegeProgramId: true },
    }),
  ]);

  if (rows.length === 0) return empty;

  const all: Programme[] = rows
    .map((r) => ({
      id: r.id,
      course: r.course.name,
      branch: r.specialisation?.name ?? null,
      label: programmeLabel(r.course.name, r.specialisation?.name ?? null),
    }))
    .sort((a, z) => a.label.localeCompare(z.label));

  const byPair = new Map<string, Programme>();
  const byCourse = new Map<string, Programme[]>();
  for (const p of all) {
    byPair.set(pairKey(p.course, p.branch), p);
    const key = normalise(p.course);
    byCourse.set(key, [...(byCourse.get(key) ?? []), p]);
  }

  const byId = new Map(all.map((p) => [p.id, p]));
  const byAlias = new Map<string, Programme>();
  for (const a of aliases) {
    const programme = byId.get(a.collegeProgramId);
    if (programme) byAlias.set(a.alias, programme);
  }

  return { all, byPair, byCourse, byAlias };
}

/** How far apart two normalised spellings are. Small and good enough. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = rows[0]!;
    rows[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const held = rows[j]!;
      rows[j] = Math.min(
        rows[j]! + 1,
        rows[j - 1]! + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = held;
    }
  }
  return rows[b.length]!;
}

/**
 * The closest programme to what somebody typed, if anything is close.
 *
 * A third of the length is the threshold: enough for a typo or a missing
 * suffix, not enough to turn B.Com into B.Tech. Offered as a question, never
 * applied - a student silently filed under the wrong degree is a worse
 * outcome than a refused row.
 */
function nearest(index: ProgrammeIndex, typed: string): Programme | null {
  let best: Programme | null = null;
  let bestAt = Infinity;

  for (const p of index.all) {
    for (const candidate of [pairKey(p.course, p.branch), normalise(p.course)]) {
      const d = distance(typed, candidate);
      if (d < bestAt) {
        bestAt = d;
        best = p;
      }
    }
  }

  return bestAt <= Math.max(2, Math.floor(typed.length / 3)) ? best : null;
}

/**
 * A programme written as one string, split back into a course and a branch.
 *
 * Only used when there is nothing to match against - a college that has not
 * recorded its programmes yet, or a row being let through unmapped. Without
 * it the single Programme column would be thrown away in exactly the case
 * where it is the only thing the sheet said.
 *
 * An en or em dash splits with or without spaces; a plain hyphen has to be
 * spaced, so "Post-Graduate Diploma" stays one course. Parentheses are the
 * other spelling people use: "B.Tech (Computer Science)".
 */
export function splitProgramme(text: string): { course: string; branch: string | null } {
  const whole = text.trim();

  for (const pattern of [/^(.+?)\s*[–—]\s*(.+)$/, /^(.+?)\s+-\s+(.+)$/, /^(.+?)\s*\((.+)\)$/]) {
    const hit = whole.match(pattern);
    if (hit) return { course: hit[1]!.trim(), branch: hit[2]!.trim() || null };
  }

  return { course: whole, branch: null };
}

export interface Resolution {
  /** The programme, when it was found. Null means unmapped. */
  programme: Programme | null;
  /** The names to store - the programme's own spelling, or what was typed. */
  course: string | null;
  branch: string | null;
  /**
   * Why it could not be matched. The caller decides whether that refuses the
   * row or merely warns: a placement cell mid-season may knowingly want the
   * students in with the mapping done afterwards.
   */
  problem?: string;
}

/** The college's list, for a message somebody can act on. */
const listOf = (index: ProgrammeIndex): string =>
  index.all.length <= 8
    ? index.all.map((p) => p.label).join(', ')
    : `${index.all.slice(0, 8).map((p) => p.label).join(', ')} and ${index.all.length - 8} more`;

export function resolveProgramme(
  index: ProgrammeIndex,
  input: { programme?: string | null; course?: string | null; branch?: string | null },
): Resolution {
  const programme = input.programme?.trim() || null;
  const course = input.course?.trim() || null;
  const branch = input.branch?.trim() || null;

  // What to fall back on: the pair as given, or the single column split
  // back into one. Either way it is what was typed, not a guess at what was
  // meant.
  const split = programme ? splitProgramme(programme) : null;
  const asTyped: Resolution = {
    programme: null,
    course: split?.course ?? course,
    branch: split?.branch ?? (split ? null : branch),
  };

  // Nothing to check against. Whatever was typed stands, which is what lets a
  // college upload its roster before anybody has mapped its programmes.
  if (index.all.length === 0) return asTyped;

  // Nothing said at all. Not an error: a class list without a course column
  // is normal, and the batch may supply one.
  if (!programme && !course) return asTyped;

  const found = (p: Programme): Resolution => ({
    programme: p,
    // The list's own spelling, always - so "b.tech" in one sheet and
    // "B.Tech" in another become one value a role can match.
    course: p.course,
    branch: p.branch,
  });

  /* --- the single Programme column --------------------------------------- */

  if (programme) {
    const key = normalise(programme);

    const pair = index.byPair.get(key);
    if (pair) return found(pair);

    const alias = index.byAlias.get(key);
    if (alias) return found(alias);

    const onlyCourse = index.byCourse.get(key);
    if (onlyCourse?.length === 1) return found(onlyCourse[0]!);
    if (onlyCourse && onlyCourse.length > 1) {
      return {
        ...asTyped,
        problem: `"${programme}" does not say which branch. This college runs ${onlyCourse
          .map((p) => p.label)
          .join(', ')}`,
      };
    }

    const guess = nearest(index, key);
    return {
      ...asTyped,
      problem: guess
        ? `"${programme}" is not a programme this college runs. Did you mean ${guess.label}?`
        : `"${programme}" is not a programme this college runs. It runs ${listOf(index)}`,
    };
  }

  /* --- the older Course and Branch pair ---------------------------------- */

  const pair = index.byPair.get(pairKey(course!, branch));
  if (pair) return found(pair);

  const alias = index.byAlias.get(pairKey(course!, branch)) ?? index.byAlias.get(normalise(course!));
  if (alias) return found(alias);

  const ofCourse = index.byCourse.get(normalise(course!));

  // The commonest failure by far: the right course with the branch left
  // blank. One branch means there is nothing to ask about.
  if (!branch && ofCourse?.length === 1) return found(ofCourse[0]!);
  if (!branch && ofCourse && ofCourse.length > 1) {
    return {
      ...asTyped,
      problem: `${course} needs a branch. This college runs ${ofCourse.map((p) => p.label).join(', ')}`,
    };
  }

  if (branch && ofCourse && ofCourse.length > 0) {
    return {
      ...asTyped,
      problem: `This college does not run ${course} – ${branch}. Its ${course} branches are ${ofCourse
        .map((p) => p.branch ?? '(no branch)')
        .join(', ')}`,
    };
  }

  const guess = nearest(index, pairKey(course!, branch));
  return {
    ...asTyped,
    problem: guess
      ? `This college does not run ${programmeLabel(course!, branch)}. Did you mean ${guess.label}?`
      : `This college does not run ${programmeLabel(course!, branch)}. It runs ${listOf(index)}`,
  };
}

/**
 * Teaches a college that a spelling means one of its programmes.
 *
 * Stored normalised, because that is how it is matched. Unique per college:
 * one word may not mean two different degrees at the same place, and saying
 * so plainly is better than resolving it at random later.
 */
export async function teachAlias(
  collegeId: string,
  collegeProgramId: string,
  spelling: string,
  createdById: string | null,
): Promise<{ alias: string }> {
  const alias = normalise(spelling);
  if (!alias) throw new Error('An alias needs some letters in it.');

  await prisma.programAlias.upsert({
    where: { collegeId_alias: { collegeId, alias } },
    update: { collegeProgramId, createdById },
    create: { collegeId, collegeProgramId, alias, createdById },
  });

  return { alias };
}
