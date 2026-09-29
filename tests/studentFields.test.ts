import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  ELIGIBILITY_FIELDS,
  FIELD_BY_HEADER,
  LOCKED_NUMBER_KEYS,
  LOCKED_TEXT_KEYS,
  STUDENT_FIELDS,
  fieldFor,
  normalise,
  readCell,
} from '../src/modules/students/fields.js';

/**
 * The student record is declared once, and these are the rules that keep it
 * that way.
 *
 * The two that matter are about the lock. Six fields - the degree, diploma
 * and postgraduate marks, live backlogs and gap years - were added to a
 * role's eligibility over the life of the product, and not one of them was
 * added to the set a verified student may not change. Nothing failed, so
 * nobody noticed: a verified student could open their profile, set their live
 * backlogs to zero, and walk into every role that asked for none.
 *
 * A comment would not have caught that. These do.
 */

const visibilitySource = readFileSync(
  fileURLToPath(new URL('../src/modules/jobs/visibility.ts', import.meta.url)),
  'utf8',
);

/**
 * Names on the eligibility context that are not facts about the student.
 *
 * Where they are in the process, which drives they are in, what they have
 * already been offered. A new one of these is fine; a new *student fact* is
 * what the test below is looking for.
 */
const NOT_A_STUDENT_FACT = new Set([
  'isFrozen',
  'collegeId',
  'batchId',
  'batchIds',
  'placementIds',
  'closedPlacementIds',
  'candidateId',
  'skills',
  'tenantId',
]);

describe('what a college vouches for', () => {
  it('locks every fact a role filters on, or says in writing why not', () => {
    const unlocked = ELIGIBILITY_FIELDS.filter((f) => !f.lockOnVerify && !f.lockExemptBecause);

    expect(
      unlocked.map((f) => f.key),
      'A field eligibility reads must either lock when a college verifies the student, or carry lockExemptBecause saying why it does not.',
    ).toEqual([]);
  });

  it('is the set the eligibility query actually reads, with nothing missing', () => {
    // Every `ctx.something` the query or its explanation touches.
    const read = new Set(
      [...visibilitySource.matchAll(/\bctx\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!),
    );

    const unaccounted = [...read].filter(
      (name) => !NOT_A_STUDENT_FACT.has(name) && !STUDENT_FIELDS.some((f) => f.key === name),
    );
    expect(
      unaccounted,
      'These are read when deciding what a student is eligible for, but are not declared in the student field registry. Add them there, or to NOT_A_STUDENT_FACT if they are not a fact about the student.',
    ).toEqual([]);

    // And the other way: nothing claims to be read that is not.
    const claimedButUnread = ELIGIBILITY_FIELDS.filter(
      (f) => !f.virtual && !read.has(f.key),
    ).map((f) => f.key);
    expect(
      claimedButUnread,
      'These are marked readsEligibility but nothing in visibility.ts reads them.',
    ).toEqual([]);
  });

  it('sorts the locked fields by how they have to be compared', () => {
    // Numbers compare numerically; names compare case- and space-insensitively
    // and treat a blank as never having been verified. Putting one in the
    // other list silently breaks a save.
    expect(LOCKED_NUMBER_KEYS).toContain('activeBacklogs');
    expect(LOCKED_NUMBER_KEYS).toContain('gapYears');
    expect(LOCKED_TEXT_KEYS).toContain('course');
    expect(LOCKED_TEXT_KEYS).toContain('gender');
    expect(LOCKED_NUMBER_KEYS.filter((k) => LOCKED_TEXT_KEYS.includes(k))).toEqual([]);
  });
});

describe('the registry itself', () => {
  it('names real columns for everything both doors write', () => {
    const candidateColumns = new Set(Object.keys(Prisma.CandidateScalarFieldEnum));
    // A virtual column stands for others - Programme sets the course, the
    // branch and the mapping link - so it has no column of its own.
    const missing = STUDENT_FIELDS.filter(
      (f) => f.owner === 'shared' && !f.virtual && !candidateColumns.has(f.key),
    ).map((f) => f.key);

    expect(missing, 'A shared field is one both the import and the profile write, so it has to be a column on Candidate.').toEqual([]);
  });

  it('gives no two fields the same header', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];

    for (const field of STUDENT_FIELDS) {
      // A header that repeats one of its own aliases is fine and common -
      // "Gender" is both. What must not happen is two different fields
      // answering to the same word, because the parser takes the first.
      for (const alias of new Set([normalise(field.header), ...field.aliases])) {
        const already = seen.get(alias);
        if (already && already !== field.key) {
          clashes.push(`"${alias}" is claimed by both ${already} and ${field.key}`);
        }
        seen.set(alias, field.key);
      }
    }

    expect(clashes).toEqual([]);
  });

  it('matches a header however the spreadsheet spelled it', () => {
    expect(FIELD_BY_HEADER.get(normalise('Roll No.'))).toBe('rollNo');
    expect(FIELD_BY_HEADER.get(normalise('roll_no'))).toBe('rollNo');
    expect(FIELD_BY_HEADER.get(normalise('ROLLNO'))).toBe('rollNo');
    expect(FIELD_BY_HEADER.get(normalise('Graduating year'))).toBe('graduationYear');
    expect(FIELD_BY_HEADER.get(normalise('Live backlogs'))).toBe('activeBacklogs');
  });

  it('carries an example for every column, so the Example sheet cannot fall out of step', () => {
    const wrong = STUDENT_FIELDS.filter((f) => f.examples.length !== 2).map((f) => f.key);
    expect(wrong).toEqual([]);
  });

  it('bounds every number', () => {
    const unbounded = STUDENT_FIELDS.filter(
      (f) => (f.type === 'int' || f.type === 'decimal') && (f.min === undefined || f.max === undefined),
    ).map((f) => f.key);

    expect(unbounded, 'An unbounded number is how a CGPA of 12 got stored.').toEqual([]);
  });
});

