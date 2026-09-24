import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import ExcelJS from 'exceljs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeCollege, makeTenant, systemRole } from './factories.js';
import { platformBulkRouter } from '../src/modules/tenants/bulk.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Bulk add in onboarding is from Excel only. What is worth pinning down: the
 * templates carry live dropdowns, a preview never writes, a commit does what
 * the preview showed, and a bad college row is skipped with its row number
 * rather than sinking the whole file.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/platform/bulk', platformBulkRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/platform/bulk`;
  return {
    template: async (kind: string) => {
      const res = await fetch(`${base}/${kind}/template`);
      return { status: res.status, type: res.headers.get('content-type'), buffer: Buffer.from(await res.arrayBuffer()) };
    },
    upload: async (path: string, file: Buffer, name = 'filled.xlsx') => {
      const form = new FormData();
      form.append('file', new Blob([file]), name);
      const res = await fetch(`${base}${path}`, { method: 'POST', body: form });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    },
  };
}

async function platformCaller() {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@test.local`, fullName: 'Platform Ops', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({ data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId: null } });
  return appFor({ userId: user.id, role: Role.ADMIN, isPlatform: true });
}

/** Fills the data sheet of a downloaded template, as a person would. */
async function fill(template: Buffer, rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  rows.forEach((values, r) => values.forEach((v, c) => (sheet.getCell(r + 2, c + 1).value = v)));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A workbook built from scratch: renamed tab, reordered and extra columns. */
async function adHoc(sheetName: string, header: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.addRow(header);
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('templates', () => {
  it('builds the courses template with a Branch dropdown pointing at a hidden list of every branch', async () => {
    // Enough branches that an inline list would pass Excel's 255-character cap.
    await db.branch.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ name: `Engineering Branch Number ${i + 1}` })),
    });
    const call = await platformCaller();
    const res = await call.template('courses');
    expect(res.status).toBe(200);
    expect(res.type).toContain('spreadsheetml');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Courses', 'Example', 'How to fill this in', 'Lists']);
    const lists = wb.getWorksheet('Lists')!;
    expect(lists.state).toBe('hidden');
    expect(lists.getCell('A31').value).toBeTruthy();

    const validation = wb.getWorksheet('Courses')!.getCell('B2').dataValidation;
    expect(validation.type).toBe('list');
    expect(validation.formulae?.[0]).toBe('Lists!$A$2:$A$31');
    expect(wb.getWorksheet('Courses')!.getCell('A1').note).toBeTruthy();
  });

  it('builds the colleges template with Type, State, NAAC and Affiliation dropdowns', async () => {
    await db.collegeType.create({ data: { name: 'Engineering' } });
    await db.refValue.createMany({
      data: [
        { kind: 'STATE', value: 'Maharashtra' },
        { kind: 'NAAC_GRADE', value: 'A+', position: 1 },
      ],
    });
    const call = await platformCaller();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await call.template('colleges')).buffer as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet('Colleges')!;
    const header = (sheet.getRow(1).values as string[]).filter(Boolean);
    const formulaFor = (h: string) => sheet.getCell(2, header.indexOf(h) + 1).dataValidation?.formulae?.[0];
    expect(formulaFor('State')).toMatch(/^Lists!/);
    expect(formulaFor('Type')).toMatch(/^Lists!/);
    expect(formulaFor('NAAC Grade')).toMatch(/^Lists!/);
    expect(formulaFor('Affiliation')).toMatch(/^Lists!/);
    expect(formulaFor('City')).toBeUndefined();
  });

  it('is closed to anyone who is not platform operations', async () => {
    const call = appFor({ userId: 'x', role: Role.ADMIN, isPlatform: false });
    expect((await call.template('branches')).status).toBe(403);
  });
});

describe('branches from Excel', () => {
  it('previews without writing, holds back look-alikes, and commits exactly the rows marked to add', async () => {
    await db.branch.create({ data: { name: 'Mechanical Engineering' } });
    const call = await platformCaller();
    const file = await fill((await call.template('branches')).buffer, [
      ['Computer Engineering'],
      ['mechanical engineering'],
      ['Mech Engineering'],
      ['Computer Engineering'],
      ['X'],
    ]);

    const preview = await call.upload('/branches/upload', file);
    expect(preview.status).toBe(200);
    expect(preview.body.rows.map((r: { row: number; status: string }) => [r.row, r.status])).toEqual([
      [2, 'add'],
      [3, 'exists'],
      [4, 'similar'],
      [5, 'duplicate'],
      [6, 'invalid'],
    ]);
    expect(preview.body.summary).toMatchObject({ add: 1, exists: 1, held: 1, skipped: 2 });
    expect(await db.branch.count()).toBe(1);

    const commit = await call.upload('/branches/upload?preview=false', file);
    expect(commit.status).toBe(200);
    expect((await db.branch.findMany({ orderBy: { name: 'asc' } })).map((b) => b.name)).toEqual([
      'Computer Engineering',
      'Mechanical Engineering',
    ]);
    expect(commit.body.branches).toHaveLength(2);
  });

  it('reads a renamed tab and extra columns by header name, and refuses a file that is not a workbook', async () => {
    const call = await platformCaller();
    const file = await adHoc('Sheet1', ['Notes', 'Branch Name'], [['ignore me', 'Civil Engineering']]);
    const res = await call.upload('/branches/upload', file);
    expect(res.body.rows).toEqual([{ row: 2, name: 'Civil Engineering', status: 'add' }]);

    const bad = await call.upload('/branches/upload', Buffer.from('not a workbook'), 'list.xlsx');
    expect(bad.status).toBe(400);
  });
});

describe('courses from Excel', () => {
  it('groups rows by course, reads near spellings as listed branches, and only adds unknown ones when asked', async () => {
    await db.branch.createMany({ data: [{ name: 'Computer Engineering' }, { name: 'Mechanical Engineering' }] });
    const call = await platformCaller();
    const file = await fill((await call.template('courses')).buffer, [
      ['B.Tech', 'Computer Engineering'],
      ['B.Tech', 'Mechanical Engg'],
      ['B.Tech', 'Aerospace Engineering'],
      ['B.Com', ''],
      ['', 'Computer Engineering'],
    ]);

    const preview = await call.upload('/courses/upload', file);
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toMatchObject({ courses: 2, newCourses: 2, mapped: 1, missing: 1, newBranches: 0 });
    expect(preview.body.rows.map((r: { row: number; status: string }) => [r.row, r.status])).toEqual([
      [2, 'matched'],
      [3, 'similar'],
      [4, 'missing'],
      [5, 'none'],
      [6, 'invalid'],
    ]);
    expect(preview.body.rows[1].readAs).toBe('Mechanical Engineering');
    expect(await db.course.count()).toBe(0);

    const commit = await call.upload('/courses/upload?preview=false&addMissing=true', file);
    expect(commit.status).toBe(200);
    const btech = await db.course.findFirstOrThrow({
      where: { name: 'B.Tech' },
      include: { specialisations: { include: { branch: true } } },
    });
    expect(btech.specialisations.map((b) => b.branch.name).sort()).toEqual([
      'Aerospace Engineering',
      'Computer Engineering',
      'Mechanical Engineering',
    ]);
    expect(await db.branch.count()).toBe(3);
  });
});

describe('colleges from Excel', () => {
  async function setup() {
    const tenant = await makeTenant('Deccan University');
    const type = await db.collegeType.create({ data: { name: 'Engineering' } });
    await makeCollege('Existing College', tenant.id).then((c) => db.college.update({ where: { id: c.id }, data: { code: 'TAKEN' } }));
    return { tenant, type };
  }

  const row = (over: Partial<Record<string, string>> = {}) => {
    const v = {
      name: 'Demo Institute of Technology',
      code: 'DIT',
      city: 'Demo City',
      state: 'Maharashtra',
      type: 'Engineering',
      affiliation: 'This university',
      affiliatedTo: '',
      address: '',
      pin: '',
      naac: '',
      officerName: '',
      officerEmail: '',
      ...over,
    };
    return Object.values(v);
  };

  it('previews each row on its own, then adds the valid ones and reports the rest by row number', async () => {
    const { tenant, type } = await setup();
    const call = await platformCaller();
    const file = await fill((await call.template('colleges')).buffer, [
      row(),
      row({ name: 'Demo College of Commerce', code: 'dcc', type: '', affiliation: 'Autonomous', pin: '411001' }),
      row({ name: 'Clash College', code: 'TAKEN' }),
      row({ name: 'Twin College', code: 'DIT' }),
      row({ name: 'Short Pin College', code: 'SPC', pin: '4110' }),
      row({ name: 'No City College', code: 'NCC', city: '' }),
      row({ name: 'Odd Type College', code: 'OTC', type: 'Circus' }),
    ]);

    const preview = await call.upload(`/tenants/${tenant.id}/colleges`, file);
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toMatchObject({ rows: 7, valid: 2, invalid: 5 });
    const byRow = Object.fromEntries(
      preview.body.rows.map((r: { row: number; status: string; problems?: string[] }) => [r.row, r]),
    );
    expect(byRow[2].status).toBe('valid');
    expect(byRow[3].code).toBe('DCC');
    expect(byRow[4].problems.join(' ')).toMatch(/already used by another college/);
    expect(byRow[5].problems.join(' ')).toMatch(/also on row 2/);
    expect(byRow[6].problems.join(' ')).toMatch(/six digits/);
    expect(byRow[7].status).toBe('invalid');
    expect(byRow[8].problems.join(' ')).toMatch(/not on the list/);
    expect(await db.college.count({ where: { tenantId: tenant.id } })).toBe(1);

    const commit = await call.upload(`/tenants/${tenant.id}/colleges?preview=false`, file);
    expect(commit.status).toBe(200);
    expect(commit.body.added.map((a: { row: number }) => a.row)).toEqual([2, 3]);
    expect(commit.body.skipped.map((s: { row: number }) => s.row)).toEqual([4, 5, 6, 7, 8]);
    expect(commit.body.state.colleges).toHaveLength(3);

    const dit = await db.college.findFirstOrThrow({ where: { code: 'DIT' } });
    expect(dit).toMatchObject({ tenantId: tenant.id, collegeTypeId: type.id, affiliation: 'Deccan University' });
    const dcc = await db.college.findFirstOrThrow({ where: { code: 'DCC' } });
    expect(dcc).toMatchObject({ affiliation: null, pincode: '411001', collegeTypeId: null });
  });

  it('gives a single-college institution room for one college only', async () => {
    const tenant = await db.tenant.create({
      data: { name: 'Solo College', slug: `solo-${Date.now()}`, kind: 'COLLEGE', completedSteps: [] },
    });
    const call = await platformCaller();
    const file = await adHoc('Colleges', ['College Name', 'Code', 'City', 'State'], [
      ['Solo College', 'SOLO', 'Demo City', 'Maharashtra'],
      ['Second College', 'SEC', 'Demo City', 'Maharashtra'],
    ]);
    const res = await call.upload(`/tenants/${tenant.id}/colleges`, file);
    expect(res.body.summary).toMatchObject({ valid: 1, invalid: 1 });
    expect(res.body.rows[1].problems[0]).toMatch(/exactly one college/);
  });
});
