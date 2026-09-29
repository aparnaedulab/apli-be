import { randomBytes } from 'node:crypto';
import { InviteKind, Prisma, Role, type Batch } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../auth/auth.service.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import {
  STUDENT_FIELDS,
  fieldFor,
  importFields,
  normalise,
  readCell,
  FIELD_BY_HEADER,
  type StudentFieldKey,
} from '../students/fields.js';
import { activeGenders, matchGender } from '../students/lists.js';
import {
  programmeIndex,
  resolveProgramme,
  type ProgrammeIndex,
} from '../students/programme.js';
import { isOn, missingRequired, policyFor, type IntakePolicy } from '../students/policy.js';

/**
 * One row of a class list, as a spreadsheet hands it over: every cell a
 * string, whatever the value turns out to mean.
 *
 * Derived from the student field registry rather than written out, so a
 * column cannot exist on the template and be missing here - which is how the
 * template came to print a "Graduating year" the paste box then ignored.
 *
 * Name, email and mobile are required: those three are how anyone reaches
 * the student, and a roster entry without them is not usable. Everything
 * else is optional and can be filled in later, by the college or by the
 * student themselves.
 *
 * The batch travels with the student rather than being set up first. A class
 * list already has a class column, and making someone create batches before
 * they can paste it is a step that exists only because of how the tables are
 * shaped. Batches are created as they are met.
 */
export type StudentRow = { fullName: string; email: string; phone: string } & Partial<
  Record<Exclude<StudentFieldKey, 'fullName' | 'email' | 'phone'>, string>
>;

export interface AddStudentsResult {
  created: {
    name: string;
    email: string;
    rollNo: string | null;
    batch: string;
    /** Empty on a dry run, which mints no invitations. */
    link: string;
    /**
     * Something worth knowing about a row that went in anyway - today only
     * a programme that could not be matched, when the caller asked for
     * those to be let through unmapped.
     */
    warning?: string;
  }[];
  skipped: { email: string; reason: string }[];
  /** Batches that did not exist and were created along the way. */
  batchesCreated: { id: string; name: string; graduationYear: number | null }[];
  /** True when nothing was written and this is only a report of what would be. */
  dryRun?: boolean;
}

/**
 * Every cell in one row, read and bounded by the registry.
 *
 * Out of range is refused rather than dropped. A CGPA of 12 used to become
 * null, which downstream reads as "no CGPA recorded" - so that student
 * silently failed every CGPA bar and nobody was told why. All the problems
 * in a row are collected, not just the first, because fixing a spreadsheet
 * one error per upload is how a placement cell comes to hate this screen.
 */
function readRow(
  row: StudentRow,
  policy: IntakePolicy,
): { ok: true; values: Record<string, unknown> } | { ok: false; reason: string } {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const field of STUDENT_FIELDS) {
    // A column the institution has switched off is ignored rather than
    // refused: an old sheet still carrying it should not fail, and the
    // value should not be stored either.
    if (!isOn(policy, field.key)) {
      values[field.key] = null;
      continue;
    }

    const raw = (row as Record<string, string | undefined>)[field.key];
    const read = readCell(field, raw);
    if (read.ok) values[field.key] = read.value;
    else problems.push(read.reason);
  }

  return problems.length > 0 ? { ok: false, reason: problems.join('; ') } : { ok: true, values };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const dp2 = (v: unknown): Prisma.Decimal | null =>
  typeof v === 'number' ? new Prisma.Decimal(v.toFixed(2)) : null;

export interface AddStudentsOptions {
  /** Set when adding from inside one batch, which then wins over the rows. */
  batch?: Batch;
  /**
   * Check everything and write nothing.
   *
   * A strict programme check without this is a trap: a placement cell finds
   * out that eight rows of three hundred are wrong only after the other two
   * hundred and ninety-two have been created and invited. The preview runs
   * every check the real thing runs - including the ones that need the
   * database, like an email already in use - and reports the same shape.
   */
  dryRun?: boolean;
  /**
   * Let a row whose programme could not be matched through anyway, unmapped.
   *
   * Off by default, because an unmapped student is invisible to every role
   * that filters on a course and nothing on their screen says so. It is
   * offered on the preview for a cell that knows, and would rather map
   * afterwards than stop now.
   */
  allowUnmapped?: boolean;
  /**
   * The institution, needed only when there is no college: a student the
   * university has not placed in a college yet still has to belong to it.
   */
  tenantId?: string;
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
  const result: AddStudentsResult = {
    created: [],
    skipped: [],
    batchesCreated: [],
    ...(options.dryRun ? { dryRun: true } : {}),
  };

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

