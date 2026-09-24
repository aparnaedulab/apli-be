import ExcelJS from 'exceljs';
import { FIELD_BY_HEADER, normalise, type StudentRow } from './students.service.js';

/**
 * The class-list workbook: downloaded, filled in, uploaded back.
 *
 * Generated per request rather than kept as a file, so the Batch column can be
 * a dropdown of the batches that exist for this college right now. A static
 * template would go stale the moment a batch is added, and the result is a
 * spreadsheet full of values that create batches nobody meant to create.
 */

interface Column {
  header: string;
  key: keyof StudentRow;
  width: number;
  required?: boolean;
  note: string;
}

const COLUMNS: Column[] = [
  {
    header: 'Name',
    key: 'fullName',
    width: 24,
    required: true,
    note: 'The student’s full name, as it should appear to recruiters.',
  },
  {
    header: 'Email',
    key: 'email',
    width: 30,
    required: true,
    note: 'Their own address. The activation link goes here, and it is how they sign in.',
  },
  {
    header: 'Mobile',
    key: 'phone',
    width: 16,
    required: true,
    note: 'Ten digits. +91, spaces and dashes are all fine.',
  },
  {
    header: 'Batch',
    key: 'batch',
    width: 22,
    note: 'Which group they belong to. Pick one from the list, or type a new name and it will be created.',
  },
  {
    header: 'Course',
    key: 'course',
    width: 14,
    note: 'B.Tech, MCA, MBA. This is the student’s own course - recruiters filter on it.',
  },
  {
    header: 'Branch',
    key: 'specialisation',
    width: 26,
    note: 'Computer Science, Mechanical, Finance.',
  },
  {
    header: 'Graduating year',
    key: 'graduationYear',
    width: 16,
    note: 'Four digits. Recruiters filter on it, so it is worth filling in.',
  },
  { header: 'Roll No', key: 'rollNo', width: 14, note: 'The college roll number. Unique within a batch.' },
  {
    header: 'PRN',
    key: 'prn',
    width: 18,
    note: 'The university registration number. Unique across the whole platform.',
  },
  { header: 'Div', key: 'division', width: 8, note: 'Division or section, if you use them.' },
  { header: 'Gender', key: 'gender', width: 12, note: 'Optional, and free text.' },
  {
    header: 'DOB',
    key: 'dateOfBirth',
    width: 14,
    note: '2005-04-17 or 17/04/2005. Both are understood.',
  },
  { header: 'CGPA', key: 'cgpa', width: 10, note: 'Out of 10. Recruiters filter on this.' },
  {
    header: 'Percentage',
    key: 'degreePct',
    width: 12,
    note: 'Degree percentage, if your university awards one instead of a CGPA.',
  },
  { header: '10th %', key: 'tenthPct', width: 10, note: 'SSC percentage.' },
  {
    header: '12th %',
    key: 'twelfthPct',
    width: 10,
    note: 'HSC percentage. Leave blank for a student who came through a diploma - fill in Diploma % instead, and a role asking for a 12th will read that.',
  },
  {
    header: 'Diploma %',
    key: 'diplomaPct',
    width: 11,
    note: 'For lateral-entry students, who have no 12th standard result. Without it, any role that sets a 12th bar is invisible to them.',
  },
  {
    header: 'Live backlogs',
    key: 'activeBacklogs',
    width: 13,
    note: 'Still outstanding right now. Almost every criteria sheet says "no live backlogs", and a role asking for it cannot see a student this is blank for.',
  },
  {
    header: 'Backlogs (total)',
    key: 'backlogs',
    width: 15,
    note: 'Ever accumulated, including ones since cleared. Different from live backlogs - "no live, at most two ever" is one sentence asking for both.',
  },
  {
    header: 'PG CGPA',
    key: 'pgCgpa',
    width: 11,
    note: 'Only for a student on a master’s - an MCA, M.Tech or MBA. Their bachelor’s goes in the CGPA column; this is the degree they are on now.',
  },
  {
    header: 'PG %',
    key: 'pgPct',
    width: 10,
    note: 'The same, where the university awards a percentage rather than a CGPA.',
  },
  {
    header: 'Gap years',
    key: 'gapYears',
    width: 11,
    note: 'Years out of study. 0 if none. Invisible in a CGPA and asked for constantly.',
  },
];

