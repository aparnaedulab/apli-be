import ExcelJS from 'exceljs';
import { FIELD_BY_HEADER, normalise, templateFields } from '../students/fields.js';
import { defaultPolicy, isOn, isRequired, type IntakePolicy } from '../students/policy.js';
import type { StudentRow } from './students.service.js';

/**
 * The class-list workbook: downloaded, filled in, uploaded back.
 *
 * Every column, its help note and its two example values come from the
 * student field registry, which is also what the parser matches headers
 * against and what the student's own form is built from. One list, so the
 * template cannot print a column the parser ignores - which is exactly what
 * happened to "Graduating year".
 *
 * Generated per request rather than kept as a file, so the Batch, College
 * and Gender columns can be dropdowns of what exists right now. A static
 * template goes stale the moment a batch is added, and the result is a
 * spreadsheet full of values that create things nobody meant to create.
 */

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
  /**
   * The genders operations keeps, offered as a dropdown.
   *
   * The student's own form has offered this list for a long time; the sheet
   * took free text, so a roster of "M" and "MALE" made every one-gender role
   * invisible to those students.
   */
  genders?: string[];
  /**
   * The programmes this college runs, offered as a dropdown.
   *
   * One column, not a Course and a Branch: a college runs course-and-branch
   * pairs, and two independent columns are what let a row be half right -
   * the right course with the branch blank was the commonest thing that
   * quietly left a student mapped to nothing.
   *
   * A university sheet spans colleges, so the list cannot be one dropdown.
   * It gets a Programmes reference sheet instead.
   */
  programmes?: { label: string; collegeCode?: string }[];
  /**
   * What this institution collects and insists on.
   *
   * A column it has switched off is not printed, and one it insists on is
   * headed and noted as required - so the sheet somebody fills in is the
   * sheet the upload will accept, rather than a generic one they discover
   * the rules of afterwards.
   */
  policy?: IntakePolicy;
}

export async function buildStudentTemplate(
  options: StudentTemplateOptions = {},
): Promise<ExcelJS.Buffer> {
  // Standing inside a batch, the column is not a question anyone should
  // answer. The College column only exists on a university sheet, which is
  // the only one that spans colleges.
  const policy = options.policy ?? defaultPolicy();
  const columns = templateFields({ university: Boolean(options.collegeCodes) })
    .filter((c) => !(options.fixedBatchName && c.key === 'batch'))
    .filter((c) => isOn(policy, c.key));

  const needed = (c: { key: string }) => isRequired(policy, c.key);

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
      fgColor: { argb: col && needed(col) ? BRAND : 'FF52596A' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
    if (col) {
      cell.note = {
        texts: [{ text: `${needed(col) ? 'Required. ' : 'Optional. '}${col.note}` }],
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

  // Two sample students, read off the columns themselves rather than out of
  // a parallel array of positional strings - which is how the Example sheet
  // used to drift one column out of step with the Students sheet.
  [0, 1].forEach((which, r) => {
    const row = example.addRow(
      columns.map((c) =>
        c.key === 'college' ? (options.collegeCodes?.[0] ?? c.examples[which]!) : c.examples[which],
      ),
    );
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

  /* --- the College column, on a university sheet -------------------------- */

  /*
   * Validated against a range on the Colleges sheet, not an inline list.
   *
   * Excel caps an inline list at 255 characters, so a university with thirty
   * colleges used to silently get no dropdown at all - the check for it was
   * there, and its only effect was to drop the validation without saying so.
   * A range has no such limit.
   */
  if (options.collegeCodes) {
    const codes = options.collegeCodes;
    const list = wb.addWorksheet('Colleges');
    list.columns = [{ header: 'College codes', key: 'code', width: 20 }];
    const lh = list.getRow(1);
    lh.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    lh.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    if (codes.length === 0) list.addRow(['No colleges yet.']).font = { color: { argb: 'FF858DA0' } };
    codes.forEach((c) => list.addRow([c]));

    if (codes.length > 0) {
      const collegeCol = columns.findIndex((c) => c.key === 'college') + 1;
      for (let r = 2; r <= TEMPLATE_ROWS; r++) {
        sheet.getCell(r, collegeCol).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`Colleges!$A$2:$A$${codes.length + 1}`],
          showErrorMessage: true,
          errorTitle: 'Unknown college',
          error: 'Use a code from the "Colleges" sheet, or leave it blank.',
        };
      }
    }
  }

  /* --- the Programme column ----------------------------------------------- */

  const programmes = options.programmes ?? [];
  const programmeCol = columns.findIndex((c) => c.key === 'programme') + 1;

  if (programmes.length > 0 && programmeCol > 0) {
    const list = wb.addWorksheet('Programmes');
    list.columns = options.collegeCodes
      ? [
          { header: 'College', key: 'code', width: 14 },
          { header: 'Programme', key: 'label', width: 40 },
        ]
      : [{ header: 'Programme', key: 'label', width: 40 }];
    const ph = list.getRow(1);
    ph.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    ph.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    });
    for (const p of programmes) {
      list.addRow(options.collegeCodes ? [p.collegeCode ?? '', p.label] : [p.label]);
    }

    /*
     * A dropdown only on a college sheet.
     *
     * On a university sheet the valid programmes depend on the College code
     * in the same row, which one flat list cannot express - offering every
     * college's programmes in every row would be worse than offering none,
     * because it would read as permission. The reference sheet is the
     * honest answer there.
     */
    if (!options.collegeCodes) {
      for (let r = 2; r <= TEMPLATE_ROWS; r++) {
        sheet.getCell(r, programmeCol).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`Programmes!$A$2:$A$${programmes.length + 1}`],
          showErrorMessage: true,
          errorTitle: 'Not a programme this college runs',
          error: 'Pick one from the "Programmes" sheet.',
        };
      }
    }
  }

  /* --- the Gender column -------------------------------------------------- */

  /*
   * The same list the student's own form offers. A one-gender role groups on
   * the spelling that was recorded, so a roster of "M" and "MALE" made those
   * roles invisible to the students in it.
   */
  const genders = (options.genders ?? []).filter((g) => !g.includes(','));
  if (genders.length > 0) {
    const genderCol = columns.findIndex((c) => c.key === 'gender') + 1;
    for (let r = 2; r <= TEMPLATE_ROWS; r++) {
      sheet.getCell(r, genderCol).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${genders.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Not on the list',
        error: 'Pick one of the listed values, or leave it blank.',
      };
    }
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