  // What this college actually runs, read once. A row is matched against it
  // on the way in, so a clean upload needs no Map data step at all - and a
  // row that matches nothing is said out loud rather than filed as unmapped.
  const programmes: ProgrammeIndex = await programmeIndex(collegeId);
  // Read once for the whole file, not once per student.
  const genders = await activeGenders();
  // What this institution collects and insists on. An institution that has
  // never opened the policy screen gets the platform's old behaviour: name,
  // email and mobile required, everything else offered.
  const policy = await policyFor(tenantId);
  const seenEmails = new Set<string>();
  const seenRolls = new Set<string>();
  const seenPrns = new Set<string>();

  // Resolved once per distinct class in the paste, not once per student.
  const batchCache = new Map<string, Batch>();

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    const fullName = row.fullName.trim();

    /*
     * What this institution insists on, which is not what the platform
     * insists on. A university that requires a PRN says so once, on the
     * policy screen, and every row without one is refused here by name.
     */
    const said = (key: string) => Boolean((row as Record<string, string | undefined>)[key]?.trim());
    const missing = missingRequired(policy, (key) =>
      // A sheet may name the programme in the one column or in the older
      // Course and Branch pair. Either answers the question.
      key === 'programme' ? said('programme') || said('course') : said(key),
    );

    if (missing.length > 0) {
      result.skipped.push({
        email: email || fullName || '(blank row)',
        reason: `Needs ${missing.join(' and ')}`,
      });
      continue;
    }

    /*
     * Every remaining cell, bounded by the same rules the student's own form
     * uses. A value outside its range is a refusal with the range in it,
     * rather than a null that reads downstream as "never recorded".
     */
    const read = readRow(row, policy);
    if (!read.ok) {
      result.skipped.push({ email, reason: read.reason });
      continue;
    }
    const cell = read.values;

    const phone = str(cell.phone) ?? '';
    const rollNo = str(cell.rollNo);
    const prn = str(cell.prn);

    // Checked against the list operations keeps, and rewritten to its
    // spelling: a one-gender role groups on what was recorded, so "M" where
    // the list says "Male" makes that role invisible.
    const gender = matchGender(str(cell.gender), genders);
    if (!gender.ok) {
      result.skipped.push({ email, reason: gender.reason });
      continue;
    }
    if (seenEmails.has(email)) {
      result.skipped.push({ email, reason: 'Listed more than once' });
      continue;
    }
    seenEmails.add(email);

