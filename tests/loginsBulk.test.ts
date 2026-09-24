import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { Role, RoleScope } from '@prisma/client';
import { db } from './setup.js';
import { defaultTenant, makeCollege, makeCompany, systemRole } from './factories.js';
import { buildLoginTemplate, parseLoginWorkbook } from '../src/modules/roles/logins.template.js';
import { addLogins } from '../src/modules/roles/logins.bulk.js';

/**
 * Handing out logins from a spreadsheet.
 *
 * This is the one importer that creates the ability to sign in, so the tests
 * lean on what it must refuse rather than on what it accepts: a role from the
 * wrong world, a college role attached to no college, a university role that
 * would quietly reach across every college, and an uploader handing out more
 * than they hold themselves.
 */

async function admin() {
  return db.user.create({
    data: {
      email: `ops-${Math.random()}@test.local`,
      fullName: 'Operations',
      passwordHash: 'x',
      role: Role.ADMIN,
    },
  });
}

/**
 * Where these uploads happen: the default test tenant, by the platform team -
 * the one caller that may also hand out company logins.
 */
const inTenant = async () => ({ tenantId: (await defaultTenant()).id, companies: true });
const templateFor = async () => ({ tenantId: (await defaultTenant()).id, includeCompanies: true });

/** An uploader who may do everything, which is the uninteresting case. */
const anything = async () => true;

async function load(buffer: ExcelJS.Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  return wb;
}

describe('the logins template', () => {
  it('ships an empty data sheet, so an untouched file creates nobody', async () => {
    await systemRole('campus.coordinator');
    const wb = await load(await buildLoginTemplate(await templateFor()));

    // The examples sit one tab across, where the importer never looks. A
    // template that filled its own rows once created three real accounts.
    expect(wb.getWorksheet('Example')).toBeDefined();
    expect(wb.getWorksheet('Example')!.rowCount).toBeGreaterThan(1);

    const rows = await parseLoginWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows).toEqual([]);
  });

  it('lists the roles that exist, with the world each belongs to', async () => {
    const role = await systemRole('campus.coordinator');
    const wb = await load(await buildLoginTemplate(await templateFor()));

    const sheet = wb.getWorksheet('Valid values')!;
    const listed: string[][] = [];
    sheet.eachRow((row, i) => {
      if (i > 1) listed.push([String(row.getCell(1).value), String(row.getCell(2).value)]);
    });

    expect(listed).toContainEqual(['College', role.name]);
  });

  it('names every college code and company a row is allowed to use', async () => {
    const college = await makeCollege('Pune Institute');
    const company = await makeCompany('Zenith Labs');

    const wb = await load(await buildLoginTemplate(await templateFor()));
    const sheet = wb.getWorksheet('Colleges and companies')!;

    const written: string[] = [];
    sheet.eachRow((row, i) => {
      if (i > 1) written.push(String(row.getCell(2).value));
    });

    expect(written).toContain(college.code);
    expect(written).toContain(company.name);
  });

  it('offers Yes and No on the Send email column', async () => {
    await systemRole('campus.coordinator');
    const wb = await load(await buildLoginTemplate(await templateFor()));
    const sheet = wb.getWorksheet('Logins')!;

    const header: string[] = [];
    sheet.getRow(1).eachCell((cell) => header.push(String(cell.value)));
    expect(header).toContain('Send email');

    const col = header.indexOf('Send email') + 1;
    expect(sheet.getCell(2, col).dataValidation?.formulae).toEqual(['"Yes,No"']);
  });

  it('reads back a file that was filled in from it', async () => {
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const wb = await load(await buildLoginTemplate(await templateFor()));
    wb.getWorksheet('Logins')!.addRow([
      'Rakesh Pawar',
      'rakesh@pict.demo-college.example',
      '9000000024',
      'College',
      role.name,
      college.code,
      'Yes',
    ]);

    const rows = await parseLoginWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(rows).toEqual([
      {
        fullName: 'Rakesh Pawar',
        email: 'rakesh@pict.demo-college.example',
        phone: '9000000024',
        kind: 'College',
        role: role.name,
        organisation: college.code,
        sendEmail: 'Yes',
      },
    ]);
  });
});

