import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { db } from './setup.js';
import { makeCollege } from './factories.js';
import {
  buildStudentTemplate,
  parseStudentWorkbook,
} from '../src/modules/campus/students.template.js';
import { addStudents, parseStudentRows } from '../src/modules/campus/students.service.js';
import { Role } from '@prisma/client';

async function officer() {
  return db.user.create({
    data: {
      email: `tpo-${Math.random()}@test.local`,
      fullName: 'Officer',
      passwordHash: 'x',
      role: Role.CAMPUS,
    },
  });
}

async function load(buffer: ExcelJS.Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  return wb;
}

describe('the class-list template', () => {
  it('ships an empty data sheet, so an untouched file imports nobody', async () => {
    const wb = await load(await buildStudentTemplate());

    // The shape is shown one tab across rather than in the rows that get read.
    expect(wb.getWorksheet('Example')).toBeDefined();

    const rows = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows).toEqual([]);
  });

  it('offers the existing batches as a dropdown', async () => {
    const wb = await load(await buildStudentTemplate({ batchNames: ['CSE 2026', 'Second year'] }));

    const sheet = wb.getWorksheet('Students')!;
    const col = (sheet.getRow(1).values as string[]).indexOf('Batch');
    expect(sheet.getCell(2, col).dataValidation?.formulae?.[0]).toBe('"CSE 2026,Second year"');

    // ...and lists them where a person can read them.
    expect(wb.getWorksheet('Batches')).toBeDefined();
  });

  it('drops the Batch column when the batch is already chosen', async () => {
    const wb = await load(await buildStudentTemplate({ fixedBatchName: 'CSE 2026' }));

    const headers = wb.getWorksheet('Students')!.getRow(1).values as string[];
    expect(headers).not.toContain('Batch');
    expect(headers).toContain('Name');
    expect(wb.getWorksheet('Batches')).toBeUndefined();
  });

  it('round-trips a filled-in file into real students', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const wb = await load(await buildStudentTemplate({ batchNames: ['CSE 2026'] }));
    const sheet = wb.getWorksheet('Students')!;
    sheet.addRow([
      'Aditi Rane',
      'aditi@test.local',
      '9000000023',
      'CSE 2026',
      'B.Tech',
      'Computer Science',
      '2026',
      'CS22-101',
      '',
      'A',
      '',
      '',
      '8.6',
      '',
      '91',
      '88',
      '0',
    ]);

    const rows = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows).toHaveLength(1);

    const result = await addStudents(college.id, rows, sender.id);
    expect(result.skipped).toEqual([]);

    const student = await db.candidate.findFirstOrThrow({ where: { collegeId: college.id } });
    expect(student).toMatchObject({ course: 'B.Tech', specialisation: 'Computer Science' });
    expect(Number(student.cgpa)).toBe(8.6);
  });

  it('keeps a mobile number and a roll number as text', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Students');
    sheet.addRow(['Name', 'Email', 'Mobile', 'Roll No']);
    // Excel hands these back as numbers when they were typed as numbers.
    sheet.addRow(['Aditi Rane', 'aditi@test.local', 9000000023, 22101]);

    const rows = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows[0]).toMatchObject({ phone: '9000000023', rollNo: '22101' });
  });

  it('reads a file whose columns were renamed or reordered', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Sheet1');
    sheet.addRow(['Contact No', 'Full Name', 'E-mail', 'Class', 'SSC %', 'ATKT']);
    sheet.addRow(['9000000023', 'Aditi Rane', 'aditi@test.local', 'CSE 2026', '91', '0']);

    const rows = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows[0]).toMatchObject({
      fullName: 'Aditi Rane',
      email: 'aditi@test.local',
      phone: '9000000023',
      batch: 'CSE 2026',
      tenthPct: '91',
      backlogs: '0',
    });
  });

  it('ignores the blank rows a spreadsheet always carries', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Students');
    sheet.addRow(['Name', 'Email', 'Mobile']);
    sheet.addRow(['Aditi Rane', 'aditi@test.local', '9000000023']);
    sheet.addRow([]);
    sheet.addRow(['', '', '']);
    sheet.addRow(['Kunal Deshmukh', 'kunal@test.local', '9000000024']);

    const rows = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows).toHaveLength(2);
  });
});

describe('the two doors accept the same headers', () => {
  it('reads "Graduating year" from both a paste and a workbook', async () => {
    const header = 'Name,Email,Mobile,Graduating year';
    const line = 'Aditi Rane,aditi@test.local,9000000023,2027';

    const pasted = parseStudentRows(`${header}\n${line}`);
    expect(pasted[0]!.graduationYear).toBe('2027');

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Students');
    sheet.addRow(header.split(','));
    sheet.addRow(line.split(','));
    const fromFile = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(fromFile[0]!.graduationYear).toBe('2027');
  });

  it('agrees on every header the template prints', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildStudentTemplate()) as ArrayBuffer);
    const headers = (wb.getWorksheet('Students')!.getRow(1).values as string[]).filter(Boolean);

    // A column the template prints but the parser drops is a column that
    // silently does nothing - which is exactly what happened to the year.
    const row = headers.map((h) => (h === 'Email' ? 'a@test.local' : 'x')).join(',');
    const parsed = parseStudentRows(`${headers.join(',')}\n${row}`);

    expect(parsed).toHaveLength(1);
    const filled = Object.values(parsed[0]!).filter(Boolean).length;
    expect(filled).toBe(headers.length);
  });
});
