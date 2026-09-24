import ExcelJS from 'exceljs';
import type { PlacementReport } from './reports.service.js';

/**
 * The report as the workbook a placement officer attaches to an NAAC SSR or a
 * NIRF data capture.
 *
 * One sheet per thing an accreditation form asks for, laid out the way the
 * form lays it out, so filling the form is copying rows rather than doing
 * sums. Anything the portal does not know is written as "Not tracked" -
 * never a zero, which would read as a fact.
 */

const INK = 'FF14161C';
const BRAND = 'FF1D3B8B';
const MUTED = 'FF858DA0';
const RULE = 'FFE3E6EC';
const SAND = 'FFF6F4F0';

const NOT_TRACKED = 'Not tracked';

interface Col {
  header: string;
  width: number;
  /** Rupees - whole numbers with thousands separators. */
  money?: boolean;
  percent?: boolean;
}

function sheet(wb: ExcelJS.Workbook, name: string, title: string, subtitle: string, cols: Col[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.columns = cols.map((c) => ({ width: c.width }));

  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: INK } };
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { size: 10, color: { argb: MUTED } };

  const head = ws.getRow(4);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
  });
  head.height = 30;

  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.money) col.numFmt = '#,##0';
    if (c.percent) col.numFmt = '0.0"%"';
  });

  return {
    ws,
    add(values: (string | number | null)[], zebra = false) {
      const row = ws.addRow(values.map((v) => (v === null ? '—' : v)));
      if (zebra) row.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } }));
      return row;
    },
  };
}