describe('creating logins from rows', () => {
  it('creates an invitation per good row and says where each one lands', async () => {
    const sender = await admin();
    const college = await makeCollege('Pune Institute');
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        {
          fullName: 'Rakesh Pawar',
          email: 'Rakesh@PICT.Demo-College.example',
          phone: '+91 90000 00024',
          kind: 'College',
          role: role.name,
          organisation: college.code,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      row: 2,
      fullName: 'Rakesh Pawar',
      email: 'rakesh@pict.demo-college.example',
      role: role.name,
      where: `${college.name} (${college.code})`,
    });
    expect(result.created[0]!.link).toContain('http');

    const invite = await db.invite.findFirst({ where: { email: 'rakesh@pict.demo-college.example' } });
    expect(invite).toMatchObject({
      invitedName: 'Rakesh Pawar',
      invitedPhone: '+91 90000 00024',
      roleId: role.id,
      collegeId: college.id,
    });
  });

  it('keeps the good rows when one in the middle is wrong', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        { fullName: 'One', email: 'one@test.local', role: role.name, organisation: college.code },
        { fullName: 'Two', email: 'two@test.local', role: role.name, organisation: 'NOSUCH' },
        { fullName: 'Three', email: 'three@test.local', role: role.name, organisation: college.code },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    // The third row is the point: a bad row must not end the file.
    expect(result.created.map((c) => c.email)).toEqual(['one@test.local', 'three@test.local']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ row: 3, email: 'two@test.local' });
    expect(result.skipped[0]!.reason).toContain('NOSUCH');
  });

  it('refuses a role from the wrong world, and says which world it is', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const campusRole = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        {
          fullName: 'Wrong World',
          email: 'wrong@test.local',
          kind: 'Company',
          role: campusRole.name,
          organisation: 'Zenith Labs',
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toBe(
      `"${campusRole.name}" is a College role, not a Company one.`,
    );
    void college;
  });

  it('will not attach a university role to a single college', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const adminRole = await systemRole('admin.onboarding');

    const result = await addLogins(
      [
        {
          fullName: 'Too Wide',
          email: 'wide@test.local',
          kind: 'University',
          role: adminRole.name,
          organisation: college.code,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    // Dropping the column silently would hand out reach across every college
    // to somebody who thought they were granting one.
    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('cannot be tied to');
    expect(await db.invite.count({ where: { email: 'wide@test.local' } })).toBe(0);
  });

  it('will not create a college login with no college', async () => {
    const sender = await admin();
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [{ fullName: 'Nowhere', email: 'nowhere@test.local', kind: 'College', role: role.name }],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('inside one college');
  });

  it('refuses every row when the uploader may not hand out that kind at all', async () => {
    const sender = await admin();
    const adminRole = await systemRole('admin.onboarding');

    // A University admin holds `login:manage` but not `account:suspend`, so it
    // can staff colleges and companies and never make another operations login.
    const result = await addLogins(
      [{ fullName: 'Escalation', email: 'esc@test.local', kind: 'University', role: adminRole.name }],
      {
        ...(await inTenant()), sentById: sender.id,
        may: async (permission) => permission === 'login:manage',
      },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('deactivate accounts');
    expect(await db.invite.count({ where: { email: 'esc@test.local' } })).toBe(0);
  });

  it('will not give out a role that has been retired', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await db.platformRole.create({
      data: {
        name: `Retired ${Math.random()}`,
        scope: RoleScope.CAMPUS,
        permissions: ['student:read'],
        isActive: false,
      },
    });

    const result = await addLogins(
      [
        {
          fullName: 'Late Arrival',
          email: 'late@test.local',
          role: role.name,
          organisation: college.code,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('retired');
  });

  it('skips an address that already has an account, rather than duplicating it', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');
    const existing = await admin();

    const result = await addLogins(
      [
        {
          fullName: 'Already Here',
          email: existing.email,
          role: role.name,
          organisation: college.code,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('already has an account');
  });

  it('creates one invitation when the same address is uploaded twice', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const rows = [
      {
        fullName: 'Repeat Row',
        email: 'repeat@test.local',
        role: role.name,
        organisation: college.code,
      },
    ];

    const first = await addLogins(rows, { ...(await inTenant()), sentById: sender.id, may: anything });
    const second = await addLogins(rows, { ...(await inTenant()), sentById: sender.id, may: anything });

    // Re-uploading a file after fixing three rows is the normal way this gets
    // used, so it has to be safe.
    expect(first.created).toHaveLength(1);
    expect(second.created).toEqual([]);
    expect(second.skipped[0]!.reason).toContain('already waiting');
    expect(await db.invite.count({ where: { email: 'repeat@test.local' } })).toBe(1);
  });

  it('catches an address repeated inside one file', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        { fullName: 'First', email: 'twice@test.local', role: role.name, organisation: college.code },
        { fullName: 'Second', email: 'twice@test.local', role: role.name, organisation: college.code },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('appears earlier');
  });

  it('refuses a row with no name, and one with a number that is not a number', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        { fullName: '', email: 'noname@test.local', role: role.name, organisation: college.code },
        {
          fullName: 'Bad Number',
          email: 'badnum@test.local',
          phone: '12345',
          role: role.name,
          organisation: college.code,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('No name');
    expect(result.skipped[1]!.reason).toContain('does not look like a mobile number');
  });

  it('works out the world from the role when the Kind column is left blank', async () => {
    const sender = await admin();
    const company = await makeCompany('Zenith Labs');
    const role = await systemRole('company.interviewer');

    const result = await addLogins(
      [
        {
          fullName: 'No Kind',
          email: 'nokind@test.local',
          role: role.name,
          organisation: company.name,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.skipped).toEqual([]);
    expect(result.created[0]).toMatchObject({ where: company.name });
  });

  it('leaves the email alone when the Send email column is blank', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        {
          fullName: 'Quiet Row',
          email: 'quiet@test.local',
          role: role.name,
          organisation: college.code,
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    // Blank means nobody decided, and nobody deciding must not become mail.
    expect(result.created[0]!.emailed).toEqual({ state: 'not asked' });
  });

  it('still creates the account when an email was asked for and could not go', async () => {
    const sender = await admin();
    const college = await makeCollege();
    const role = await systemRole('campus.coordinator');

    const result = await addLogins(
      [
        {
          fullName: 'Wants Mail',
          email: 'wantsmail@test.local',
          role: role.name,
          organisation: college.code,
          sendEmail: 'Yes',
        },
      ],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    // The test environment has no mail server, exactly as a fresh deployment
    // does not. The account is real either way; the row says what happened.
    expect(result.mailConfigured).toBe(false);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.emailed.state).toBe('failed');

    const outcome = result.created[0]!.emailed;
    expect(outcome.state === 'failed' && outcome.reason).toContain('No mail server');

    // The thing that actually matters: the invitation exists and the link works.
    expect(await db.invite.count({ where: { email: 'wantsmail@test.local' } })).toBe(1);
    expect(result.created[0]!.link).toContain('/invite/');
  });

  it('asks for the Kind column when one name belongs to two worlds', async () => {
    const sender = await admin();
    const college = await makeCollege();

    const name = `Viewer ${Math.random()}`;
    await db.platformRole.create({
      data: { name, scope: RoleScope.CAMPUS, permissions: ['student:read'] },
    });
    await db.platformRole.create({
      data: { name, scope: RoleScope.COMPANY, permissions: ['application:read'] },
    });

    const result = await addLogins(
      [{ fullName: 'Ambiguous', email: 'amb@test.local', role: name, organisation: college.code }],
      { ...(await inTenant()), sentById: sender.id, may: anything },
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('Fill in the Kind column');
  });
});
