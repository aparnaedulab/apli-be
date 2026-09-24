import ExcelJS from 'exceljs';
import { RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The workbook for handing out logins in bulk.
 *
 * Generated per request, never stored, so the Role column is a dropdown of the
 * roles that exist right now and the Organisation sheet lists the colleges and
 * companies actually on the portal. A static template would go stale the first
 * time somebody invents a role, and the result is a file full of names the
 * importer refuses.
 */

export interface LoginRow {
  fullName: string;
  email: string;
  phone?: string;
  kind?: string;
  role?: string;
  organisation?: string;
  /** Yes or No. Blank counts as No - see `wantsEmail`. */
  sendEmail?: string;
}

/**
 * Whether a row asked for the invitation to be emailed.
 *
 * Blank is No, and deliberately so: a blank column means nobody decided, and
 * a file of three hundred rows where nobody decided must not turn into three
 * hundred emails. The template says this in the column note and on the help
 * sheet, and the result says it again for every row it applied to, so the
 * default is discovered on the first upload rather than the third.
 */
export function wantsEmail(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === 'yes' || v === 'y' || v === 'true' || v === '1' || v === 'send';
}

interface Column {
  header: string;
  key: keyof LoginRow;
  width: number;
  required?: boolean;
  note: string;
}

const COLUMNS: Column[] = [
  {
    header: 'Full name',
    key: 'fullName',
    width: 26,
    required: true,
    note: 'Who this login belongs to. An account with no name is one nobody can pick out of a list.',
  },
  {
    header: 'Email',
    key: 'email',
    width: 32,
    required: true,
    note: 'The activation link goes here, and it is how they sign in. One account per address.',
  },
  {
    header: 'Mobile',
    key: 'phone',
    width: 18,
    note: 'Optional. How you chase somebody when the link never arrives. +91, spaces and dashes are all fine.',
  },
  {
    header: 'Kind',
    key: 'kind',
    width: 14,
    required: true,
    note: 'University, College or Company. It decides which roles are allowed and whether an organisation is needed.',
  },
  {
    header: 'Role',
    key: 'role',
    width: 26,
    required: true,
    note: 'One of the roles on the "Valid values" sheet, and it has to belong to the Kind on this row.',
  },
  {
    header: 'College or company',
    key: 'organisation',
    width: 40,
    note: 'The college code (PICT) or the company name. Required for a College or Company login; leave blank for a University one.',
  },
  {
    header: 'Send email',
    key: 'sendEmail',
    width: 14,
    note: 'Yes to email them their link as soon as the file is uploaded. Blank counts as No, and you copy the link out yourself.',
  },
];

const EXAMPLES: string[][] = [
  ['Sujata Bhide', 'sujata@demo-university.example', '9000000023', 'University', 'Onboarding officer', '', 'Yes'],
  ['Rakesh Pawar', 'rakesh@pict.demo-college.example', '9000000024', 'College', 'Coordinator', 'PICT', 'Yes'],
  ['Nisha Rao', 'nisha@zenithlabs.example', '', 'Company', 'Interviewer', 'Zenith Labs', 'No'],
];

const TEMPLATE_ROWS = 400;

const INK = 'FF14161C';
const RULE = 'FFE3E6EC';
const BRAND = 'FF1D3B8B';
const SAND = 'FFF6F4F0';

const KIND_LABEL: Record<RoleScope, string> = {
  ADMIN: 'University',
  CAMPUS: 'College',
  COMPANY: 'Company',
};

export function scopeFromKind(value: string | undefined): RoleScope | null {
  switch (value?.trim().toLowerCase()) {
    case 'university':
    case 'admin':
    case 'operations':
      return RoleScope.ADMIN;
    case 'college':
    case 'campus':
      return RoleScope.CAMPUS;
    case 'company':
    case 'recruiter':
      return RoleScope.COMPANY;
    default:
      return null;
  }
}

/**
 * The template, as one institution sees it: its own colleges on the last
 * sheet, and companies only for the platform team, who alone may hand out
 * their logins.
 */
export async function buildLoginTemplate(scope: {
  tenantId: string;
  includeCompanies: boolean;
}): Promise<ExcelJS.Buffer> {
  const [roles, colleges, companies] = await Promise.all([
    prisma.platformRole.findMany({
      where: { isActive: true },
      orderBy: [{ scope: 'asc' }, { name: 'asc' }],
      select: { name: true, scope: true, description: true },
    }),
    prisma.college.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { name: 'asc' },
      select: { name: true, code: true },
    }),
    scope.includeCompanies
      ? prisma.company.findMany({ orderBy: { name: 'asc' }, select: { name: true } })
      : Promise.resolve([] as { name: string }[]),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Apli.ai';
  wb.created = new Date();

  /* --- the sheet people fill in ------------------------------------------ */
  const sheet = wb.addWorksheet('Logins', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell, i) => {
    const col = COLUMNS[i - 1];
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: col?.required ? BRAND : 'FF52596A' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
    if (col) {
      cell.note = {
        texts: [{ text: `${col.required ? 'Required. ' : 'Optional. '}${col.note}` }],
      };
    }
  });

  sheet.getColumn('phone').numFmt = '@';

  const kindCol = COLUMNS.findIndex((c) => c.key === 'kind') + 1;
  const roleCol = COLUMNS.findIndex((c) => c.key === 'role') + 1;
  const mailCol = COLUMNS.findIndex((c) => c.key === 'sendEmail') + 1;

  // Excel list validation is a comma-separated literal, so a name containing a
  // comma would split into two options. Those are offered on the sheet only.
  const roleNames = [...new Set(roles.map((r) => r.name))].filter((n) => !n.includes(','));

  for (let r = 2; r <= TEMPLATE_ROWS; r++) {
    sheet.getCell(r, kindCol).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"University,College,Company"'],
      showErrorMessage: true,
      errorTitle: 'Not a kind of login',
      error: 'University, College or Company.',
    };

    sheet.getCell(r, mailCol).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"Yes,No"'],
      showErrorMessage: true,
      errorTitle: 'Yes or No',
      error: 'Yes emails them the link straight away. No, or blank, leaves it to you.',
    };

    if (roleNames.length > 0) {
      sheet.getCell(r, roleCol).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${roleNames.join(',')}"`],
        // Not an error: the list spans all three kinds, and only the importer
        // can tell whether a role belongs to the kind on this particular row.
        showErrorMessage: false,
      };
    }
  }

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  /* --- the examples, where they cannot be imported ------------------------ */
  const example = wb.addWorksheet('Example');
  example.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const eh = example.getRow(1);
  eh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  eh.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF52596A' } };
  });
  EXAMPLES.forEach((values, r) => {
    const row = example.addRow(values);
    row.eachCell((cell) => {
      cell.font = { color: { argb: 'FF52596A' } };
      if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    });
  });
  example.addRow([]);
  example.addRow(['This sheet is ignored on upload. Only "Logins" is read.']).font = {
    color: { argb: 'FF858DA0' },
    italic: true,
  };

  /* --- what the Role and Kind columns accept ------------------------------ */
  const values = wb.addWorksheet('Valid values');
  values.columns = [
    { header: 'Kind', key: 'kind', width: 14 },
    { header: 'Role', key: 'role', width: 28 },
    { header: 'What it can do', key: 'what', width: 84 },
  ];
  const vh = values.getRow(1);
  vh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  vh.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  });

  for (const role of roles) {
    values.addRow([KIND_LABEL[role.scope], role.name, role.description ?? '']);
  }

  /* --- the colleges and companies a row can name -------------------------- */
  const orgs = wb.addWorksheet('Colleges and companies');
  orgs.columns = [
    { header: 'Kind', key: 'kind', width: 14 },
    { header: 'Write this', key: 'key', width: 22 },
    { header: 'Which one', key: 'name', width: 56 },
  ];
  const oh = orgs.getRow(1);
  oh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  oh.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  });
  colleges.forEach((c) => orgs.addRow(['College', c.code, c.name]));
  companies.forEach((c) => orgs.addRow(['Company', c.name, c.name]));

  /* --- the rules ---------------------------------------------------------- */
  const help = wb.addWorksheet('How to fill this in');
  help.columns = [{ width: 4 }, { width: 96 }];

  const lines: [string, string][] = [
    ['h', 'Creating logins in bulk'],
    ['p', 'Fill in the "Logins" sheet, one person per row, then upload the file. Everybody gets a one-time link and sets their own password — nobody, including you, ever sees it.'],
    ['p', 'The "Example" sheet shows three filled-in rows and is ignored on upload, so there is nothing to delete before you send the file.'],
    ['h', 'Kind and Role'],
    ['p', 'Kind says which world the login belongs to: University works across every college and company, College works inside one college, Company inside one company.'],
    ['p', 'The Role has to belong to that Kind. "Valid values" lists every role with the Kind it belongs to and what it can do — a College row cannot be given a Company role.'],
    ['h', 'College or company'],
    ['p', 'A College row needs a college code; a Company row needs a company name. Both are on the "Colleges and companies" sheet. A University row leaves the column blank — it belongs to no single organisation.'],
    ['h', 'Send email'],
    ['p', 'Yes emails that person their link the moment the file is uploaded. No, or blank, creates the invitation and leaves the link for you to send yourself - so a file where nobody filled this column in sends nothing.'],
    ['p', 'If this portal has no mail server set up yet, every row is still created and the result says so against each one. Nothing is quietly dropped.'],
    ['h', 'What happens on upload'],
    ['p', 'Every row is checked on its own. Good rows produce an invitation; bad rows come back with the reason, and you fix and re-upload just those.'],
    ['p', 'An email that already has an account is skipped rather than duplicated, so re-uploading the whole file is safe.'],
    ['h', 'The links'],
    ['p', 'Each invitation is a one-time link and anyone holding it becomes that person. Send each one to its own address and to nobody else.'],
  ];

  lines.forEach(([kind, text]) => {
    const row = help.addRow(['', text]);
    const cell = row.getCell(2);
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (kind === 'h') {
      cell.font = { bold: true, size: 12, color: { argb: INK } };
      row.height = 26;
    } else {
      cell.font = { size: 11, color: { argb: 'FF52596A' } };
      row.height = Math.max(18, Math.ceil(text.length / 90) * 16 + 6);
    }
  });

  return wb.xlsx.writeBuffer();
}

