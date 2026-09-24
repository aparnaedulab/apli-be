import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { looksLikeSameBranch } from './branches.js';
import { collegeInputSchema, type CollegeInput } from './onboarding.schemas.js';

/**
 * Bulk add in onboarding, from Excel and only from Excel.
 *
 * Every template is generated per request so its dropdowns carry what exists
 * right now - the master branch list, the college types, states and NAAC
 * grades. The dropdowns are what stop a spelling mistake before it is typed:
 * a branch cannot be "Mechancal" if the cell only offers "Mechanical".
 *
 * Reading a file back is always a preview first. The preview applies the same
 * rules the rest of onboarding applies, row by row, and writes nothing; the
 * commit then does exactly what the preview showed.
 */

export type BulkKind = 'branches' | 'courses' | 'colleges';

/** Rows a dropdown is copied down to. More than one upload of this is unusual. */
const TEMPLATE_ROWS = 500;

const INK = 'FF14161C';
const MUTED = 'FF52596A';
const RULE = 'FFE3E6EC';
const BRAND = 'FF1D3B8B';
const SAND = 'FFF6F4F0';

/** The sheet each template's rows live on; a renamed tab falls back to the first. */
export const DATA_SHEET: Record<BulkKind, string> = {
  branches: 'Branches',
  courses: 'Courses',
  colleges: 'Colleges',
};

interface Column {
  header: string;
  key: string;
  width: number;
  required?: boolean;
  note: string;
  /** Name of a column on the hidden Lists sheet that feeds this column's dropdown. */
  list?: string;
}

const AFFILIATION_LABELS = {
  THIS_UNIVERSITY: 'This university',
  AUTONOMOUS: 'Autonomous',
  OTHER: 'Another university',
} as const;

const COLUMNS: Record<BulkKind, Column[]> = {
  branches: [
    {
      header: 'Branch',
      key: 'name',
      width: 44,
      required: true,
      note: 'One branch per row, spelt in full - "Computer Engineering", not "Comp Engg". Names that look like an existing branch are held back for you to decide.',
    },
  ],
  courses: [
    {
      header: 'Course',
      key: 'course',
      width: 28,
      required: true,
      note: 'The course, e.g. B.Tech. Repeat it on one row per branch it offers.',
    },
    {
      header: 'Branch',
      key: 'branch',
      width: 40,
      note: 'Pick from the dropdown - it lists every branch on the platform, so the spelling is always the same. Leave blank for a course with no branches.',
      list: 'Branches',
    },
  ],
  colleges: [
    { header: 'College Name', key: 'name', width: 42, required: true, note: 'The full name students and recruiters will see.' },
    { header: 'Code', key: 'code', width: 12, required: true, note: 'Short code, unique across the platform. Letters, numbers, dots and hyphens, up to 16.' },
    { header: 'City', key: 'city', width: 18, required: true, note: 'The city the campus is in.' },
    { header: 'State', key: 'state', width: 20, required: true, note: 'Pick from the dropdown.', list: 'States' },
    { header: 'Type', key: 'type', width: 20, note: 'Pick from the dropdown, or leave blank.', list: 'Types' },
    {
      header: 'Affiliation',
      key: 'affiliation',
      width: 20,
      note: 'This university, Autonomous, or Another university (then fill in the next column). Blank means this university.',
      list: 'Affiliation',
    },
    { header: 'Affiliated To', key: 'affiliationName', width: 30, note: 'Only when Affiliation is "Another university": that university’s name.' },
    { header: 'Address', key: 'address', width: 34, note: 'Optional.' },
    { header: 'PIN Code', key: 'pincode', width: 11, note: 'Six digits. Optional.' },
    { header: 'NAAC Grade', key: 'naacGrade', width: 12, note: 'Pick from the dropdown, or leave blank.', list: 'NAAC' },
    { header: 'Officer Name', key: 'officerName', width: 22, note: 'The placement officer to invite. Optional.' },
    { header: 'Officer Email', key: 'officerEmail', width: 30, note: 'They get an invitation to set their own password. Optional.' },
  ],
};

