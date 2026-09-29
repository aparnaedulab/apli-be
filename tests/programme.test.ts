import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeCollege } from './factories.js';
import { addStudents } from '../src/modules/campus/students.service.js';
import {
  programmeIndex,
  resolveProgramme,
  splitProgramme,
  teachAlias,
} from '../src/modules/students/programme.js';

/**
 * Which programme a student is on.
 *
 * The case this exists for: a college runs BCPM, a departmental sheet says
 * "B.Com", and the upload used to accept it - storing the typed name with no
 * mapping link and saying nothing. Every role's course criterion is matched
 * on that name by exact equality, so the student was invisible to every BCPM
 * role for the rest of their degree and no screen explained why.
 */

async function officer() {
  return db.user.create({
    data: {
      email: `tpo-${Date.now()}-${Math.random()}@test.local`,
      fullName: 'Test Officer',
      passwordHash: 'x',
      role: Role.CAMPUS,
    },
  });
}

/** A college that actually runs something, so there is a list to check. */
async function collegeRunning(pairs: [string, string | null][]) {
  const college = await makeCollege();

  for (const [courseName, branchName] of pairs) {
    const course = await db.course.upsert({
      where: { name: courseName },
      update: {},
      create: { name: courseName },
    });

    let specialisationId: string | null = null;
    if (branchName) {
      const branch = await db.branch.upsert({
        where: { name: branchName },
        update: {},
        create: { name: branchName },
      });
      const spec =
        (await db.specialisation.findFirst({
          where: { name: branchName, courseId: course.id },
        })) ??
        (await db.specialisation.create({
          data: { name: branchName, courseId: course.id, branchId: branch.id },
        }));
      specialisationId = spec.id;
    }

    await db.collegeProgram.create({
      data: { collegeId: college.id, courseId: course.id, specialisationId },
    });
  }

  return college;
}

const row = (over: Record<string, string> = {}) => ({
  fullName: 'Aditi Rane',
  email: `aditi-${Math.random()}@test.local`,
  phone: '9000000023',
  batch: 'CSE 2026',
  ...over,
});

describe('splitting a programme written as one string', () => {
  it('takes the spellings people actually use', () => {
    expect(splitProgramme('B.Tech — Computer Science')).toEqual({
      course: 'B.Tech',
      branch: 'Computer Science',
    });
    expect(splitProgramme('B.Tech - Computer Science')).toEqual({
      course: 'B.Tech',
      branch: 'Computer Science',
    });
    expect(splitProgramme('B.Tech (Computer Science)')).toEqual({
      course: 'B.Tech',
      branch: 'Computer Science',
    });
    expect(splitProgramme('MBA')).toEqual({ course: 'MBA', branch: null });
  });

  it('leaves a hyphenated course alone', () => {
    // An unspaced hyphen is part of the name, not a separator.
    expect(splitProgramme('Post-Graduate Diploma')).toEqual({
      course: 'Post-Graduate Diploma',
      branch: null,
    });
  });
});

describe('resolving against what a college runs', () => {
  it('matches however the spelling was punctuated', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const index = await programmeIndex(college.id);

    for (const typed of ['BCPM', 'bcpm', 'B.C.P.M.', ' B C P M ']) {
      const out = resolveProgramme(index, { programme: typed });
      expect(out.problem, typed).toBeUndefined();
      expect(out.course, typed).toBe('BCPM');
    }
  });

  it('refuses a course the college does not run, and says what it does', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const index = await programmeIndex(college.id);

    const out = resolveProgramme(index, { programme: 'B.Com' });
    expect(out.programme).toBeNull();
    expect(out.problem).toContain('BCPM');
  });

  it('offers the nearest programme rather than applying it', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const index = await programmeIndex(college.id);

    const out = resolveProgramme(index, { programme: 'BCPMM' });
    // Suggested, and still refused: filing somebody under the wrong degree
    // silently is worse than refusing the row.
    expect(out.problem).toContain('Did you mean BCPM');
    expect(out.programme).toBeNull();
  });

  it('takes a course on its own when there is only one branch of it', async () => {
    const college = await collegeRunning([['MBA', null]]);
    const index = await programmeIndex(college.id);

    const out = resolveProgramme(index, { course: 'MBA' });
    expect(out.problem).toBeUndefined();
    expect(out.branch).toBeNull();
  });

  it('asks which branch when the course has several', async () => {
    const college = await collegeRunning([
      ['B.Tech', 'Computer Science'],
      ['B.Tech', 'Mechanical'],
    ]);
    const index = await programmeIndex(college.id);

    // The commonest real failure: the right course, branch left blank.
    const out = resolveProgramme(index, { course: 'B.Tech' });
    expect(out.problem).toContain('needs a branch');
    expect(out.problem).toContain('Mechanical');
  });

  it('names the branches it does run when the branch is wrong', async () => {
    const college = await collegeRunning([['B.Tech', 'Computer Science']]);
    const index = await programmeIndex(college.id);

    const out = resolveProgramme(index, { course: 'B.Tech', branch: 'Aeronautical' });
    expect(out.problem).toContain('Computer Science');
  });

  it('writes the list’s own spelling, not the sheet’s', async () => {
    const college = await collegeRunning([['B.Tech', 'Computer Science']]);
    const index = await programmeIndex(college.id);

    const out = resolveProgramme(index, { course: 'b.tech', branch: 'COMPUTER SCIENCE' });
    expect(out).toMatchObject({ course: 'B.Tech', branch: 'Computer Science' });
  });

  it('checks nothing at a college that has recorded no programmes', async () => {
    const college = await makeCollege();
    const index = await programmeIndex(college.id);

    // Refusing every roster because nobody has done a setup step yet blocks
    // work that has nothing to do with that step.
    const out = resolveProgramme(index, { course: 'Anything At All' });
    expect(out.problem).toBeUndefined();
    expect(out.course).toBe('Anything At All');
  });
});

