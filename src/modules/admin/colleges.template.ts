import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import type { CollegeRow } from './colleges.bulk.js';

/**
 * The workbook operations downloads, fills in, and uploads back.
 *
 * It is generated rather than kept as a static file so it can carry the
 * college types that exist *right now*, as a dropdown on the Type column. A
 * static template goes stale the first time somebody adds a type, and the
 * result is a spreadsheet full of values the importer will refuse.
 */

interface Column {
  header: string;
  key: keyof CollegeRow;
  width: number;
  required?: boolean;
  note: string;
  example: string;
}

function affiliationNote(home: string): string {
  return `Yes if affiliated to ${home}. No if autonomous. To name a different university, type its name here instead.`;
}

const COLUMNS: Column[] = [
  {
    header: 'College Name',
    key: 'name',
    width: 46,
    required: true,
    note: 'The full name, as it should appear to students and recruiters.',
    example: 'Government College of Engineering Pune',
  },
  {
    header: 'Code',
    key: 'code',
    width: 12,
    required: true,
    note: 'Short code, unique across the portal. Letters, numbers, dots and hyphens, up to 16.',
    example: 'COEP',
  },
  {
    header: 'City',
    key: 'city',
    width: 16,
    required: true,
    note: 'The city the campus is in.',
    example: 'Pune',
  },
  {
    header: 'State',
    key: 'state',
    width: 16,
    note: 'Leave blank to use the state set on the upload screen.',
    example: 'Maharashtra',
  },
  {
    header: 'Type',
    key: 'type',
    width: 20,
    note: 'Must be one from the list on the "Valid values" sheet. Leave blank if unsure.',
    example: 'Engineering',
  },
  {
    header: 'Affiliated',
    key: 'affiliation',
    width: 14,
    // Filled in per institution by buildCollegeTemplate.
    note: affiliationNote(env.HOME_UNIVERSITY),
    example: 'Yes',
  },
  {
    header: 'Address',
    key: 'address',
    width: 40,
    note: 'Street address of the campus.',
    example: 'Shivajinagar, Wellesley Road',
  },
  {
    header: 'Pincode',
    key: 'pincode',
    width: 12,
    note: 'Six digits.',
    example: '411005',
  },
  {
    header: 'NAAC',
    key: 'naacGrade',
    width: 10,
    note: 'NAAC grade, if accredited.',
    example: 'A+',
  },
];

const EXAMPLES: string[][] = [
  [
    'Government College of Engineering Pune',
    'COEP',
    'Pune',
    'Maharashtra',
    'Engineering',
    'Yes',
    'Shivajinagar, Wellesley Road',
    '411005',
    'A+',
  ],
  [
    'MIT World Peace University',
    'MITWPU',
    'Pune',
    '',
    'Engineering',
    'No',
    'Survey No. 124, Paud Road, Kothrud',
    '411038',
    'A++',
  ],
  [
    'Symbiosis Institute of Business Management',
    'SIBM',
    'Pune',
    '',
    'Management',
    'Yes',
    '',
    '412115',
    'A++',
  ],
];

/** How far down the dropdowns reach. One upload of more than this is unusual. */
const TEMPLATE_ROWS = 500;

const INK = 'FF14161C';
const RULE = 'FFE3E6EC';
const BRAND = 'FF1D3B8B';
const SAND = 'FFF6F4F0';