const EXAMPLES = [
  [
    'Aditi Rane',
    'aditi.rane@pict.demo-college.example',
    '9000000023',
    'CSE 2026',
    'B.Tech',
    'Computer Science',
    '2026',
    'CS22-101',
    '72012301K',
    'A',
    'Female',
    '17/04/2005',
    '8.6',
    '',
    '91',
    '88',
    '',
    '0',
    '0',
    '',
    '',
    '0',
  ],
  [
    'Kunal Deshmukh',
    'kunal.d@pict.demo-college.example',
    '9000000024',
    'CSE 2026',
    'B.Tech',
    'Computer Science',
    '2026',
    'CS22-102',
    '72012302K',
    'A',
    'Male',
    '02/11/2004',
    '7.9',
    '',
    '86',
    '',
    '78',
    '0',
    '1',
    '',
    '',
    '1',
  ],
];

const TEMPLATE_ROWS = 600;

const INK = 'FF14161C';
const RULE = 'FFE3E6EC';
const BRAND = 'FF1D3B8B';
const SAND = 'FFF6F4F0';

export interface StudentTemplateOptions {
  /** Offered as a dropdown on the Batch column. */
  batchNames?: string[];
  /** Set when the file is for one batch, which then has no Batch column at all. */
  fixedBatchName?: string;
  collegeName?: string;
  /**
   * Set for a university-level upload, which then gets a College code column
   * offering these. Blank in that column means "not placed in a college yet".
   */
  collegeCodes?: string[];
}

const COLLEGE_COLUMN: Column = {
  header: 'College code',
  key: 'college',
  width: 14,
  note: 'The college’s short code, from the "Colleges" sheet. Leave blank if the college is not known yet - the student can be placed in one later, from Map data.',
};

