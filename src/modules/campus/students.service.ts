import { randomBytes } from 'node:crypto';
import { InviteKind, Prisma, Role, type Batch } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../auth/auth.service.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';

/**
 * What a placement cell already holds about a student before that student has
 * ever signed in. Everything here comes from the college's own records, which
 * is exactly why it belongs at roster time: the numbers recruiters filter on
 * should come from the institution, not from the candidate.
 *
 * Name, email and mobile are required - those three are how anyone reaches the
 * student, and a roster entry without them is not usable. Everything else is
 * optional and can be filled in later, by the college or by the student.
 *
 * The batch travels with the student rather than being set up first. A class
 * list already has a class column, and making someone create batches before
 * they can paste it is a step that exists only because of how the tables are
 * shaped. Batches are created as they are met.
 */
export interface StudentRow {
  fullName: string;
  email: string;
  phone: string;

  /**
   * The college's code, for a university-level upload that spans colleges.
   * Ignored everywhere the college is already known.
   */
  college?: string;

  // The batch, per student. Ignored when adding from inside one.
  batch?: string;
  course?: string;
  specialisation?: string;
  graduationYear?: string;

  rollNo?: string;
  prn?: string;
  division?: string;
  gender?: string;
  dateOfBirth?: string;
  cgpa?: string;
  degreePct?: string;
  tenthPct?: string;
  twelfthPct?: string;
  /** What a lateral entrant has where a 12th standard result would be. */
  diplomaPct?: string;
  /** The master's, for a student already holding a degree. */
  pgCgpa?: string;
  pgPct?: string;
  backlogs?: string;
  /** Still outstanding, as against ever accumulated. */
  activeBacklogs?: string;
  gapYears?: string;
}

export interface AddStudentsResult {
  created: { name: string; email: string; rollNo: string | null; batch: string; link: string }[];
  skipped: { email: string; reason: string }[];
  /** Batches that did not exist and were created along the way. */
  batchesCreated: { id: string; name: string; graduationYear: number | null }[];
}

const dec = (v: string | undefined, max: number): Prisma.Decimal | null => {
  if (!v?.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) && n >= 0 && n <= max ? new Prisma.Decimal(n.toFixed(2)) : null;
};