function styleHeader(row: ExcelJS.Row, columns: Column[]): void {
  row.height = 22;
  row.eachCell((cell, i) => {
    const col = columns[i - 1];
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      // Required columns are a different colour from optional ones, so the
      // person filling this in can see at a glance what they cannot skip.
      fgColor: { argb: col?.required ? BRAND : 'FF52596A' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
  });
}

/**
 * Builds the workbook. Three sheets: the one to fill in, the values the Type
 * column accepts, and a page explaining the rules the importer applies.
 */
export async function buildCollegeTemplate(
  homeUniversity: string = env.HOME_UNIVERSITY,
): Promise<ExcelJS.Buffer> {
  // The Affiliated note names the institution downloading the template.
  const columns = COLUMNS.map((c) =>
    c.key === 'affiliation' ? { ...c, note: affiliationNote(homeUniversity) } : c,
  );
  const types = await prisma.collegeType.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { name: true },
  });
  const typeNames = types.map((t) => t.name);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Apli.ai';
  wb.created = new Date();

  /* --- sheet 1: the one they fill in ------------------------------------ */
  const sheet = wb.addWorksheet('Colleges', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(sheet.getRow(1), columns);

  // A comment on each header carries the rule for that column, so the
  // explanation is where the question gets asked.
  columns.forEach((col, i) => {
    sheet.getRow(1).getCell(i + 1).note = {
      texts: [{ text: `${col.required ? 'Required. ' : 'Optional. '}${col.note}` }],
    };
  });

  // The examples live on their own sheet, never in the data. Filled-in rows in
  // the sheet people upload are a trap: forget to delete them and three
  // invented colleges land on the portal.
  const example = wb.addWorksheet('Example');
  example.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
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
  example.addRow(['This sheet is ignored on upload. Only "Colleges" is read.']).font = {
    color: { argb: 'FF858DA0' },
    italic: true,
  };

  // Pincode is text, not a number: 411005 must not become 411005.0, and a
  // leading zero must survive.
  sheet.getColumn('pincode').numFmt = '@';
  sheet.getColumn('code').numFmt = '@';

  // The Type column becomes a dropdown of exactly what the importer accepts.
  if (typeNames.length > 0) {
    const typeCol = columns.findIndex((c) => c.key === 'type') + 1;
    for (let r = 2; r <= TEMPLATE_ROWS; r++) {
      sheet.getCell(r, typeCol).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${typeNames.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Not a college type',
        error: 'Pick one from the list, or leave it blank. See the "Valid values" sheet.',
      };
    }
  }

  // Yes/No, for the same reason the Type column is a list: the importer has an
  // exact set of answers, so the file should only let you give one of them.
  const affiliatedCol = columns.findIndex((c) => c.key === 'affiliation') + 1;
  for (let r = 2; r <= TEMPLATE_ROWS; r++) {
    sheet.getCell(r, affiliatedCol).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"Yes,No"'],
      showErrorMessage: false, // a different university may be named here instead
    };
  }

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  /* --- sheet 2: what the Type column accepts ----------------------------- */
  const values = wb.addWorksheet('Valid values');
  values.columns = [{ header: 'College Type', key: 'name', width: 32 }];
  styleHeader(values.getRow(1), [{ ...columns[0]!, required: true }]);
  typeNames.forEach((name) => values.addRow([name]));
  values.addRow([]);
  values.addRow(['These are the types on the portal today.']).font = { color: { argb: 'FF858DA0' } };
  values.addRow(['To add another, use Settings before you upload.']).font = {
    color: { argb: 'FF858DA0' },
  };

  values.addRow([]);
  const affHead = values.addRow(['Affiliated']);
  affHead.font = { bold: true, size: 12, color: { argb: INK } };
  values.addRow([`Yes  -  affiliated to ${homeUniversity}`]);
  values.addRow(['No   -  autonomous, or not affiliated to any university']);
  values.addRow(['Or type the name of a different university.']).font = {
    color: { argb: 'FF858DA0' },
  };

  /* --- sheet 3: the rules ------------------------------------------------ */
  const help = wb.addWorksheet('How to fill this in');
  help.columns = [{ width: 4 }, { width: 96 }];

  const lines: [string, string][] = [
    ['h', 'Adding colleges in bulk'],
    ['p', 'Fill in the "Colleges" sheet, one college per row, then upload the file.'],
    ['p', 'The "Example" sheet shows three filled-in rows. It is ignored on upload — only the "Colleges" sheet is read — so there is nothing to delete before you send the file.'],
    ['h', 'What is required'],
    ['p', 'College Name, Code and City. Everything else can be left blank and filled in later on the college’s own page.'],
    ['p', 'State can be left blank if every college in the file is in the same state — you set that once on the upload screen.'],
    ['h', 'Codes'],
    ['p', 'The Code is how the portal identifies a college, so it must be unique. Letters, numbers, dots and hyphens, up to 16 characters. Case does not matter: "coep" and "COEP" are the same code.'],
    ['h', 'Affiliated'],
    ['p', `Yes means the college is affiliated to ${homeUniversity} — that is the answer for almost every row, which is why it is a tick rather than a name to retype.`],
    ['p', 'No means autonomous. If a college is affiliated to some other university, type that university’s name in the column instead of Yes or No.'],
    ['p', 'A blank is read as No. If most of your list is affiliated, fill the column in rather than leaving it empty.'],
    ['h', 'Types'],
    ['p', 'The Type column only accepts values on the "Valid values" sheet. A row naming anything else is refused rather than imported without a type — a college with no type is one nobody can filter for.'],
    ['h', 'What happens on upload'],
    ['p', 'Every row is checked on its own. Good rows are added; bad rows are listed back with the reason, and you fix and re-upload just those.'],
    ['p', 'Re-uploading the whole file is safe. A college already on the portal is skipped, not duplicated.'],
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

/** Header text to field, so a file whose columns were reordered still reads. */
const BY_HEADER = new Map<string, keyof CollegeRow>(
  COLUMNS.map((c) => [c.header.toLowerCase().replace(/[^a-z0-9]/g, ''), c.key]),
);

/** The aliases the pasted-text importer accepts, so both doors take the same files. */
const EXTRA_ALIASES: Record<string, keyof CollegeRow> = {
  college: 'name',
  collegename: 'name',
  institute: 'name',
  institutename: 'name',
  institution: 'name',
  collegecode: 'code',
  dtecode: 'code',
  shortcode: 'code',
  shortname: 'code',
  abbreviation: 'code',
  town: 'city',
  district: 'city',
  location: 'city',
  collegetype: 'type',
  category: 'type',
  discipline: 'type',
  affiliatedto: 'affiliation',
  university: 'affiliation',
  pin: 'pincode',
  postalcode: 'pincode',
  zip: 'pincode',
  naacgrade: 'naacGrade',
  grade: 'naacGrade',
  accreditation: 'naacGrade',
};

/** A cell can be a string, a number, a formula result or a rich-text object. */
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

/**
 * Reads an uploaded workbook into the same rows the pasted-text path produces,
 * so both go through one importer and cannot diverge in what they accept.
 */
export async function parseCollegeWorkbook(buffer: Buffer): Promise<CollegeRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  // The sheet we named, if it is still called that; otherwise the first one,
  // because people rename tabs.
  const sheet = wb.getWorksheet('Colleges') ?? wb.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const map = new Map<number, keyof CollegeRow>();

  headerRow.eachCell((cell, col) => {
    const key = cellText(cell.value).toLowerCase().replace(/[^a-z0-9]/g, '');
    const field = BY_HEADER.get(key) ?? EXTRA_ALIASES[key];
    if (field) map.set(col, field);
  });

  if (!map.size) return [];

  const rows: CollegeRow[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;

    const parsed: CollegeRow = { name: '', code: '' };
    let hasAnything = false;

    for (const [col, field] of map) {
      const text = cellText(row.getCell(col).value);
      if (text) {
        parsed[field] = text;
        hasAnything = true;
      }
    }

    // Blank rows below the data are normal in a spreadsheet somebody edited.
    if (hasAnything) rows.push(parsed);
  });

  return rows;
}