export async function buildStudentTemplate(
  options: StudentTemplateOptions = {},
): Promise<ExcelJS.Buffer> {
  // Standing inside a batch, the column is not a question anyone should answer.
  const base = options.fixedBatchName ? COLUMNS.filter((c) => c.key !== 'batch') : COLUMNS;
  // After Mobile: which college is the first thing a university sheet sorts on.
  const columns = options.collegeCodes
    ? [...base.slice(0, 3), COLLEGE_COLUMN, ...base.slice(3)]
    : base;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Apli.ai';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Students', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell, i) => {
    const col = columns[i - 1];
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      // Required columns read differently at a glance from optional ones.
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

  // The examples live on their own sheet, never in the data.
  //
  // Filled-in rows in the sheet people upload are a trap: forget to delete
  // them and two invented students land on a real roster, each with a live
  // invitation. The shape is just as clear one tab across.
  const example = wb.addWorksheet('Example');
  example.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const eh = example.getRow(1);
  eh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  eh.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF52596A' } };
  });

  EXAMPLES.forEach((values, r) => {
    let shown = options.fixedBatchName ? values.filter((_, i) => i !== 3) : values;
    if (options.collegeCodes) {
      shown = [...shown.slice(0, 3), options.collegeCodes[0] ?? 'PICT', ...shown.slice(3)];
    }
    const row = example.addRow(shown);
    row.eachCell((cell) => {
      cell.font = { color: { argb: 'FF52596A' } };
      if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    });
  });

  example.addRow([]);
  example.addRow(['This sheet is ignored on upload. Only "Students" is read.']).font = {
    color: { argb: 'FF858DA0' },
    italic: true,
  };

  // Text, not numbers: a roll number must not lose a leading zero and a mobile
  // number must not arrive as 9.82001e+09.
  for (const key of ['phone', 'rollNo', 'prn', 'graduationYear'] as const) {
    const col = columns.find((c) => c.key === key);
    if (col) sheet.getColumn(key).numFmt = '@';
  }

  const batchNames = (options.batchNames ?? []).filter((n) => !n.includes(','));
  if (!options.fixedBatchName && batchNames.length > 0) {
    const batchCol = columns.findIndex((c) => c.key === 'batch') + 1;
    for (let r = 2; r <= TEMPLATE_ROWS; r++) {
      sheet.getCell(r, batchCol).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${batchNames.join(',')}"`],
        // Not an error: typing a new batch name is how a new batch is made.
        showErrorMessage: false,
      };
    }
  }

  const codes = (options.collegeCodes ?? []).filter((c) => !c.includes(','));
  const codesFit = codes.join(',').length < 250; // Excel's limit on an inline list
  if (codes.length > 0 && codesFit) {
    const collegeCol = columns.findIndex((c) => c.key === 'college') + 1;
    for (let r = 2; r <= TEMPLATE_ROWS; r++) {
      sheet.getCell(r, collegeCol).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${codes.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Unknown college',
        error: 'Use a code from the "Colleges" sheet, or leave it blank.',
      };
    }
  }

  if (options.collegeCodes) {
    const list = wb.addWorksheet('Colleges');
    list.columns = [{ header: 'College codes', key: 'code', width: 20 }];
    const lh = list.getRow(1);
    lh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    lh.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    if (codes.length === 0) list.addRow(['No colleges yet.']).font = { color: { argb: 'FF858DA0' } };
    codes.forEach((c) => list.addRow([c]));
  }

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  /* --- what the Batch column accepts ------------------------------------- */
  if (!options.fixedBatchName) {
    const values = wb.addWorksheet('Batches');
    values.columns = [{ header: 'Existing batches', key: 'name', width: 34 }];
    const vh = values.getRow(1);
    vh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    vh.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };

    if (batchNames.length === 0) {
      values.addRow(['No batches yet.']).font = { color: { argb: 'FF858DA0' } };
    } else {
      batchNames.forEach((n) => values.addRow([n]));
    }
    values.addRow([]);
    values.addRow(['Type any other name in the Batch column and it will be created.']).font = {
      color: { argb: 'FF858DA0' },
    };
    values.addRow(['Leave it blank and the student goes into "Unassigned".']).font = {
      color: { argb: 'FF858DA0' },
    };
  }

  /* --- the rules ---------------------------------------------------------- */
  const help = wb.addWorksheet('How to fill this in');
  help.columns = [{ width: 4 }, { width: 96 }];

  const lines: [string, string][] = [
    ['h', `Adding students${options.collegeName ? ` to ${options.collegeName}` : ''}`],
    [
      'p',
      options.fixedBatchName
        ? `Every row in this file goes into "${options.fixedBatchName}". There is no Batch column, because the batch is already chosen.`
        : 'Fill in the "Students" sheet, one student per row, then upload the file.',
    ],
    ['p', 'The "Example" sheet shows two filled-in rows. It is ignored on upload — only the "Students" sheet is read — so there is nothing to delete before you send the file.'],
    ['h', 'What is required'],
    ['p', 'Name, Email and Mobile. Those three are how anyone reaches the student, and a roster entry without them is not usable. Everything else can be left blank and filled in later, by you or by the student.'],
    ['h', 'What happens on upload'],
    ['p', 'Each student gets a record straight away — name, roll number and marks show on the roster at once — and a one-time link to set their own password. Nobody, including you, ever sees that password.'],
    ['p', 'Every row is checked on its own. Good rows are added; bad rows come back with the reason, and you fix and re-upload just those.'],
    ['p', 'Re-uploading the whole file is safe. A student already on the platform is skipped, not duplicated.'],
    ['h', 'Marks'],
    ['p', 'CGPA, 10th, 12th and Backlogs are what recruiters filter on. A student missing them is invisible to any role that sets a bar — worth filling in even though nothing forces you to.'],
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

/** A cell can be a string, a number, a date, a formula result or rich text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Excel dates arrive as Date objects; the service understands ISO.
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

export async function parseStudentWorkbook(buffer: Buffer): Promise<StudentRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  // The sheet we named, if it is still called that; otherwise the first one,
  // because people rename tabs.
  const sheet = wb.getWorksheet('Students') ?? wb.worksheets[0];
  if (!sheet) return [];

  const map = new Map<number, keyof StudentRow>();
  sheet.getRow(1).eachCell((cell, col) => {
    const field = FIELD_BY_HEADER.get(normalise(cellText(cell.value)));
    if (field) map.set(col, field);
  });

  if (!map.size) return [];

  const rows: StudentRow[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;

    const parsed: StudentRow = { fullName: '', email: '', phone: '' };
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