const int = (v: string | undefined): number | null => {
  if (!v?.trim()) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Accepts 2005-04-17 and 17/04/2005, which is what spreadsheets here produce. */
const date = (v: string | undefined): Date | null => {
  const raw = v?.trim();
  if (!raw) return null;

  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const iso = dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}` : raw;

  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const text = (v: string | undefined): string | null => v?.trim() || null;

export interface AddStudentsOptions {
  /** Set when adding from inside one batch, which then wins over the rows. */
  batch?: Batch;
  /**
   * The institution, needed only when there is no college: a student the
   * university has not placed in a college yet still has to belong to it.
   */
  tenantId?: string;
}

/** A college's programmes, keyed the way a row names them. */
type ProgramIndex = Map<string, { id: string; course: string; branch: string | null }>;

const programKey = (course: string, branch: string | null) =>
  `${course.trim().toLowerCase()}|${(branch ?? '').trim().toLowerCase()}`;

export async function programIndex(collegeId: string): Promise<ProgramIndex> {
  const programs = await prisma.collegeProgram.findMany({
    where: { collegeId },
    select: {
      id: true,
      course: { select: { name: true } },
      specialisation: { select: { name: true } },
    },
  });
  return new Map(
    programs.map((p) => [
      programKey(p.course.name, p.specialisation?.name ?? null),
      { id: p.id, course: p.course.name, branch: p.specialisation?.name ?? null },
    ]),
  );
}

/**
 * Adds students to a college from a list the placement cell already has.
 *
 * Records are created immediately - names, roll numbers and marks show on the
 * roster at once - while the password is left unset. Each student then claims
 * their own account through a one-time link, so nobody but the student ever
 * knows their password.
 *
 * Partial success is the normal case: one bad row in a paste of three hundred
 * must not lose the other two hundred and ninety-nine.
 */
export async function addStudents(
  collegeId: string | null,
  rows: StudentRow[],
  sentById: string,
  options: AddStudentsOptions = {},
): Promise<AddStudentsResult> {
  const result: AddStudentsResult = { created: [], skipped: [], batchesCreated: [] };

  const tenantId =
    options.tenantId ??
    (collegeId
      ? (
          await prisma.college.findUniqueOrThrow({
            where: { id: collegeId },
            select: { tenantId: true },
          })
        ).tenantId
      : null);
  if (!tenantId) throw new Error('A student with no college needs an institution to belong to.');

  // A row whose course and branch are a programme this college runs is
  // mapped on the way in, so a clean upload needs no Map data step at all.
  const programs: ProgramIndex = collegeId ? await programIndex(collegeId) : new Map();
  const seenEmails = new Set<string>();
  const seenRolls = new Set<string>();
  const seenPrns = new Set<string>();

  // Resolved once per distinct class in the paste, not once per student.
  const batchCache = new Map<string, Batch>();

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    const fullName = row.fullName.trim();
    const phone = row.phone?.trim() ?? '';
    const rollNo = text(row.rollNo);
    const prn = text(row.prn);

    const missing = [
      !fullName && 'a name',
      !email && 'an email',
      !phone && 'a mobile number',
    ].filter(Boolean);

    if (missing.length > 0) {
      result.skipped.push({
        email: email || fullName || '(blank row)',
        reason: `Needs ${missing.join(' and ')}`,
      });
      continue;
    }

    // Loose on purpose: numbers arrive as 9000000000, +91 90000 00000 and
    // 090000-00000. Ten digits somewhere in there is the only real check.
    if ((phone.match(/\d/g) ?? []).length < 10) {
      result.skipped.push({ email, reason: `"${phone}" does not look like a mobile number` });
      continue;
    }
    if (seenEmails.has(email)) {
      result.skipped.push({ email, reason: 'Listed more than once' });
      continue;
    }
    seenEmails.add(email);

    let batch: Batch;
    try {
      batch = await resolveBatch(collegeId, tenantId, row, options.batch, batchCache, result);
    } catch (err) {
      result.skipped.push({
        email,
        reason: err instanceof Error ? err.message : 'Could not work out the batch',
      });
      continue;
    }

    // Roll numbers are unique per batch, so the key includes it.
    const rollKey = rollNo ? `${batch.id}:${rollNo}` : null;
    if (rollKey && seenRolls.has(rollKey)) {
      result.skipped.push({ email, reason: `Roll number ${rollNo} appears twice in ${batch.name}` });
      continue;
    }
    if (rollKey) seenRolls.add(rollKey);

    if (prn && seenPrns.has(prn)) {
      result.skipped.push({ email, reason: `PRN ${prn} appears twice in this list` });
      continue;
    }
    if (prn) seenPrns.add(prn);

    try {
      if (await prisma.user.findUnique({ where: { email } })) {
        result.skipped.push({ email, reason: 'Someone with that email already has an account' });
        continue;
      }
      if (prn && (await prisma.candidate.findUnique({ where: { prn } }))) {
        result.skipped.push({ email, reason: `PRN ${prn} already belongs to another student` });
        continue;
      }
      if (
        rollNo &&
        (await prisma.batchMembership.findFirst({ where: { batchId: batch.id, rollNo } }))
      ) {
        result.skipped.push({
          email,
          reason: `Roll number ${rollNo} is already used in ${batch.name}`,
        });
        continue;
      }

      // Unguessable and never shared: the account is unusable until the student
      // sets their own password through the activation link.
      const placeholder = await hashPassword(randomBytes(32).toString('hex'));

      const course = text(row.course) ?? batch.course;
      const branch = text(row.specialisation) ?? batch.specialisation;
      const program = course ? programs.get(programKey(course, branch)) : undefined;

      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            fullName,
            passwordHash: placeholder,
            role: Role.CANDIDATE,
            // Not a login yet, only a record. Accepting the invitation turns it
            // on, so a roster row can never be signed into before the student
            // has claimed it - belt as well as the unguessable password.
            isActive: false,
          },
        });
        const candidate = await tx.candidate.create({
          data: {
            userId: created.id,
            collegeId,
            // The row first, the batch as a fallback. A batch called "Second
            // year" has no course to lend, and that must not leave the student
            // without one when their own row said B.Tech.
            //
            // A match with one of the college's programmes takes that
            // programme's spelling, so "b.tech" in a sheet reads as B.Tech.
            course: program?.course ?? course,
            specialisation: program ? program.branch : branch,
            collegeProgramId: program?.id ?? null,
            graduationYear: int(row.graduationYear) ?? batch.graduationYear,
            prn,
            phone,
            gender: text(row.gender),
            dateOfBirth: date(row.dateOfBirth),
            cgpa: dec(row.cgpa, 10),
            degreePct: dec(row.degreePct, 100),
            tenthPct: dec(row.tenthPct, 100),
            twelfthPct: dec(row.twelfthPct, 100),
            diplomaPct: dec(row.diplomaPct, 100),
            // The bachelor's lives in cgpa/degreePct above; these are the
            // MCA or M.Tech on top of it, blank for most of a roster.
            pgCgpa: dec(row.pgCgpa, 10),
            pgPct: dec(row.pgPct, 100),
            backlogs: int(row.backlogs),
            // Two different criteria on every campus criteria sheet: "no live
            // backlogs" and "no more than two ever". Recorded apart, because
            // a role may ask about either and a missing one fails its bar.
            activeBacklogs: int(row.activeBacklogs),
            gapYears: int(row.gapYears),
          },
        });
        await tx.batchMembership.create({
          data: {
            batchId: batch.id,
            candidateId: candidate.id,
            rollNo,
            division: text(row.division),
          },
        });
        return created;
      });

      const { token } = await createInvite({
        kind: InviteKind.STUDENT,
        email,
        invitedName: fullName,
        batchId: batch.id,
        userId: user.id,
        sentById,
      });

      result.created.push({
        name: fullName,
        email,
        rollNo,
        batch: batch.name,
        link: inviteLinkFor(token),
      });
    } catch (err) {
      result.skipped.push({
        email,
        reason: err instanceof Error ? err.message : 'Could not add this student',
      });
    }
  }

  return result;
}

/** Where students go when the list did not say. */
export const UNASSIGNED = 'Unassigned';

/**
 * Finds the batch a row belongs to, creating it if this is the first student
 * in it.
 *
 * Matched on the name alone, within the college. The college names its own
 * batches and a name means one group there - which is what lets a batch be
 * "Second year" or "Mechanical" rather than only ever a degree-and-year.
 *
 * Course and graduating year, if the row carries them, are recorded on the
 * batch as defaults for whoever is added next. They are not what makes the
 * batch, and a batch created without them is perfectly usable.
 */
async function resolveBatch(
  collegeId: string | null,
  tenantId: string,
  row: StudentRow,
  fixed: Batch | undefined,
  cache: Map<string, Batch>,
  result: AddStudentsResult,
): Promise<Batch> {
  // Adding from inside a batch: that batch wins, whatever the row says.
  if (fixed) return fixed;

  // A paste with no batch column at all still has to land somewhere, so it
  // lands in one group per college rather than being refused. It can be
  // renamed, or its students moved, afterwards.
  const name = text(row.batch) ?? UNASSIGNED;

  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  // With no college this is a university-wide batch, which the tenant fences.
  const existing = await prisma.batch.findFirst({ where: { collegeId, tenantId, name } });
  if (existing) {
    cache.set(key, existing);
    return existing;
  }

  const created = await prisma.batch.create({
    data: {
      collegeId,
      tenantId,
      name,
      course: text(row.course),
      specialisation: text(row.specialisation),
      graduationYear: int(row.graduationYear),
    },
  });

  cache.set(key, created);
  result.batchesCreated.push({
    id: created.id,
    name: created.name,
    graduationYear: created.graduationYear,
  });
  return created;
}

/* -------------------------------------------------------------------------- */
/* Pasting a spreadsheet                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Header names are matched loosely - "Roll No.", "roll_no" and "ROLLNO" all
 * mean the same column - because the alternative is telling a placement officer
 * to reformat a spreadsheet they did not write.
 */
export const HEADERS: Record<keyof StudentRow, string[]> = {
  fullName: ['name', 'fullname', 'studentname', 'student'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'mobileno', 'contact', 'contactno', 'phoneno'],
  college: ['college', 'collegecode', 'institute', 'institutecode'],
  batch: ['batch', 'class', 'batchname'],
  course: ['course', 'degree', 'programme', 'program'],
  specialisation: ['specialisation', 'specialization', 'branch', 'stream'],
  graduationYear: [
    'year',
    'graduationyear',
    'graduatingyear',
    'passingyear',
    'passoutyear',
    'batchyear',
  ],
  rollNo: ['rollno', 'roll', 'rollnumber'],
  prn: ['prn', 'enrolmentno', 'enrollmentno', 'enrolmentnumber', 'registrationno', 'universityid'],
  division: ['division', 'div', 'section'],
  gender: ['gender', 'sex'],
  dateOfBirth: ['dob', 'dateofbirth', 'birthdate'],
  cgpa: ['cgpa', 'gpa', 'sgpa'],
  degreePct: ['percentage', 'percent', 'degreepercentage', 'aggregate', 'marks'],
  diplomaPct: ['diploma', 'diplomapercentage', 'diplomapct', 'diplomamarks'],
  pgCgpa: ['pgcgpa', 'postgraduationcgpa', 'mastercgpa', 'mtechcgpa', 'mcacgpa'],
  pgPct: ['pg', 'pgpercentage', 'pgpct', 'pgmarks', 'postgraduationpercentage', 'masterpercentage'],
  activeBacklogs: ['activebacklogs', 'livebacklogs', 'currentbacklogs', 'standingarrears', 'activearrears'],
  gapYears: ['gapyears', 'gap', 'yeargap', 'educationgap', 'breakinstudies'],
  tenthPct: ['10th', 'tenth', '10thpercentage', 'sscpercentage', 'ssc', 'x'],
  twelfthPct: ['12th', 'twelfth', '12thpercentage', 'hscpercentage', 'hsc', 'xii'],
  backlogs: ['backlogs', 'backlog', 'backlogstotal', 'totalbacklogs', 'kt', 'kts', 'atkt', 'deadbacklogs'],
};

export const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Header text to field, built from HEADERS.
 *
 * One map, shared with the spreadsheet reader. Two alias lists is how the
 * template came to print a "Graduating year" column that the paste box then
 * silently ignored.
 */
export const FIELD_BY_HEADER = new Map<string, keyof StudentRow>(
  (Object.entries(HEADERS) as [keyof StudentRow, string[]][]).flatMap(([field, aliases]) =>
    aliases.map((alias) => [alias, field] as [string, keyof StudentRow]),
  ),
);

function headerMap(cells: string[]): Partial<Record<number, keyof StudentRow>> | null {
  const map: Partial<Record<number, keyof StudentRow>> = {};
  let matched = 0;

  cells.forEach((cell, i) => {
    const key = normalise(cell);
    for (const [field, aliases] of Object.entries(HEADERS) as [keyof StudentRow, string[]][]) {
      if (aliases.includes(key)) {
        map[i] = field;
        matched++;
        return;
      }
    }
  });

  // A header row has to name the email column at least, or it is probably just
  // the first student.
  return matched >= 2 && Object.values(map).includes('email') ? map : null;
}

const splitCells = (line: string) => line.split(/[\t,;]/).map((c) => c.trim());

/**
 * Parses pasted rows.
 *
 * With a header row, columns can be in any order and any subset - which is the
 * only workable answer once there are a dozen of them. Without one, it falls
 * back to name, email, mobile, roll number, locating the email by its "@".
 */
export function parseStudentRows(input: string): StudentRow[] {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const map = headerMap(splitCells(lines[0]!));

  if (map) {
    return lines.slice(1).map((line) => {
      const cells = splitCells(line);
      const row: StudentRow = { fullName: '', email: '', phone: '' };
      for (const [index, field] of Object.entries(map)) {
        const value = cells[Number(index)];
        if (value) row[field as keyof StudentRow] = value;
      }
      return row;
    });
  }

  return lines
    .map((line) => {
      const cells = splitCells(line);
      const emailIndex = cells.findIndex((c) => c.includes('@'));
      if (emailIndex === -1) return { fullName: cells[0] ?? '', email: '', phone: '' };

      const rest = cells.filter((_, i) => i !== emailIndex);
      return {
        fullName: rest[0] ?? '',
        email: cells[emailIndex]!,
        phone: rest[1] ?? '',
        rollNo: rest[2],
      };
    })
    .filter((r) => r.email || r.fullName);
}
