import { z } from 'zod';
import { SHARED_FIELDS, type FieldsConst, type StudentField } from './fields.js';

/**
 * The half of a student's own form that a college could also have filled in.
 *
 * Generated from the field registry, so the student's form and the class-list
 * upload cannot bound the same fact differently - which they did, in both
 * directions: the form capped backlogs at fifty and the graduating year at
 * 2100 where the sheet took any number at all, and the sheet insisted on ten
 * digits of mobile number where the form let a student blank it.
 *
 * The one thing the two are still allowed to differ on is whether a field is
 * required. The upload is creating a record somebody has to be able to reach;
 * the form is editing one that already exists, and refusing to save a
 * headline because the phone box is empty helps nobody. The *format* check is
 * the same either way.
 */

function zodFor(f: StudentField): z.ZodTypeAny {
  switch (f.type) {
    case 'phone':
      return z
        .string()
        .trim()
        .max(f.maxLength ?? 24)
        .refine(
          // Loose on purpose, and identical to the upload's rule: numbers
          // arrive as 9000000000, +91 90000 00000 and 090000-00000.
          (v) => v === '' || (v.match(/\d/g) ?? []).length >= 10,
          'Enter a mobile number with at least ten digits in it.',
        )
        .optional()
        .or(z.literal(''));

    case 'date':
      return z.string().datetime().optional().or(z.literal(''));

    case 'bool':
      return z.boolean().optional();

    case 'int':
      return z.coerce.number().int().min(f.min ?? 0).max(f.max ?? Number.MAX_SAFE_INTEGER).optional();

    case 'decimal':
      return z.coerce.number().min(f.min ?? 0).max(f.max ?? Number.MAX_SAFE_INTEGER).optional();

    // Text, an email, and a value from one of the small vocabularies. The
    // vocabulary itself is checked in the handler, where the database can be
    // read - the same place the course and branch pair is checked.
    default:
      return z
        .string()
        .trim()
        .max(f.maxLength ?? 255)
        .optional()
        .or(z.literal(''));
  }
}

/** Spread into the profile's own schema alongside the student-only fields. */
export const sharedBasicsShape = Object.fromEntries(
  SHARED_FIELDS.map((f) => [f.key, zodFor(f)]),
) as Record<string, z.ZodTypeAny>;

/* -------------------------------------------------------------------------- */

type SharedEntry = Extract<FieldsConst[number], { owner: 'shared' }>;

type ValueOf<F> = F extends { type: 'bool' }
  ? boolean
  : F extends { type: 'int' } | { type: 'decimal' }
    ? number
    : string;

/**
 * What those fields look like once parsed.
 *
 * Derived from the registry too, so adding a shared field cannot leave the
 * handler writing a key the schema does not accept - or quietly dropping one
 * it does.
 */
export type SharedBasics = { [F in SharedEntry as F['key']]?: ValueOf<F> };