const EXAMPLES: Record<BulkKind, string[][]> = {
  branches: [['Computer Engineering'], ['Information Technology'], ['Mechanical Engineering']],
  courses: [
    ['B.Tech', 'Computer Engineering'],
    ['B.Tech', 'Mechanical Engineering'],
    ['M.Tech', 'Computer Engineering'],
    ['B.Com', ''],
  ],
  colleges: [
    [
      'Demo Institute of Technology',
      'DIT',
      'Demo City',
      'Maharashtra',
      'Engineering',
      'This university',
      '',
      'Demo Road, Demo Area',
      '000000',
      'A',
      'Demo Officer',
      'officer@demo-college.example',
    ],
    ['Demo College of Commerce', 'DCC', 'Demo City', 'Maharashtra', '', 'Autonomous', '', '', '', '', '', ''],
  ],
};

const HELP: Record<BulkKind, [string, string][]> = {
  branches: [
    ['h', 'Adding branches in bulk'],
    ['p', 'Fill in the "Branches" sheet, one branch per row, then upload the file.'],
    ['p', 'Branches are one list shared by every course and every institution. Each branch should exist exactly once, spelt in full.'],
    ['h', 'What happens on upload'],
    ['p', 'You see a preview first, and nothing is saved until you confirm. A name that already exists (in any letter case) is used as it is. A name that looks like an existing branch - "Mech Engg" beside "Mechanical Engineering" - is held back so a person decides; it is never added silently.'],
  ],
  courses: [
    ['h', 'Adding courses in bulk'],
    ['p', 'Fill in the "Courses" sheet with one row per course and branch: B.Tech on three rows gives B.Tech three branches.'],
    ['p', 'The Branch column is a dropdown of every branch on the platform. Add any missing branch to the branch list first, then refresh the template - that is what keeps every branch spelt one way.'],
    ['h', 'What happens on upload'],
    ['p', 'You see a preview first. A course that already exists gets the new branches rather than a duplicate. A branch typed over the dropdown is matched to the branch list: a near spelling is read as the real branch and shown to you; an unknown one is skipped unless you choose to add it.'],
  ],
  colleges: [
    ['h', 'Adding colleges in bulk'],
    ['p', 'Fill in the "Colleges" sheet, one college per row, then upload the file.'],
    ['p', 'Required: College Name, Code, City and State. Everything else can be filled in later.'],
    ['h', 'Codes'],
    ['p', 'The Code is how the platform identifies a college, so it must be unique across the whole platform. Letters, numbers, dots and hyphens, up to 16 characters. "dit" and "DIT" are the same code.'],
    ['h', 'Placement officers'],
    ['p', 'Give an officer email and they are invited when the college is added. Use real work addresses only when you are ready to send the invitations.'],
    ['h', 'What happens on upload'],
    ['p', 'You see a preview first, and nothing is saved until you confirm. Each row is checked on its own; rows with a problem are listed with the row number and the reason, and are skipped. Fix them and upload just those rows again.'],
  ],
};

function styleHeader(row: ExcelJS.Row, columns: Column[]): void {
  row.height = 22;
  row.eachCell((cell, i) => {
    const col = columns[i - 1];
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col?.required ? BRAND : MUTED } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
  });
}

/** The values each dropdown offers, read fresh. */
async function listValues(): Promise<Record<string, string[]>> {
  const [branches, types, states, naac] = await Promise.all([
    prisma.branch.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.collegeType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.refValue.findMany({
      where: { kind: 'STATE', isActive: true },
      orderBy: [{ position: 'asc' }, { value: 'asc' }],
      select: { value: true },
    }),
    prisma.refValue.findMany({
      where: { kind: 'NAAC_GRADE', isActive: true },
      orderBy: [{ position: 'asc' }, { value: 'asc' }],
      select: { value: true },
    }),
  ]);
  return {
    Branches: branches.map((b) => b.name),
    Types: types.map((t) => t.name),
    States: states.map((s) => s.value),
    NAAC: naac.map((n) => n.value),
    Affiliation: Object.values(AFFILIATION_LABELS),
  };
}