export async function buildReportWorkbook(report: PlacementReport): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Apli.ai';
  wb.created = new Date();

  const period = report.filter.placement
    ? `Drive: ${report.filter.placement.name}`
    : `Students passing out in ${report.filter.year}`;
  const heading = `${report.scope.name} · ${period}`;
  const f = report.final;

  /* --- NIRF: graduation outcome ------------------------------------------- */
  const nirf = sheet(wb, 'NIRF Placement', 'NIRF - Graduation outcome (placement)', heading, [
    { header: 'Academic year (passing out)', width: 22 },
    { header: 'Students graduating in minimum time (pool)', width: 26 },
    { header: 'Students placed', width: 16 },
    { header: 'Median salary of placed graduates (₹ per year)', width: 26, money: true },
    { header: 'Students selected for higher studies', width: 22 },
  ]);
  nirf.add([
    report.filter.year ? `${report.filter.year - 1}-${String(report.filter.year).slice(2)}` : (report.filter.placement?.name ?? ''),
    report.pool,
    f.placed,
    f.pay.median,
    NOT_TRACKED,
  ]);

  /* --- NAAC 5.2.1: placement of outgoing students ------------------------- */
  const naac = sheet(wb, 'NAAC 5.2.1', 'NAAC 5.2.1 - Placement of outgoing students', heading, [
    { header: 'Year', width: 14 },
    { header: 'Outgoing students (pool)', width: 18 },
    { header: 'Students placed', width: 16 },
    { header: 'Percentage placed', width: 16, percent: true },
    { header: 'Recruiting companies', width: 18 },
    { header: 'Highest salary (₹ per year)', width: 20, money: true },
    { header: 'Average salary (₹ per year)', width: 20, money: true },
  ]);
  naac.add([report.filter.year ?? report.filter.placement?.name ?? '', report.pool, f.placed, f.placedPct, f.recruiters, f.pay.highest, f.pay.average]);

  /* --- NBA: by programme -------------------------------------------------- */
  const nba = sheet(wb, 'NBA by programme', 'NBA - Placement by programme', heading, [
    { header: 'Course', width: 16 },
    { header: 'Branch', width: 30 },
    { header: 'Students (pool)', width: 14 },
    { header: 'Placed', width: 10 },
    { header: 'Percentage placed', width: 16, percent: true },
    { header: 'Median salary (₹ per year)', width: 20, money: true },
    { header: 'Highest salary (₹ per year)', width: 20, money: true },
  ]);
  report.byBranch.forEach((b, i) =>
    nba.add([b.course ?? 'Not recorded', b.branch ?? 'All branches', b.pool, b.placed, b.placedPct, b.medianCtc, b.highestCtc], i % 2 === 1),
  );

  /* --- by company ---------------------------------------------------------- */
  const co = sheet(wb, 'By company', 'Final placements by company', heading, [
    { header: 'Company', width: 32 },
    { header: 'Offers made', width: 14 },
    { header: 'Offers accepted', width: 16 },
    { header: 'Median salary (₹ per year)', width: 20, money: true },
    { header: 'Highest salary (₹ per year)', width: 20, money: true },
  ]);
  report.byCompany.forEach((c, i) => co.add([c.company, c.offers, c.accepted, c.medianCtc, c.highestCtc], i % 2 === 1));

  /* --- by branch (short) or by college (institution) ------------------------ */
  if (report.byCollege.length > 0) {
    const col = sheet(wb, 'By college', 'Final placements by college', heading, [
      { header: 'College', width: 36 },
      { header: 'Code', width: 12 },
      { header: 'Students (pool)', width: 14 },
      { header: 'Placed', width: 10 },
      { header: 'Percentage placed', width: 16, percent: true },
      { header: 'Median salary (₹ per year)', width: 20, money: true },
      { header: 'Recruiting companies', width: 18 },
    ]);
    report.byCollege.forEach((c, i) =>
      col.add([c.college, c.code, c.pool, c.placed, c.placedPct, c.medianCtc, c.recruiters], i % 2 === 1),
    );
  }

  const br = sheet(wb, 'By branch', 'Students and placements by branch', heading, [
    { header: 'Branch', width: 36 },
    { header: 'Students (pool)', width: 14 },
    { header: 'Placed', width: 10 },
    { header: 'Percentage placed', width: 16, percent: true },
  ]);
  report.byBranch.forEach((b, i) =>
    br.add([[b.course, b.branch].filter(Boolean).join(' - ') || 'Not recorded', b.pool, b.placed, b.placedPct], i % 2 === 1),
  );

  /* --- notes --------------------------------------------------------------- */
  const notes = wb.addWorksheet('Notes');
  notes.getColumn(1).width = 110;
  const line = (text: string, opts: Partial<ExcelJS.Font> = {}) => {
    const row = notes.addRow([text]);
    row.font = { size: 11, color: { argb: INK }, ...opts };
    row.alignment = { wrapText: true };
  };
  line('How these numbers were counted', { bold: true, size: 14 });
  line(`${heading}. Generated ${new Date(report.generatedAt).toLocaleString('en-IN')} from records on the Apli.ai portal.`, {
    color: { argb: MUTED },
  });
  notes.addRow([]);
  line('Pool', { bold: true });
  line(
    report.filter.placement
      ? 'Every student in the batches taking part in this drive.'
      : 'Every student whose passing year is the one chosen (or, where their own record has none, whose batch has it).',
  );
  line('Placed', { bold: true });
  line('A student who accepted an offer that stood (accepted or hired). A student with two accepted offers is counted once.');
  line('Salary', { bold: true });
  line(
    `The fixed annual CTC stated on the role, taking each placed student's best offer once. Where only a range was given its lower end is used (${f.payBasis.fromRangeMin} offer${f.payBasis.fromRangeMin === 1 ? '' : 's'}); offers with no pay stated are left out (${f.payBasis.missing}).`,
  );
  line('Internships', { bold: true });
  line(
    `Counted separately from final placements and not included in any sheet above: ${report.internship.placed} of ${report.pool} students accepted an internship; median stipend ₹${report.internship.pay.median ?? '—'} a month.`,
  );
  notes.addRow([]);
  line('Not tracked by the portal', { bold: true });
  report.notTracked.forEach((n) => line(`•  ${n}`));
  notes.addRow([]);
  line(report.consentNote, { italic: true, color: { argb: MUTED } });

  return wb.xlsx.writeBuffer();
}
