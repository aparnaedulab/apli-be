import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { parseStudentRows, type StudentRow } from './students.service.js';
import { parseStudentWorkbook } from './students.template.js';

/** One row of a class list. Only name, email and mobile are required. */
export const studentRowSchema = z.object({
  fullName: z.string().trim().max(120),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(24),
  college: z.string().trim().max(200).optional(),
  batch: z.string().trim().max(120).optional(),
  course: z.string().trim().max(120).optional(),
  specialisation: z.string().trim().max(120).optional(),
  graduationYear: z.string().trim().max(8).optional(),
  rollNo: z.string().trim().max(40).optional(),
  prn: z.string().trim().max(40).optional(),
  division: z.string().trim().max(20).optional(),
  gender: z.string().trim().max(30).optional(),
  dateOfBirth: z.string().trim().max(24).optional(),
  cgpa: z.string().trim().max(8).optional(),
  degreePct: z.string().trim().max(8).optional(),
  tenthPct: z.string().trim().max(8).optional(),
  twelfthPct: z.string().trim().max(8).optional(),
  diplomaPct: z.string().trim().max(8).optional(),
  pgCgpa: z.string().trim().max(8).optional(),
  pgPct: z.string().trim().max(8).optional(),
  backlogs: z.string().trim().max(4).optional(),
  activeBacklogs: z.string().trim().max(4).optional(),
  gapYears: z.string().trim().max(4).optional(),
});

/**
 * The three ways a class list arrives, resolved to one list of rows.
 *
 * A spreadsheet, a paste, or rows typed one at a time. They differ only in
 * how the person had the data to hand, so they meet here and everything
 * downstream - validation, batch resolution, partial success - is identical
 * whichever door was used.
 */
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