const colLetter = (n: number): string => {
  let s = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

/**
 * Builds a template: the sheet to fill, an Example sheet that is never read,
 * a How-to sheet, and a hidden Lists sheet the dropdowns point into. A range
 * rather than an inline list, because Excel caps inline lists at 255
 * characters and the branch list is longer than that.
 */
export async function buildTemplate(kind: BulkKind): Promise<ExcelJS.Buffer> {
  const columns = COLUMNS[kind];
  const lists = await listValues();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Apli.ai';
  wb.created = new Date();

  const sheet = wb.addWorksheet(DATA_SHEET[kind], { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(sheet.getRow(1), columns);
  columns.forEach((col, i) => {
    sheet.getRow(1).getCell(i + 1).note = {
      texts: [{ text: `${col.required ? 'Required. ' : 'Optional. '}${col.note}` }],
    };
    // Text, so a code like 0012 or a PIN keeps its leading zeros.
    sheet.getColumn(i + 1).numFmt = '@';
  });

  const example = wb.addWorksheet('Example');
  example.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(example.getRow(1), columns.map((c) => ({ ...c, required: false })));
  EXAMPLES[kind].forEach((values, r) => {
    const row = example.addRow(values);
    row.eachCell((cell) => {
      cell.font = { color: { argb: MUTED } };
      if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    });
  });
  example.addRow([]);
  example.addRow([`This sheet is ignored on upload. Only "${DATA_SHEET[kind]}" is read.`]).font = {
    color: { argb: 'FF858DA0' },
    italic: true,
  };

  const help = wb.addWorksheet('How to fill this in');
  help.columns = [{ width: 4 }, { width: 96 }];
  for (const [k, text] of HELP[kind]) {
    const row = help.addRow(['', text]);
    const cell = row.getCell(2);
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (k === 'h') {
      cell.font = { bold: true, size: 12, color: { argb: INK } };
      row.height = 26;
    } else {
      cell.font = { size: 11, color: { argb: MUTED } };
      row.height = Math.max(18, Math.ceil(text.length / 90) * 16 + 6);
    }
  }

  // The hidden sheet the dropdowns read from, one list per column.
  const needed = columns.filter((c) => c.list).map((c) => c.list!);
  if (needed.length > 0) {
    const listSheet = wb.addWorksheet('Lists', { state: 'hidden' });
    needed.forEach((name, i) => {
      const letter = colLetter(i + 1);
      listSheet.getCell(`${letter}1`).value = name;
      (lists[name] ?? []).forEach((v, r) => {
        listSheet.getCell(`${letter}${r + 2}`).value = v;
      });
    });

    columns.forEach((col, i) => {
      if (!col.list) return;
      const values = lists[col.list] ?? [];
      if (values.length === 0) return;
      const letter = colLetter(needed.indexOf(col.list) + 1);
      const formula = `Lists!$${letter}$2:$${letter}$${values.length + 1}`;
      // Branches are strict: the whole point is one spelling. The others
      // warn rather than refuse, and the preview has the final word.
      const strict = col.list === 'Branches' || col.list === 'Affiliation';
      for (let r = 2; r <= TEMPLATE_ROWS; r++) {
        sheet.getCell(r, i + 1).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [formula],
          showErrorMessage: true,
          errorStyle: strict ? 'stop' : 'warning',
          errorTitle: `Not on the ${col.list.toLowerCase()} list`,
          error: strict
            ? 'Pick one from the dropdown. To add a new branch, add it to the branch list first and download the template again.'
            : 'Pick one from the dropdown, or leave it blank.',
        };
      }
    });
  }

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return wb.xlsx.writeBuffer();
}

/* -------------------------------------------------------------------------- */
/* Reading a filled template back                                              */
/* -------------------------------------------------------------------------- */

/** A cell can be a string, number, formula result, rich text or hyperlink. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('').trim();
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text).trim();
  }
  return String(value).trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header spellings people actually use, beyond the template's own. */
const ALIASES: Record<BulkKind, Record<string, string>> = {
  branches: { branch: 'name', branchname: 'name', name: 'name', specialisation: 'name', specialization: 'name' },
  courses: {
    course: 'course',
    coursename: 'course',
    programme: 'course',
    program: 'course',
    branch: 'branch',
    specialisation: 'branch',
    specialization: 'branch',
  },
  colleges: {
    college: 'name',
    collegename: 'name',
    name: 'name',
    institute: 'name',
    code: 'code',
    collegecode: 'code',
    city: 'city',
    town: 'city',
    state: 'state',
    type: 'type',
    collegetype: 'type',
    affiliation: 'affiliation',
    affiliatedto: 'affiliationName',
    university: 'affiliationName',
    address: 'address',
    pincode: 'pincode',
    pin: 'pincode',
    naacgrade: 'naacGrade',
    naac: 'naacGrade',
    officername: 'officerName',
    officeremail: 'officerEmail',
    tpoemail: 'officerEmail',
  },
};

export interface SheetRow {
  /** The spreadsheet row number, so an error can point at it. */
  row: number;
  values: Record<string, string>;
}

/**
 * Reads the data sheet by header name, so reordered, renamed-tab or extra
 * columns still work. Blank rows below the data are skipped.
 */
export async function readSheet(kind: BulkKind, buffer: Buffer): Promise<SheetRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest('That file could not be read as an Excel workbook. Upload the .xlsx template, filled in.');
  }

  const sheet =
    wb.getWorksheet(DATA_SHEET[kind]) ??
    wb.worksheets.find((w) => w.name !== 'Example' && w.name !== 'How to fill this in' && w.name !== 'Lists');
  if (!sheet) throw badRequest('That workbook has no sheet to read.');

  const map = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, col) => {
    const field = ALIASES[kind][norm(cellText(cell.value))];
    if (field) map.set(col, field);
  });
  if (map.size === 0) {
    throw badRequest(`No recognisable columns on the "${sheet.name}" sheet. Download the template and fill that in.`);
  }

  const rows: SheetRow[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const values: Record<string, string> = {};
    let any = false;
    for (const [col, field] of map) {
      const text = cellText(row.getCell(col).value).replace(/\s+/g, ' ');
      if (text) {
        values[field] = text;
        any = true;
      }
    }
    if (any) rows.push({ row: index, values });
  });
  if (rows.length === 0) throw badRequest('The sheet is empty. Fill in at least one row below the headings.');
  if (rows.length > 1000) throw badRequest('Keep one upload to 1,000 rows or fewer.');
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Previews - the same rules as the rest of onboarding, nothing written        */
/* -------------------------------------------------------------------------- */