    let batch: Batch;
    try {
      batch = await resolveBatch(
        collegeId,
        tenantId,
        row,
        options.batch,
        batchCache,
        result,
        options.dryRun ?? false,
      );
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

      /*
       * Which of the college's programmes this is.
       *
       * The row first, the batch as a fallback: a batch called "Second year"
       * has no course to lend, and that must not leave a student without one
       * when their own row said B.Tech.
       *
       * A row that matches nothing is refused with the college's own list in
       * the message, rather than stored with the names as typed and the link
       * left null - which is what made a "B.Com" at a college running BCPM
       * invisible to every BCPM role, silently, for three years.
       */
      const resolved = resolveProgramme(programmes, {
        programme: str(cell.programme),
        course: str(cell.course) ?? batch.course,
        branch: str(cell.specialisation) ?? batch.specialisation,
      });

      if (resolved.problem && !options.allowUnmapped) {
        result.skipped.push({ email, reason: resolved.problem });
        continue;
      }

      const candidateData = {
        collegeId,
        course: resolved.course,
        specialisation: resolved.branch,
        collegeProgramId: resolved.programme?.id ?? null,
        graduationYear: num(cell.graduationYear) ?? batch.graduationYear,
        prn,
        phone,
        gender: gender.value,
        dateOfBirth: (cell.dateOfBirth as Date | null) ?? null,
        cgpa: dp2(cell.cgpa),
        degreePct: dp2(cell.degreePct),
        tenthPct: dp2(cell.tenthPct),
        twelfthPct: dp2(cell.twelfthPct),
        diplomaPct: dp2(cell.diplomaPct),
        // Joined in the second year through a diploma. The column that
        // exists solely for these students - Diploma % - was importable
        // long before the fact itself was, so a college could record the
        // consequence and not the cause.
        isLateralEntry: (cell.isLateralEntry as boolean | null) ?? false,
        // The bachelor's lives in cgpa/degreePct above; these are the
        // MCA or M.Tech on top of it, blank for most of a roster.
        pgCgpa: dp2(cell.pgCgpa),
        pgPct: dp2(cell.pgPct),
        backlogs: num(cell.backlogs),
        // Two different criteria on every campus criteria sheet: "no live
        // backlogs" and "no more than two ever". Recorded apart, because
        // a role may ask about either and a missing one fails its bar.
        activeBacklogs: num(cell.activeBacklogs),
        gapYears: num(cell.gapYears),
      };

      // Everything above has been checked. On a preview that is the whole
      // job - nothing is written, no invitation is minted, and the row is
      // reported exactly as the real run would report it.
      if (options.dryRun) {
        result.created.push({
          name: fullName,
          email,
          rollNo,
          batch: batch.name,
          link: '',
          ...(resolved.problem ? { warning: resolved.problem } : {}),
        });
        continue;
      }

      // Unguessable and never shared: the account is unusable until the student
      // sets their own password through the activation link.
      const placeholder = await hashPassword(randomBytes(32).toString('hex'));

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
          data: { userId: created.id, ...candidateData },
        });
        await tx.batchMembership.create({
          data: {
            batchId: batch.id,
            candidateId: candidate.id,
            rollNo,
            division: str(cell.division),
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
        ...(resolved.problem ? { warning: resolved.problem } : {}),
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
 * The graduating year a new batch takes from the first row that mentions
 * one. Bounded like the column it becomes; anything else leaves the batch
 * without a year, which is perfectly usable.
 */
function yearOf(raw: string | undefined): number | null {
  const read = readCell(fieldFor('graduationYear'), raw);
  return read.ok ? ((read.value as number | null) ?? null) : null;
}

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
  dryRun: boolean,
): Promise<Batch> {
  // Adding from inside a batch: that batch wins, whatever the row says.
  if (fixed) return fixed;

  // A paste with no batch column at all still has to land somewhere, so it
  // lands in one group per college rather than being refused. It can be
  // renamed, or its students moved, afterwards.
  const name = row.batch?.trim() || UNASSIGNED;

  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  // With no college this is a university-wide batch, which the tenant fences.
  const existing = await prisma.batch.findFirst({ where: { collegeId, tenantId, name } });
  if (existing) {
    cache.set(key, existing);
    return existing;
  }

  const data = {
    collegeId,
    tenantId,
    name,
    course: row.course?.trim() || null,
    specialisation: row.specialisation?.trim() || null,
    graduationYear: yearOf(row.graduationYear),
  };

  /*
   * A preview reports the batch it would create without creating it.
   *
   * This is the other half of why the preview matters. A batch is made from
   * whatever name a row happens to carry, so "CSE 2026" and "CSE-2026" in
   * one file quietly become two classes - and until now nothing asked
   * first. The stub carries no id, which is harmless: the only thing read
   * off it afterwards is a roll-number check against a batch that by
   * definition has no members yet.
   */
  const created = dryRun
    ? ({ ...data, id: '', studyYear: null, headOfDept: null } as unknown as Batch)
    : await prisma.batch.create({ data });

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
 * Header text to field, and the spellings each field answers to.
 *
 * Both now live in the field registry, with the column that prints them, so
 * the template and the paste box cannot disagree - which they did: the
 * template printed a "Graduating year" column the paste box silently
 * ignored. Re-exported here because callers already import them from this
 * module.
 */
export { normalise, FIELD_BY_HEADER } from '../students/fields.js';

/** The aliases, keyed by field, for anything that still wants them that way. */
export const HEADERS: Record<string, readonly string[]> = Object.fromEntries(
  STUDENT_FIELDS.map((f) => [f.key, [normalise(f.header), ...f.aliases]]),
);

function headerMap(cells: string[]): Partial<Record<number, StudentFieldKey>> | null {
  const map: Partial<Record<number, StudentFieldKey>> = {};
  let matched = 0;

  cells.forEach((cell, i) => {
    const field = FIELD_BY_HEADER.get(normalise(cell));
    if (field) {
      map[i] = field;
      matched++;
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
