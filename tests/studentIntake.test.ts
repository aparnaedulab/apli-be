import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerRouter } from '../src/modules/students/register.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { Role, TenantStatus } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeTenant } from './factories.js';
import { addStudents } from '../src/modules/campus/students.service.js';
import { buildStudentTemplate } from '../src/modules/campus/students.template.js';
import ExcelJS from 'exceljs';
import {
  assertMayAdd,
  defaultPolicy,
  policyFor,
  savePolicy,
  selfFormFields,
  warningsFor,
} from '../src/modules/students/policy.js';

/**
 * What an institution collects, what it insists on, and who may add.
 *
 * All three were hard-coded for everybody before this: three required
 * fields, and both the university and every college free to add at any
 * time. The point of these tests is that an institution which never touches
 * the screen is unaffected, and one that does is obeyed everywhere.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** The public registration surface, with a session the route can write to. */
function publicApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {};
    next();
  });
  app.use('/public', registerRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

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
  ...over,
});

describe('an institution that has never set a policy', () => {
  it('gets exactly what the platform did before there was a choice', async () => {
    const policy = await policyFor(null);

    expect(policy.fields.fullName).toBe('required');
    expect(policy.fields.email).toBe('required');
    expect(policy.fields.phone).toBe('required');
    expect(policy.fields.cgpa).toBe('optional');
    expect(policy.universityMayAdd).toBe(true);
    expect(policy.collegeMayAdd).toBe(true);
    expect(policy.selfRegister).toBe(false);
  });

  it('adds students the same way it always did', async () => {
    const college = await makeCollege();
    const sender = await officer();

    const result = await addStudents(college.id, [row()], sender.id);
    expect(result.created).toHaveLength(1);
  });
});

describe('what an institution insists on', () => {
  it('refuses a row missing a field it made required', async () => {
    const tenant = await makeTenant();
    const college = await makeCollege('Policy College', tenant.id);
    const sender = await officer();

    await savePolicy(tenant.id, { fields: { prn: 'required' } });

    const result = await addStudents(college.id, [row()], sender.id);
    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('prn');
  });

  it('takes the row once that field is there', async () => {
    const tenant = await makeTenant();
    const college = await makeCollege('Policy College 2', tenant.id);
    const sender = await officer();
    await savePolicy(tenant.id, { fields: { prn: 'required' } });

    const result = await addStudents(
      college.id,
      [row({ prn: `PRN${Math.floor(Math.random() * 1e9)}` })],
      sender.id,
    );
    expect(result.created).toHaveLength(1);
  });

  it('ignores a column it has switched off rather than refusing the sheet', async () => {
    const tenant = await makeTenant();
    const college = await makeCollege('No DOB College', tenant.id);
    const sender = await officer();
    await savePolicy(tenant.id, { fields: { dateOfBirth: 'off' } });

    // An old sheet still carrying the column must not fail, and the value
    // must not be stored either.
    const result = await addStudents(
      college.id,
      [row({ dateOfBirth: '17/04/2005' })],
      sender.id,
    );

    expect(result.created).toHaveLength(1);
    const student = await db.candidate.findFirstOrThrow({ where: { collegeId: college.id } });
    expect(student.dateOfBirth).toBeNull();
  });

  it('never lets the account itself be switched off', async () => {
    const tenant = await makeTenant();
    const saved = await savePolicy(tenant.id, {
      fields: { fullName: 'off', email: 'optional' },
    });

    expect(saved.fields.fullName).toBe('required');
    expect(saved.fields.email).toBe('required');
  });

  it('says out loud what switching off an eligibility field costs', async () => {
    const policy = { ...defaultPolicy(), fields: { ...defaultPolicy().fields, cgpa: 'off' as const } };
    const warnings = warningsFor(policy);

    expect(warnings.join(' ')).toContain('CGPA');
    expect(warnings.join(' ')).toContain('invisible');
  });
});

describe('who may add', () => {
  it('stops a college when the university adds centrally', async () => {
    const policy = { ...defaultPolicy(), collegeMayAdd: false };
    expect(() => assertMayAdd(policy, 'college')).toThrow(/adds students centrally/i);
    expect(() => assertMayAdd(policy, 'university')).not.toThrow();
  });

  it('stops the university when its colleges own the roster', async () => {
    const policy = { ...defaultPolicy(), universityMayAdd: false };
    expect(() => assertMayAdd(policy, 'university')).toThrow(/by its colleges/i);
    expect(() => assertMayAdd(policy, 'college')).not.toThrow();
  });

  it('refuses a policy where nobody can add anybody', async () => {
    const tenant = await makeTenant();
    await expect(
      savePolicy(tenant.id, {
        universityMayAdd: false,
        collegeMayAdd: false,
        selfRegister: false,
      }),
    ).rejects.toThrow(/Somebody has to be able to add students/i);
  });
});

describe('the sheet follows the policy', () => {
  async function headersOf(buffer: ExcelJS.Buffer): Promise<string[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as ArrayBuffer);
    return (wb.getWorksheet('Students')!.getRow(1).values as string[]).filter(Boolean);
  }

  it('prints only the columns the institution collects', async () => {
    const tenant = await makeTenant();
    const policy = await savePolicy(tenant.id, {
      fields: { dateOfBirth: 'off', pgCgpa: 'off', pgPct: 'off' },
    });

    const headers = await headersOf(await buildStudentTemplate({ policy }));
    expect(headers).not.toContain('DOB');
    expect(headers).not.toContain('PG CGPA');
    expect(headers).toContain('CGPA');
  });

  it('keeps the Programme column while either half of it is collected', async () => {
    const tenant = await makeTenant();
    const policy = await savePolicy(tenant.id, { fields: { specialisation: 'off' } });

    const headers = await headersOf(await buildStudentTemplate({ policy }));
    expect(headers).toContain('Programme');
  });
});