type BranchRef = { id: string; name: string };

export type BranchPreviewRow =
  | { row: number; name: string; status: 'add' }
  | { row: number; name: string; status: 'exists'; branch: BranchRef }
  | { row: number; name: string; status: 'similar'; similar: BranchRef[] }
  | { row: number; name: string; status: 'duplicate' | 'invalid'; reason: string };

/**
 * What adding these branches would do - the same checks addBranchesInBulk
 * makes, against the list as it would grow, so "Mechanical" and "Mech" in
 * one file do not both get in.
 */
export async function previewBranches(rows: SheetRow[]) {
  const list: BranchRef[] = await prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true } });
  const pending: BranchRef[] = [];
  const out: BranchPreviewRow[] = [];

  for (const r of rows) {
    const name = (r.values.name ?? '').trim();
    if (name.length < 2) {
      out.push({ row: r.row, name, status: 'invalid', reason: 'Too short to be a branch name.' });
      continue;
    }
    if (name.length > 80) {
      out.push({ row: r.row, name, status: 'invalid', reason: 'Keep branch names under 80 characters.' });
      continue;
    }
    if (pending.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      out.push({ row: r.row, name, status: 'duplicate', reason: 'Already earlier in this file.' });
      continue;
    }
    const exact = list.find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (exact) {
      out.push({ row: r.row, name, status: 'exists', branch: exact });
      continue;
    }
    const similar = [...list, ...pending].filter((b) => looksLikeSameBranch(b.name, name));
    if (similar.length > 0) {
      out.push({ row: r.row, name, status: 'similar', similar });
      continue;
    }
    pending.push({ id: `new:${name.toLowerCase()}`, name });
    out.push({ row: r.row, name, status: 'add' });
  }

  return {
    rows: out,
    summary: {
      rows: out.length,
      add: out.filter((r) => r.status === 'add').length,
      exists: out.filter((r) => r.status === 'exists').length,
      held: out.filter((r) => r.status === 'similar').length,
      skipped: out.filter((r) => r.status === 'invalid' || r.status === 'duplicate').length,
    },
  };
}

/** The names a commit adds: exactly the rows the preview marked "add". */
export function branchNamesToAdd(preview: Awaited<ReturnType<typeof previewBranches>>): string[] {
  return preview.rows.filter((r) => r.status === 'add').map((r) => r.name);
}

/** Course rows grouped for addCoursesInBulk, keeping each row's number for the preview. */
export function courseRowsFrom(rows: SheetRow[]) {
  const invalid: { row: number; reason: string }[] = [];
  const lines: { row: number; course: string; branch: string }[] = [];
  for (const r of rows) {
    const course = (r.values.course ?? '').trim();
    const branch = (r.values.branch ?? '').trim();
    if (course.length < 2) {
      invalid.push({ row: r.row, reason: branch ? `No course given for ${branch}.` : 'No course given.' });
      continue;
    }
    if (course.length > 80) {
      invalid.push({ row: r.row, reason: 'Keep course names under 80 characters.' });
      continue;
    }
    lines.push({ row: r.row, course, branch });
  }
  const grouped = new Map<string, { course: string; branches: string[] }>();
  for (const l of lines) {
    const key = l.course.toLowerCase();
    const g = grouped.get(key) ?? { course: l.course, branches: [] };
    if (l.branch) g.branches.push(l.branch);
    grouped.set(key, g);
  }
  return { lines, invalid, grouped: [...grouped.values()] };
}

