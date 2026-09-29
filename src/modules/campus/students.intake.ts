import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { parseStudentRows, type StudentRow } from './students.service.js';
import { STUDENT_FIELDS, type StudentFieldKey } from '../students/fields.js';
import { parseStudentWorkbook } from './students.template.js';

/**
 * One row of a class list, as JSON.
 *
 * Built from the student field registry, so the typed-in form and the
 * spreadsheet accept exactly the same columns. Every value arrives as a
 * string here and is bounded later by `readCell`, using the same ranges the
 * student's own profile form enforces - this schema only guards the length
 * of the text, which is what keeps a 60,000-character paste out of a
 * VARCHAR(40).
 */
export const studentRowSchema = z.object(
  Object.fromEntries(
    STUDENT_FIELDS.map((f) => {
      // A number, a date or a yes/no still arrives as text; 24 characters is
      // more than any of them needs and less than any of them abuses.
      const text = z.string().trim().max(f.maxLength ?? 24);
      return [f.key, f.requiredOnImport ? text : text.optional()];
    }),
  ) as unknown as RowShape,
);

/**
 * The shape the generated object actually has.
 *
 * Building it in a loop loses which keys are required, and zod's inferred
 * type is what the rest of the module relies on - so it is restated here
 * once, in terms of the same three required fields the registry marks.
 */
type Required = 'fullName' | 'email' | 'phone';
type RowShape = Record<Required, z.ZodString> &
  Record<Exclude<StudentFieldKey, Required>, z.ZodOptional<z.ZodString>>;

/**
 * The three ways a class list arrives, resolved to one list of rows.
 *
 * A spreadsheet, a paste, or rows typed one at a time. They differ only in
 * how the person had the data to hand, so they meet here and everything
 * downstream - validation, batch resolution, partial success - is identical
 * whichever door was used.
 */
/**
 * How the caller wants the list treated.
 *
 * Both come off the query string rather than the body, because the same two
 * answers have to work for a JSON paste and for a multipart file upload, and
 * a query string is the one place both can carry them.
 */
export function intakeOptions(req: Request): { dryRun: boolean; allowUnmapped: boolean } {
  const on = (v: unknown) => v === '1' || v === 'true';
  return { dryRun: on(req.query.dryRun), allowUnmapped: on(req.query.allowUnmapped) };
}

export async function rowsFromRequest(req: Request): Promise<StudentRow[]> {
  const file = req.file;

  if (file) {
    const rows = /\.csv$/i.test(file.originalname)
      ? parseStudentRows(file.buffer.toString('utf8'))
      : await parseStudentWorkbook(file.buffer);

    if (rows.length === 0) {
      throw badRequest(
        'No students found in that file. Check the first row names the columns - the template shows the shape.',
      );
    }
    return rows;
  }

  const body = z
    .object({
      students: z.array(studentRowSchema).max(500).optional(),
      text: z.string().max(60_000).optional(),
    })
    .parse(req.body ?? {});

  const rows = body.students ?? (body.text ? parseStudentRows(body.text) : []);
  if (rows.length === 0) throw badRequest('Add at least one student.');

  return rows;
}