describe('reading a cell', () => {
  it('refuses a number outside its range rather than dropping it', () => {
    // The old behaviour returned null here, which reads downstream as "no
    // CGPA recorded" - so the student quietly failed every CGPA bar.
    const out = readCell(fieldFor('cgpa'), '12');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('between 0 and 10');
  });

  it('takes a blank as nothing said, not as a zero', () => {
    expect(readCell(fieldFor('cgpa'), '')).toEqual({ ok: true, value: null });
    expect(readCell(fieldFor('cgpa'), undefined)).toEqual({ ok: true, value: null });
    expect(readCell(fieldFor('backlogs'), '0')).toEqual({ ok: true, value: 0 });
  });

  it('reads both date orders a spreadsheet here produces', () => {
    const iso = readCell(fieldFor('dateOfBirth'), '2005-04-17');
    const dmy = readCell(fieldFor('dateOfBirth'), '17/04/2005');
    expect(iso.ok && dmy.ok).toBe(true);
    if (iso.ok && dmy.ok) {
      expect((iso.value as Date).toISOString()).toBe((dmy.value as Date).toISOString());
    }
  });

  it('takes a mobile number in any of the shapes it arrives in', () => {
    for (const shape of ['9000000000', '+91 90000 00000', '090000-00000']) {
      expect(readCell(fieldFor('phone'), shape).ok, shape).toBe(true);
    }
    expect(readCell(fieldFor('phone'), '12345').ok).toBe(false);
  });

  it('reads lateral entry as the yes or no it is', () => {
    expect(readCell(fieldFor('isLateralEntry'), 'Yes')).toEqual({ ok: true, value: true });
    expect(readCell(fieldFor('isLateralEntry'), 'no')).toEqual({ ok: true, value: false });
    expect(readCell(fieldFor('isLateralEntry'), '1')).toEqual({ ok: true, value: true });
    expect(readCell(fieldFor('isLateralEntry'), 'maybe').ok).toBe(false);
  });

  it('refuses a whole number that is not one', () => {
    expect(readCell(fieldFor('backlogs'), '2.5').ok).toBe(false);
    expect(readCell(fieldFor('graduationYear'), '1980').ok).toBe(false);
    expect(readCell(fieldFor('graduationYear'), '2026')).toEqual({ ok: true, value: 2026 });
  });
});