/* --- colleges ------------------------------------------------------------ */

export type CollegePreviewRow =
  | { row: number; name: string; code: string; status: 'valid'; input: CollegeInput }
  | { row: number; name: string; code: string; status: 'invalid'; problems: string[] };

const AFFILIATION_BY_LABEL: Record<string, CollegeInput['affiliation']> = {
  [norm(AFFILIATION_LABELS.THIS_UNIVERSITY)]: 'THIS_UNIVERSITY',
  thisuniversity: 'THIS_UNIVERSITY',
  affiliated: 'THIS_UNIVERSITY',
  yes: 'THIS_UNIVERSITY',
  [norm(AFFILIATION_LABELS.AUTONOMOUS)]: 'AUTONOMOUS',
  no: 'AUTONOMOUS',
  [norm(AFFILIATION_LABELS.OTHER)]: 'OTHER',
  other: 'OTHER',
};

/**
 * Checks each college row on its own against the rules the "Add a college"
 * form applies, plus the two a single form cannot see: a code used twice in
 * the same file, and a code already taken anywhere on the platform.
 */
export async function previewColleges(rows: SheetRow[]) {
  const [types, codesTaken] = await Promise.all([
    prisma.collegeType.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.college.findMany({
      where: { code: { in: rows.map((r) => (r.values.code ?? '').toUpperCase()).filter(Boolean) } },
      select: { code: true },
    }),
  ]);
  const takenSet = new Set(codesTaken.map((c) => c.code.toUpperCase()));
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t.id]));
  const codeRows = new Map<string, number>();
  const out: CollegePreviewRow[] = [];

  for (const r of rows) {
    const v = r.values;
    const problems: string[] = [];
    const code = (v.code ?? '').toUpperCase();

    let collegeTypeId = '';
    if (v.type) {
      const id = typeByName.get(v.type.toLowerCase());
      if (id) collegeTypeId = id;
      else problems.push(`Type "${v.type}" is not on the list - pick one from the dropdown or leave it blank.`);
    }

    let affiliation: CollegeInput['affiliation'] = 'THIS_UNIVERSITY';
    if (v.affiliation) {
      const a = AFFILIATION_BY_LABEL[norm(v.affiliation)];
      if (a) affiliation = a;
      else if (v.affiliation.length > 3) {
        // A university's name typed straight into the Affiliation column.
        affiliation = 'OTHER';
        v.affiliationName = v.affiliationName || v.affiliation;
      } else problems.push(`Affiliation "${v.affiliation}" - use This university, Autonomous or Another university.`);
    }

    const parsed = collegeInputSchema.safeParse({
      name: v.name ?? '',
      code,
      collegeTypeId,
      affiliation,
      affiliationName: v.affiliationName ?? '',
      city: v.city ?? '',
      state: v.state ?? '',
      address: v.address ?? '',
      pincode: v.pincode ?? '',
      naacGrade: v.naacGrade ?? '',
      isVerified: false,
      officerName: v.officerName ?? '',
      officerEmail: (v.officerEmail ?? '').toLowerCase(),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(issue.message);
    }

    if (code) {
      if (takenSet.has(code)) problems.push(`Code ${code} is already used by another college on the platform.`);
      const first = codeRows.get(code);
      if (first !== undefined) problems.push(`Code ${code} is also on row ${first} of this file.`);
      else codeRows.set(code, r.row);
    }

    const name = v.name ?? '';
    if (problems.length === 0 && parsed.success) out.push({ row: r.row, name, code, status: 'valid', input: parsed.data });
    else out.push({ row: r.row, name, code, status: 'invalid', problems: [...new Set(problems)] });
  }

  return {
    rows: out,
    summary: {
      rows: out.length,
      valid: out.filter((r) => r.status === 'valid').length,
      invalid: out.filter((r) => r.status === 'invalid').length,
      officers: out.filter((r) => r.status === 'valid' && r.input.officerEmail).length,
    },
  };
}
