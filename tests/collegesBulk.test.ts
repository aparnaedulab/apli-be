import { describe, expect, it } from 'vitest';
import { db } from './setup.js';
import ExcelJS from 'exceljs';
import {
  addColleges as addCollegesTo,
  parseCollegeRows,
  type AddCollegesOptions,
} from '../src/modules/admin/colleges.bulk.js';
import { defaultTenant } from './factories.js';

/** Every import here lands in the default test tenant unless it says otherwise. */
const addColleges = async (
  rows: Parameters<typeof addCollegesTo>[0],
  options: Partial<AddCollegesOptions> = {},
) => addCollegesTo(rows, { tenantId: (await defaultTenant()).id, ...options });
import {
  buildCollegeTemplate,
  parseCollegeWorkbook,
} from '../src/modules/admin/colleges.template.js';

/**
 * Onboarding an affiliation list. The rule these protect: one bad row costs
 * that row and nothing else, and every refusal says what to do about it.
 */
const row = (over: Record<string, string> = {}) => ({
  name: `College ${Math.random()}`,
  code: `C${Math.floor(Math.random() * 1e9)}`,
  city: 'Pune',
  state: 'Maharashtra',
  ...over,
});

describe('adding colleges in bulk', () => {
  it('adds a whole list at once', async () => {
    const result = await addColleges([row(), row(), row()]);

    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(3);
    expect(await db.college.count()).toBe(3);
  });

  it('uppercases codes, so case cannot create a second one', async () => {
    const first = await addColleges([row({ code: 'coep' })]);
    expect(first.created[0]!.code).toBe('COEP');

    const second = await addColleges([row({ code: 'CoEp' })]);
    expect(second.created).toEqual([]);
    expect(second.skipped[0]!.reason).toContain('already on the portal');
  });

  it('refuses a duplicate inside the same paste, not just against the database', async () => {
    const result = await addColleges([row({ code: 'PICT' }), row({ code: 'PICT' })]);

    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(await db.college.count()).toBe(1);
  });

  it('refuses a college whose name is already on the portal', async () => {
    await addColleges([row({ name: 'Fergusson College', code: 'FC1' })]);
    const again = await addColleges([row({ name: 'Fergusson College', code: 'FC2' })]);

    expect(again.skipped[0]!.reason).toContain('already on the portal');
  });

  it('keeps the good rows when one is bad', async () => {
    const result = await addColleges([
      row(),
      row({ name: '', code: 'NONAME' }),
      row({ code: 'has spaces' }),
      row({ pincode: '4110' }),
      row(),
    ]);

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(3);
  });

  it('needs a city and a state', async () => {
    const result = await addColleges([row({ city: '', state: '' })]);
    expect(result.skipped[0]!.reason).toBe('Needs a city and a state.');
  });

  it('falls back to the state set above the paste box', async () => {
    const result = await addColleges([row({ state: '' })], { defaultState: 'Maharashtra' });

    expect(result.created).toHaveLength(1);
    const saved = await db.college.findUniqueOrThrow({ where: { code: result.created[0]!.code } });
    expect(saved.state).toBe('Maharashtra');
  });

  it('lets a row override the default state', async () => {
    const result = await addColleges([row({ state: 'Karnataka' })], {
      defaultState: 'Maharashtra',
    });

    const saved = await db.college.findUniqueOrThrow({ where: { code: result.created[0]!.code } });
    expect(saved.state).toBe('Karnataka');
  });

  it('matches a college type by name, whatever the case', async () => {
    await db.collegeType.create({ data: { name: 'Engineering' } });

    const result = await addColleges([row({ type: 'engineering' })]);

    expect(result.created[0]!.type).toBe('Engineering');
  });

  it('refuses a type that is not on the list rather than dropping it silently', async () => {
    await db.collegeType.create({ data: { name: 'Engineering' } });

    const result = await addColleges([row({ type: 'Aeronautics' })]);

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('is not a college type');
    expect(await db.college.count()).toBe(0);
  });

  it('will not use a retired type', async () => {
    await db.collegeType.create({ data: { name: 'Engineering', isActive: false } });

    const result = await addColleges([row({ type: 'Engineering' })]);

    expect(result.skipped[0]!.reason).toContain('is not a college type');
  });
});

describe('reading a pasted affiliation list', () => {
  it('reads a header row, whatever the spreadsheet called the columns', () => {
    const rows = parseCollegeRows(
      [
        'Institute Name,DTE Code,District,Category,Affiliated To,PIN,Accreditation',
        'Government College of Engineering Pune,COEP,Pune,Engineering,SPPU,411005,A+',
      ].join('\n'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Government College of Engineering Pune',
      code: 'COEP',
      city: 'Pune',
      type: 'Engineering',
      affiliation: 'SPPU',
      pincode: '411005',
      naacGrade: 'A+',
    });
  });

  it('falls back to the order the single-college form asks for', () => {
    const rows = parseCollegeRows('Fergusson College,FC,Pune,Maharashtra,Science');

    expect(rows[0]).toMatchObject({
      name: 'Fergusson College',
      code: 'FC',
      city: 'Pune',
      state: 'Maharashtra',
      type: 'Science',
    });
  });

  it('takes tabs and semicolons too, so a copy out of Excel works', () => {
    const rows = parseCollegeRows('Fergusson College\tFC\tPune');
    expect(rows[0]).toMatchObject({ name: 'Fergusson College', code: 'FC', city: 'Pune' });
  });
});

