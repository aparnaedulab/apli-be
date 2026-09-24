import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege } from './factories.js';
import { addStudents, parseStudentRows } from '../src/modules/campus/students.service.js';

/**
 * Roster intake. The rule these tests exist to protect: nobody has to create a
 * batch before adding students. The class travels with the student, and a
 * batch nobody has made yet is made on the way in.
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

const row = (over: Record<string, string> = {}) => ({
  fullName: 'Aditi Rane',
  email: `aditi-${Math.random()}@test.local`,
  phone: '9000000023',
  batch: 'CSE 2026',
  graduationYear: '2026',
  course: 'B.Tech',
  ...over,
});

describe('adding students', () => {
  it('creates a batch that does not exist yet', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(college.id, [row()], sender.id);

    expect(result.skipped).toEqual([]);
    expect(result.created[0]!.batch).toBe('CSE 2026');
    expect(result.batchesCreated).toHaveLength(1);

    const batch = await db.batch.findFirst({ where: { collegeId: college.id } });
    expect(batch).toMatchObject({ name: 'CSE 2026', course: 'B.Tech', graduationYear: 2026 });
  });

  it('creates one batch for a whole class, not one per student', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(
      college.id,
      [row(), row({ fullName: 'Pooja Kale' }), row({ fullName: 'Rohit Shelke' })],
      sender.id,
    );

    expect(result.created).toHaveLength(3);
    expect(result.batchesCreated).toHaveLength(1);
    expect(await db.batch.count({ where: { collegeId: college.id } })).toBe(1);
  });

  it('reuses a batch the college already has', async () => {
    const college = await makeCollege();
    const sender = await officer();
    const existing = await db.batch.create({
      data: {
        collegeId: college.id,
        tenantId: college.tenantId,
        name: 'CSE 2026',
        course: 'B.Tech',
        graduationYear: 2026,
      },
    });

    const result = await addStudents(college.id, [row()], sender.id);

    expect(result.batchesCreated).toEqual([]);
    const membership = await db.batchMembership.findFirst({ where: { batchId: existing.id } });
    expect(membership).not.toBeNull();
  });

  it('treats one name as one batch, whatever else the rows say', async () => {
    const college = await makeCollege();
    const sender = await officer();

    // The college names its own batches, so a name means one group there.
    await addStudents(
      college.id,
      [row(), row({ fullName: 'Different Year', graduationYear: '2027' })],
      sender.id,
    );

    expect(await db.batch.count({ where: { collegeId: college.id, name: 'CSE 2026' } })).toBe(1);
  });

  it('needs nothing at all to make a batch', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(
      college.id,
      [
        row({ batch: '', graduationYear: '', course: '' }),
        row({ fullName: 'Year Group', batch: 'Second year', course: '', graduationYear: '' }),
      ],
      sender.id,
    );

    // A row with no batch column is not refused; it lands somewhere.
    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(2);
    expect(result.created.map((c) => c.batch).sort()).toEqual(['Second year', 'Unassigned']);

    // A batch with no course and no year is a perfectly usable batch.
    const batch = await db.batch.findFirstOrThrow({ where: { name: 'Second year' } });
    expect(batch.course).toBeNull();
    expect(batch.graduationYear).toBeNull();
  });

  it('lets the batch you are standing in win over the row', async () => {
    const college = await makeCollege();
    const sender = await officer();
    const batch = await makeBatch(college.id);

    const result = await addStudents(college.id, [row()], sender.id, { batch });

    expect(result.created[0]!.batch).toBe(batch.name);
    expect(result.batchesCreated).toEqual([]);
    expect(await db.batch.count({ where: { collegeId: college.id } })).toBe(1);
  });

  it('takes the three required fields and nothing else', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(
      college.id,
      [
        row({ fullName: '' }),
        row({ fullName: 'No Email', email: '' }),
        row({ fullName: 'No Phone', phone: '' }),
        row({ fullName: 'Short Phone', phone: '90000' }),
      ],
      sender.id,
    );

    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(result.skipped[3]!.reason).toContain('does not look like a mobile number');
  });

  it('keeps the good rows when one row is bad', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(
      college.id,
      [row(), row({ fullName: 'Broken', email: '' }), row({ fullName: 'Fine' })],
      sender.id,
    );

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
  });

  it('records the course on the student, not only on the batch', async () => {
    const college = await makeCollege();
    const sender = await officer();

    // One year group, three courses - which is exactly what a batch called
    // "Second year" is, and what the old shape could not express.
    await addStudents(
      college.id,
      [
        row({ fullName: 'A', batch: 'Second year', course: 'B.Tech', specialisation: 'Mechanical', graduationYear: '2028' }),
        row({ fullName: 'B', batch: 'Second year', course: 'B.Tech', specialisation: 'Civil', graduationYear: '2028' }),
        row({ fullName: 'C', batch: 'Second year', course: 'MCA', specialisation: 'Computer Applications', graduationYear: '2027' }),
      ],
      sender.id,
    );

    expect(await db.batch.count({ where: { collegeId: college.id } })).toBe(1);

    const students = await db.candidate.findMany({
      where: { collegeId: college.id },
      select: { course: true, specialisation: true, graduationYear: true },
      // Two students share a course, so the branch has to break the tie or
      // the assertion depends on insertion order.
      orderBy: [{ course: 'asc' }, { specialisation: 'asc' }],
    });

    expect(students).toEqual([
      { course: 'B.Tech', specialisation: 'Civil', graduationYear: 2028 },
      { course: 'B.Tech', specialisation: 'Mechanical', graduationYear: 2028 },
      { course: 'MCA', specialisation: 'Computer Applications', graduationYear: 2027 },
    ]);
  });

  it('falls back to the batch when the row says nothing', async () => {
    const college = await makeCollege();
    const sender = await officer();
    const batch = await db.batch.create({
      data: {
        collegeId: college.id,
        tenantId: college.tenantId,
        name: 'CSE 2026',
        course: 'B.Tech',
        specialisation: 'Computer Science',
        graduationYear: 2026,
      },
    });

    const result = await addStudents(
      college.id,
      [{ fullName: 'Inherits', email: 'inherits@test.local', phone: '9000000023' }],
      sender.id,
      { batch },
    );

    expect(result.created).toHaveLength(1);
    const student = await db.candidate.findFirstOrThrow({ where: { collegeId: college.id } });
    expect(student).toMatchObject({
      course: 'B.Tech',
      specialisation: 'Computer Science',
      graduationYear: 2026,
    });
  });

  it('leaves every student without a usable password until they claim it', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(college.id, [row()], sender.id);

    const user = await db.user.findUnique({ where: { email: result.created[0]!.email } });
    expect(user!.isActive).toBe(false);

    // The link is the only way in, and only its hash is stored.
    const invite = await db.invite.findFirst({ where: { userId: user!.id } });
    expect(invite).not.toBeNull();
    expect(result.created[0]!.link).toContain('/invite/');
    expect(invite!.tokenHash).not.toContain(result.created[0]!.link.split('/invite/')[1]);
  });
});

describe('reading a pasted list', () => {
  it('reads a header row, whatever the spreadsheet called the columns', () => {
    const rows = parseStudentRows(
      [
        'Full Name,E-mail,Contact No,Class,Passing Year,Branch,SSC %,HSC %,ATKT',
        'Aditi Rane,aditi@pict.demo-college.example,9000000023,CSE 2026,2026,Computer Science,91,88,0',
      ].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fullName: 'Aditi Rane',
      email: 'aditi@pict.demo-college.example',
      phone: '9000000023',
      batch: 'CSE 2026',
      graduationYear: '2026',
      specialisation: 'Computer Science',
      tenthPct: '91',
      twelfthPct: '88',
      backlogs: '0',
    });
  });

  it('falls back to name, email, mobile when there is no header', () => {
    const rows = parseStudentRows('Aditi Rane,aditi@pict.demo-college.example,9000000023');
    expect(rows[0]).toMatchObject({
      fullName: 'Aditi Rane',
      email: 'aditi@pict.demo-college.example',
      phone: '9000000023',
    });
  });

  it('puts students from different colleges into one university-wide batch', async () => {
    const a = await makeCollege('College A');
    const b = await makeCollege('College B');
    const sender = await officer();

    // No collegeId: this batch belongs to the university.
    const shared = await db.batch.create({
      data: { name: 'First year', studyYear: 1, tenantId: a.tenantId },
    });

    await addStudents(
      a.id,
      [{ fullName: 'From A', email: 'a@test.local', phone: '9000000023' }],
      sender.id,
      { batch: shared },
    );
    await addStudents(
      b.id,
      [{ fullName: 'From B', email: 'b@test.local', phone: '9000000024' }],
      sender.id,
      { batch: shared },
    );

    const members = await db.batchMembership.findMany({
      where: { batchId: shared.id },
      include: { candidate: { include: { college: { select: { name: true } } } } },
      orderBy: { joinedAt: 'asc' },
    });

    expect(members).toHaveLength(2);
    // Each student keeps their own college; only the grouping is shared.
    expect(members.map((m) => m.candidate.college?.name)).toEqual(['College A', 'College B']);
  });

  it('keeps a university-wide batch out of a college drive', async () => {
    const college = await makeCollege();
    const own = await makeBatch(college.id);
    await db.batch.create({
      data: { name: 'First year', studyYear: 1, tenantId: college.tenantId },
    });

    // This is the query a drive uses to choose its batches.
    const selectable = await db.batch.findMany({ where: { collegeId: college.id } });

    expect(selectable.map((b) => b.id)).toEqual([own.id]);
  });
});