/* -------------------------------------------------------------------------- */
/* Reading one back                                                            */
/* -------------------------------------------------------------------------- */

const ALIASES: Record<string, keyof LoginRow> = {
  fullname: 'fullName',
  name: 'fullName',
  person: 'fullName',
  email: 'email',
  emailid: 'email',
  emailaddress: 'email',
  mail: 'email',
  mobile: 'phone',
  phone: 'phone',
  mobileno: 'phone',
  contact: 'phone',
  contactno: 'phone',
  kind: 'kind',
  type: 'kind',
  logintype: 'kind',
  scope: 'kind',
  role: 'role',
  rolename: 'role',
  collegeorcompany: 'organisation',
  organisation: 'organisation',
  organization: 'organisation',
  college: 'organisation',
  company: 'organisation',
  collegecode: 'organisation',
  sendemail: 'sendEmail',
  send: 'sendEmail',
  sendinvite: 'sendEmail',
  sendlink: 'sendEmail',
  emailthem: 'sendEmail',
  notify: 'sendEmail',
};

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text).join('').trim();
    }
    if ('hyperlink' in value && 'text' in value) return String(value.text).trim();
  }
  return String(value).trim();
}

export async function parseLoginWorkbook(buffer: Buffer): Promise<LoginRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheet = wb.getWorksheet('Logins') ?? wb.worksheets[0];
  if (!sheet) return [];

  const map = new Map<number, keyof LoginRow>();
  sheet.getRow(1).eachCell((cell, col) => {
    const field = ALIASES[normalise(cellText(cell.value))];
    if (field) map.set(col, field);
  });
  if (!map.size) return [];

  const rows: LoginRow[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;

    const parsed: LoginRow = { fullName: '', email: '' };
    let hasAnything = false;

    for (const [col, field] of map) {
      const text = cellText(row.getCell(col).value);
      if (text) {
        parsed[field] = text;
        hasAnything = true;
      }
    }

    if (hasAnything) rows.push(parsed);
  });

  return rows;
}

/** The same columns, read out of a pasted block rather than a file. */
export function parseLoginRows(input: string): LoginRow[] {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const split = (line: string) => line.split(/[\t,;]/).map((c) => c.trim());

  const header = split(lines[0]!);
  const map = new Map<number, keyof LoginRow>();
  header.forEach((cell, i) => {
    const field = ALIASES[normalise(cell)];
    if (field) map.set(i, field);
  });

  // Without a header there is no way to tell a role from an organisation, so
  // the columns are taken in the order the template prints them.
  if (map.size < 2) {
    return lines.map((line) => {
      const [fullName = '', email = '', phone, kind, role, organisation, sendEmail] = split(line);
      return { fullName, email, phone, kind, role, organisation, sendEmail };
    });
  }

  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: LoginRow = { fullName: '', email: '' };
    for (const [i, field] of map) {
      const value = cells[i];
      if (value) row[field] = value;
    }
    return row;
  });
}