describe('a spelling the college has taught', () => {
  it('resolves on every later file', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const programme = await db.collegeProgram.findFirstOrThrow({
      where: { collegeId: college.id },
    });

    const before = resolveProgramme(await programmeIndex(college.id), { programme: 'BCom Prog' });
    expect(before.problem).toBeDefined();

    await teachAlias(college.id, programme.id, 'BCom Prog', null);

    const after = resolveProgramme(await programmeIndex(college.id), { programme: 'bcom prog' });
    expect(after.problem).toBeUndefined();
    expect(after.course).toBe('BCPM');
  });
});

describe('the upload', () => {
  it('refuses the B.Com row rather than filing it unmapped', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const sender = await officer();

    const result = await addStudents(college.id, [row({ programme: 'B.Com' })], sender.id);

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('BCPM');
  });

  it('links a matched row to the programme, so reports can count it', async () => {
    const college = await collegeRunning([['B.Tech', 'Computer Science']]);
    const sender = await officer();

    const result = await addStudents(
      college.id,
      [row({ programme: 'B.Tech — Computer Science' })],
      sender.id,
    );

    expect(result.created).toHaveLength(1);
    const student = await db.candidate.findFirstOrThrow({ where: { collegeId: college.id } });
    expect(student.collegeProgramId).not.toBeNull();
    expect(student.course).toBe('B.Tech');
  });

  it('lets a cell take the row in unmapped when it says so, with the reason kept', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const sender = await officer();

    const result = await addStudents(college.id, [row({ programme: 'B.Com' })], sender.id, {
      allowUnmapped: true,
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.warning).toContain('BCPM');

    const student = await db.candidate.findFirstOrThrow({ where: { collegeId: college.id } });
    expect(student.collegeProgramId).toBeNull();
    expect(student.course).toBe('B.Com');
  });
});

describe('checking a file without committing it', () => {
  it('reports what would happen and writes nothing at all', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const sender = await officer();

    const result = await addStudents(
      college.id,
      [row({ programme: 'BCPM' }), row({ fullName: 'Wrong', programme: 'B.Com' })],
      sender.id,
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);

    // Not one row of it reached the database.
    expect(await db.candidate.count({ where: { collegeId: college.id } })).toBe(0);
    expect(await db.batch.count({ where: { collegeId: college.id } })).toBe(0);
    expect(await db.invite.count()).toBe(0);
  });

  it('mints no activation link, because nothing was created', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const sender = await officer();

    const result = await addStudents(college.id, [row({ programme: 'BCPM' })], sender.id, {
      dryRun: true,
    });
    expect(result.created[0]!.link).toBe('');
  });

  it('names the batches it would create, so a typo can be caught first', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const sender = await officer();

    // "CSE 2026" and "CSE-2026" in one file are two batches, and until the
    // preview nothing asked whether that was meant.
    const result = await addStudents(
      college.id,
      [
        row({ programme: 'BCPM', batch: 'CSE 2026' }),
        row({ fullName: 'Second', programme: 'BCPM', batch: 'CSE-2026' }),
      ],
      sender.id,
      { dryRun: true },
    );

    expect(result.batchesCreated.map((b) => b.name).sort()).toEqual(['CSE 2026', 'CSE-2026']);
    expect(await db.batch.count({ where: { collegeId: college.id } })).toBe(0);
  });

  it('still catches an email that is already taken', async () => {
    const college = await collegeRunning([['BCPM', null]]);
    const sender = await officer();
    const taken = row({ programme: 'BCPM', email: `taken-${Math.random()}@test.local` });

    await addStudents(college.id, [taken], sender.id);
    const preview = await addStudents(college.id, [taken], sender.id, { dryRun: true });

    // The checks that need the database are the ones worth previewing.
    expect(preview.created).toEqual([]);
    expect(preview.skipped[0]!.reason).toContain('already has an account');
  });
});
