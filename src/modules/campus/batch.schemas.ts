import { z } from 'zod';

/**
 * A batch is a group somebody chooses to treat together, and nothing about it
 * is required.
 *
 * Every field describes the group where a single answer happens to exist -
 * true of a degree cohort, not true of "Second year" or "Mechanical" or a
 * shortlist made for one drive. Even the name is optional: a batch always ends
 * up with one, but it is derived from whatever was given rather than demanded
 * before anything can be saved. It can be renamed at any time.
 */
export const batchSchema = z.object({
  name: z.string().trim().max(120).optional().or(z.literal('')),
  course: z.string().trim().max(120).optional().or(z.literal('')),
  specialisation: z.string().trim().max(120).optional().or(z.literal('')),
  graduationYear: z.coerce
    .number()
    .int()
    .min(2000, 'Enter a four-digit year.')
    .max(2100, 'Enter a four-digit year.')
    .optional(),
  studyYear: z.coerce
    .number()
    .int()
    .min(1, 'Which year of the degree - 1 to 6.')
    .max(6, 'Which year of the degree - 1 to 6.')
    .optional(),
  headOfDept: z.string().trim().max(120).optional().or(z.literal('')),
});

/** Empty strings from a form mean "not given", which in SQL is NULL. */
export function toBatchData(d: z.infer<typeof batchSchema>) {
  return {
    name: d.name || '',
    course: d.course || null,
    specialisation: d.specialisation || null,
    graduationYear: d.graduationYear ?? null,
    studyYear: d.studyYear ?? null,
    headOfDept: d.headOfDept || null,
  };
}

/**
 * The name a batch ends up with when nobody typed one.
 *
 * Built from whatever was given, in the order a person would say it out loud:
 * "B.Tech Computer Science 2026", "Year 2", or failing everything else a
 * plainly temporary name that asks to be changed.
 */
/**
 * A passing year as the university says it: the academic year it ends.
 * Stored as the year students pass out (2027), shown as "2026-2027".
 */
export function academicYearLabel(passingYear: number): string {
  return `${passingYear - 1}-${passingYear}`;
}

export function deriveBatchName(
  d: { course?: string; specialisation?: string; graduationYear?: number; studyYear?: number },
  fallbackIndex: number,
): string {
  const parts = [d.course, d.specialisation, d.graduationYear ? academicYearLabel(d.graduationYear) : null]
    .map((p) => p?.toString().trim())
    .filter(Boolean);

  if (parts.length > 0) return parts.join(' ').slice(0, 120);
  if (d.studyYear) return `Year ${d.studyYear}`;
  return `Untitled batch ${fallbackIndex}`;
}

/**
 * Settles on a name that is free within its scope.
 *
 * A derived name can easily collide - two untitled batches, or two B.Tech 2026
 * groups - so a number is appended rather than the save being refused. Nobody
 * asked for this name; they should not have to resolve a clash over it.
 */
export async function uniqueBatchName(
  taken: (name: string) => Promise<boolean>,
  base: string,
): Promise<string> {
  if (!(await taken(base))) return base;

  for (let n = 2; n < 500; n++) {
    const candidate = `${base} (${n})`.slice(0, 120);
    if (!(await taken(candidate))) return candidate;
  }
  return `${base} ${Date.now()}`.slice(0, 120);
}