describe('what the registration form asks', () => {
  it('asks only for fields the institution both collects and chose', async () => {
    const tenant = await makeTenant();
    const policy = await savePolicy(tenant.id, {
      selfRegister: true,
      selfFields: ['phone', 'programme', 'cgpa', 'dateOfBirth'],
      fields: { dateOfBirth: 'off' },
    });

    const asked = selfFormFields(policy).map((f) => f.key);
    expect(asked).toContain('phone');
    expect(asked).toContain('cgpa');
    // Switched off above, so it cannot be asked even though it was listed.
    expect(asked).not.toContain('dateOfBirth');
  });

  it('never asks for the college or the batch, which are not questions', async () => {
    const tenant = await makeTenant();
    const policy = await savePolicy(tenant.id, {
      selfRegister: true,
      selfFields: ['phone', 'college', 'batch'],
    });

    expect(policy.selfFields).not.toContain('college');
    expect(policy.selfFields).not.toContain('batch');
  });

  it('refuses registration that asks for nothing at all', async () => {
    const tenant = await makeTenant();
    await expect(
      savePolicy(tenant.id, { selfRegister: true, selfFields: [] }),
    ).rejects.toThrow(/at least one field/i);
  });
});

describe('a student registering themselves', () => {
  /** A live institution whose college takes registrations. */
  async function openFor(selfFields: string[]) {
    const tenant = await makeTenant();
    await db.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });
    const college = await makeCollege(`Open College ${Math.random()}`, tenant.id);
    await makeBatch(college.id);
    await savePolicy(tenant.id, { selfRegister: true, selfFields });
    return { tenant, college };
  }

  it('is invisible until the institution switches it on', async () => {
    const tenant = await makeTenant();
    await db.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });
    const college = await makeCollege(`Closed College ${Math.random()}`, tenant.id);

    const policy = await policyFor(college.tenantId);
    expect(policy.selfRegister).toBe(false);
  });

  it('collects the programme, which is what the old join code never did', async () => {
    const { college } = await openFor(['phone', 'programme']);
    const policy = await policyFor(college.tenantId);

    // The whole reason this exists: a student with no course matches only
    // roles that state no course criterion, so the old join code produced
    // students invisible to the entire drive.
    expect(selfFormFields(policy).map((f) => f.key)).toContain('programme');
  });

  it('says the same thing to a wrong code as to a college that is closed', async () => {
    const call = publicApp();

    const nonsense = await call('GET', '/public/register/NOSUCHCODE');
    const tenant = await makeTenant();
    await db.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });
    const shut = await makeCollege(`Shut ${Math.random()}`, tenant.id);
    const closed = await call('GET', `/public/register/${shut.code}`);

    // Telling a stranger which of the two it is tells them an institution
    // exists here, which the platform deliberately does not disclose.
    expect(nonsense.status).toBe(404);
    expect(closed.status).toBe(404);
    expect(closed.body.error.message).toBe(nonsense.body.error.message);
  });

  it('asks for exactly what the institution chose', async () => {
    const { college } = await openFor(['phone', 'cgpa']);
    const call = publicApp();

    const res = await call('GET', `/public/register/${college.code}`);
    expect(res.status).toBe(200);
    expect(res.body.fields.map((f: { key: string }) => f.key).sort()).toEqual(['cgpa', 'phone']);
    expect(res.body.college.name).toBe(college.name);
  });

  it('creates the same three rows a roster upload creates', async () => {
    const { college } = await openFor(['phone']);
    const call = publicApp();
    const email = `self-${Math.random()}@test.local`;

    const res = await call('POST', '/public/register', {
      code: college.code,
      fullName: 'Self Registered',
      email,
      password: 'a-long-enough-password',
      answers: { phone: '9000000099' },
    });

    expect(res.status).toBe(201);
    const candidate = await db.candidate.findFirstOrThrow({
      where: { user: { email } },
      include: { batchMemberships: true },
    });
    expect(candidate.collegeId).toBe(college.id);
    expect(candidate.phone).toBe('9000000099');
    // On a roster screen from the first minute, so somebody can check them.
    expect(candidate.batchMemberships).toHaveLength(1);
  });

  it('refuses a registration missing something the institution insists on', async () => {
    const tenant = await makeTenant();
    await db.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });
    const college = await makeCollege(`Strict ${Math.random()}`, tenant.id);
    await savePolicy(tenant.id, {
      selfRegister: true,
      selfFields: ['phone'],
      fields: { phone: 'required' },
    });

    const res = await publicApp()('POST', '/public/register', {
      code: college.code,
      fullName: 'No Phone',
      email: `nophone-${Math.random()}@test.local`,
      password: 'a-long-enough-password',
      answers: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('mobile');
  });

  it('will not let two people register the same address', async () => {
    const { college } = await openFor(['phone']);
    const call = publicApp();
    const email = `twice-${Math.random()}@test.local`;
    const body = {
      code: college.code,
      fullName: 'First',
      email,
      password: 'a-long-enough-password',
      answers: { phone: '9000000099' },
    };

    expect((await call('POST', '/public/register', body)).status).toBe(201);
    expect((await call('POST', '/public/register', body)).status).toBe(409);
  });
});