describe('the Excel template', () => {
  it('round-trips: what it generates is what it can read back', async () => {
    await db.collegeType.create({ data: { name: 'Engineering' } });
    await db.collegeType.create({ data: { name: 'Management' } });

    const buffer = await buildCollegeTemplate();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as ArrayBuffer);

    const sheet = wb.getWorksheet('Colleges')!;
    expect(sheet).toBeDefined();
    expect(wb.getWorksheet('Valid values')).toBeDefined();
    expect(wb.getWorksheet('How to fill this in')).toBeDefined();

    // Somebody deletes the examples and types their own rows.
    sheet.spliceRows(2, 3);
    sheet.insertRow(2, ['Fergusson College', 'FC', 'Pune', '', 'Engineering', '', '', '411004', 'A+']);
    sheet.insertRow(3, ['Symbiosis Institute', 'SIBM', 'Pune', '', 'Management', '', '', '412115', 'A++']);

    const rows = await parseCollegeWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Fergusson College',
      code: 'FC',
      city: 'Pune',
      type: 'Engineering',
      pincode: '411004',
      naacGrade: 'A+',
    });

    const result = await addColleges(rows, { defaultState: 'Maharashtra' });
    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(2);
  });

  it('offers exactly the types that exist, so the dropdown cannot go stale', async () => {
    await db.collegeType.create({ data: { name: 'Engineering' } });
    await db.collegeType.create({ data: { name: 'Retired Thing', isActive: false } });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCollegeTemplate()) as ArrayBuffer);

    const validation = wb.getWorksheet('Colleges')!.getCell(2, 5).dataValidation;
    expect(validation?.formulae?.[0]).toContain('Engineering');
    expect(validation?.formulae?.[0]).not.toContain('Retired Thing');
  });

  it('reads a file whose columns were reordered or renamed', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Sheet1');
    sheet.addRow(['DTE Code', 'Institute Name', 'District', 'Category']);
    sheet.addRow(['COEP', 'Government College of Engineering', 'Pune', 'Engineering']);

    const rows = await parseCollegeWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(rows[0]).toMatchObject({
      code: 'COEP',
      name: 'Government College of Engineering',
      city: 'Pune',
      type: 'Engineering',
    });
  });

  it('ignores the blank rows a spreadsheet always carries', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Colleges');
    sheet.addRow(['College Name', 'Code', 'City']);
    sheet.addRow(['Fergusson College', 'FC', 'Pune']);
    sheet.addRow([]);
    sheet.addRow(['', '', '']);
    sheet.addRow(['ILS Law College', 'ILS', 'Pune']);

    const rows = await parseCollegeWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows).toHaveLength(2);
  });

  it('keeps a pincode as text, so leading zeros and .0 are not a problem', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Colleges');
    sheet.addRow(['College Name', 'Code', 'City', 'Pincode']);
    // Excel hands back a number when the cell was typed as one.
    sheet.addRow(['Fergusson College', 'FC', 'Pune', 411004]);

    const rows = await parseCollegeWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows[0]!.pincode).toBe('411004');
  });
});

describe('the Affiliated column', () => {
  // "Yes" means the institution doing the import; tests import into the default one.
  const university = 'Test University';

  it('reads Yes as the importing institution itself', async () => {
    for (const yes of ['Yes', 'yes', 'Y', 'TRUE', '1', 'Affiliated']) {
      const result = await addColleges([row({ affiliation: yes })]);
      expect(result.created[0]!.affiliation).toBe(university);
    }
  });

  it('reads No as autonomous', async () => {
    for (const no of ['No', 'no', 'N', 'false', '0', 'Autonomous', '-']) {
      const result = await addColleges([row({ affiliation: no })]);
      expect(result.created[0]!.affiliation).toBeNull();
    }
  });

  it('treats a blank as No rather than guessing', async () => {
    const result = await addColleges([row({ affiliation: '' })]);
    expect(result.created[0]!.affiliation).toBeNull();
  });

  it('takes anything else as the name of a different university', async () => {
    const result = await addColleges([row({ affiliation: 'Shivaji University' })]);
    expect(result.created[0]!.affiliation).toBe('Shivaji University');
  });

  it('is offered as a Yes/No list in the template', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCollegeTemplate()) as ArrayBuffer);

    const sheet = wb.getWorksheet('Colleges')!;
    const header = sheet.getRow(1).values as string[];
    const col = header.indexOf('Affiliated');
    expect(col).toBeGreaterThan(0);

    expect(sheet.getCell(2, col).dataValidation?.formulae?.[0]).toBe('"Yes,No"');
  });

  it('round-trips a Yes typed into the template', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCollegeTemplate()) as ArrayBuffer);
    const sheet = wb.getWorksheet('Colleges')!;
    sheet.spliceRows(2, 3);
    sheet.insertRow(2, ['Fergusson College', 'FC', 'Pune', '', '', 'Yes', '', '411004', 'A+']);
    sheet.insertRow(3, ['Autonomous Institute', 'AUT', 'Pune', '', '', 'No', '', '411005', 'A']);

    const rows = await parseCollegeWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    const result = await addColleges(rows, { defaultState: 'Maharashtra' });

    expect(result.created.map((c) => c.affiliation)).toEqual([university, null]);
  });
});

describe('template examples', () => {
  it('are on their own sheet, so an untouched template imports nobody', async () => {
    await db.collegeType.create({ data: { name: 'Engineering' } });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCollegeTemplate()) as ArrayBuffer);

    // The examples are visible, one tab across.
    expect(wb.getWorksheet('Example')).toBeDefined();

    // The sheet that gets read holds nothing but a header.
    const rows = await parseCollegeWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows).toEqual([]);

    const result = await addColleges(rows);
    expect(result.created).toEqual([]);
    expect(await db.college.count()).toBe(0);
  });
});
