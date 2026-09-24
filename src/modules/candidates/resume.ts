import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { linksOf } from './candidate.service.js';
import type { LoadedProfile } from './candidate.service.js';

/**
 * A resume, drawn from what the student has already told us.
 *
 * The point of building it here rather than offering a blank template is that
 * nothing has to be typed twice: a campus student's education, marks, skills,
 * projects and internships are already on their profile because a recruiter
 * filters on them. What is left to decide is what to leave out, which is the
 * part of writing a resume people actually get wrong.
 *
 * The rules below are the opinion of the thing. A fresher's resume is one
 * page; it leads with what a campus recruiter screens on, which is the degree
 * and the marks, not a paragraph about passion; and every project carries the
 * link that proves it. None of that is configurable, because a builder whose
 * defaults are wrong is just a worse word processor.
 */

/* --- the page ------------------------------------------------------------- */

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

/** Every section this can draw, in the order it draws them by default. */
export const RESUME_SECTIONS = ['summary', 'education', 'experience', 'projects', 'skills'] as const;
export type ResumeSection = (typeof RESUME_SECTIONS)[number];

/**
 * The layouts on offer, and what each is actually for.
 *
 * Not skins. A fresher's resume is read in two very different ways - skimmed
 * against a criteria sheet, or read properly by somebody who already likes
 * the look of it - and these are shaped for that rather than for variety:
 *
 *   classic  one column, generous. The safe answer, and the one to use when
 *            somebody is going to read it rather than scan it.
 *   compact  the same column, tightened. For a student whose projects and
 *            internships have stopped fitting on one page.
 *   sidebar  contact, skills and marks down the left, the story on the right.
 *            Puts what a recruiter screens on where the eye lands first.
 */
export const RESUME_LAYOUTS = ['classic', 'compact', 'sidebar'] as const;
export type ResumeLayout = (typeof RESUME_LAYOUTS)[number];

interface Metrics {
  margin: number;
  name: number;
  heading: number;
  body: number;
  small: number;
  gap: number;
  /** Width of the left column, where there is one. */
  aside: number;
}

const METRICS: Record<ResumeLayout, Metrics> = {
  classic: { margin: 44, name: 20, heading: 10.5, body: 10, small: 9.5, gap: 0.7, aside: 0 },
  compact: { margin: 34, name: 17, heading: 9.5, body: 9, small: 8.5, gap: 0.42, aside: 0 },
  sidebar: { margin: 38, name: 19, heading: 10, body: 9.5, small: 9, gap: 0.6, aside: 152 },
};

export const resumeBuildSchema = z.object({
  /** Two or three lines in their own words. Blank leaves the section out. */
  summary: z.string().trim().max(600).optional().or(z.literal('')),
  /** Which sections to draw, in the order given. Unknown names are ignored. */
  sections: z.array(z.enum(RESUME_SECTIONS)).max(RESUME_SECTIONS.length).optional(),
  /** Ids to leave out, so a student can drop the weaker of two projects. */
  hide: z.array(z.string()).max(100).optional(),
  /** Marks are on a fresher's resume by default; some would rather not. */
  showMarks: z.boolean().optional(),
  /** How it is laid out. See RESUME_LAYOUTS for what each one is for. */
  layout: z.enum(RESUME_LAYOUTS).optional(),
});

export type ResumeBuild = z.infer<typeof resumeBuildSchema>;

/* --- drawing -------------------------------------------------------------- */

type Doc = InstanceType<typeof PDFDocument>;

function heading(doc: Doc, text: string, m: Metrics, left = 0, width = 0) {
  // A rule under the heading rather than a coloured band: it survives being
  // printed in black and white, which is how these are often read.
  doc.moveDown(m.gap);
  const x = left || doc.page.margins.left;
  const w = width || doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(m.heading)
    .text(text.toUpperCase(), x, doc.y, { width: w, characterSpacing: 0.8 });

  const y = doc.y + 2;
  doc.strokeColor(RULE).lineWidth(0.7).moveTo(x, y).lineTo(x + w, y).stroke();
  doc.moveDown(0.45);
}

/**
 * A line with something on the left and a date on the right.
 *
 * The date is measured and its room taken out of the left column before the
 * left is drawn. Giving both the full width let a long title run straight
 * under the date and print on top of it - which is not a rare case on a
 * campus resume, where "Teaching assistant, Data Structures, <the whole name
 * of the college>" is an ordinary line.
 */
function row(doc: Doc, left: string, right: string, m: Metrics, x: number, w: number) {
  const top = doc.y;
  const dateSize = m.small - 0.5;

  const dateW = right
    ? doc.font('Helvetica').fontSize(dateSize).widthOfString(right) + 10
    : 0;

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(m.body)
    .text(left, x, top, { width: Math.max(40, w - dateW) });

  if (right) {
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(dateSize)
      .text(right, x, top + 0.5, { width: w, align: 'right' });
  }

  doc.y = Math.max(doc.y, top + m.body + 2);
}

function detail(doc: Doc, text: string, m: Metrics, x: number, w: number) {
  doc.fillColor(MUTED).font('Helvetica').fontSize(m.small).text(text, x, doc.y, { width: w, lineGap: 1.5 });
}

const year = (d: Date | null) => (d ? String(new Date(d).getFullYear()) : '');
const month = (d: Date | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '';

/**
 * Renders the resume and resolves with the finished PDF.
 *
 * Buffered rather than streamed to the response: it is stored as a file like
 * any other upload, so the bytes have to exist before anything is written.
 */
export function renderResume(profile: LoadedProfile, build: ResumeBuild): Promise<Buffer> {
  const hidden = new Set(build.hide ?? []);
  const chosen = build.sections?.length ? build.sections : [...RESUME_SECTIONS];
  const showMarks = build.showMarks ?? true;
  const layout: ResumeLayout = build.layout ?? 'classic';
  const m = METRICS[layout];

  const doc = new PDFDocument({
    size: 'A4',
    margin: m.margin,
    info: { Title: `${profile.user.fullName} - Resume` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const full = doc.page.width - m.margin * 2;
  /* Where the story goes, which is the whole width unless there is an aside. */
  const mainX = layout === 'sidebar' ? m.margin + m.aside + 18 : m.margin;
  const mainW = layout === 'sidebar' ? full - m.aside - 18 : full;

  const batch = profile.batchMemberships[0]?.batch;
  const contactBits = [profile.user.email, profile.phone, batch?.college?.name].filter(Boolean) as string[];
  const marksBits = [
    profile.cgpa !== null ? `Degree CGPA ${Number(profile.cgpa)}` : null,
    profile.tenthPct !== null ? `10th ${Number(profile.tenthPct)}%` : null,
    profile.twelfthPct !== null ? `12th ${Number(profile.twelfthPct)}%` : null,
    profile.diplomaPct !== null ? `Diploma ${Number(profile.diplomaPct)}%` : null,
  ].filter(Boolean) as string[];
  const skillNames = profile.skills.map((s) => s.skill.name).filter((n) => !hidden.has(n));

  /* --- who they are, which is never optional --- */
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(m.name).text(profile.user.fullName, m.margin, m.margin, {
    width: full,
  });
  if (profile.headline) {
    doc.moveDown(0.15);
    doc.fillColor(MUTED).font('Helvetica').fontSize(m.body).text(profile.headline, { width: full });
  }

  if (layout !== 'sidebar') {
    // One line, because a recruiter needs to reach them, not admire the layout.
    doc.moveDown(0.3);
    doc.fillColor(MUTED).font('Helvetica').fontSize(m.small).text(contactBits.join('  ·  '), { width: full });
  }

  const headerBottom = doc.y;

  /* --- the aside, where the layout has one --- */
  if (layout === 'sidebar') {
    doc.y = headerBottom;
    const x = m.margin;
    const w = m.aside;

    heading(doc, 'Contact', m, x, w);
    for (const bit of contactBits) detail(doc, bit, m, x, w);

    if (showMarks && marksBits.length) {
      heading(doc, 'Marks', m, x, w);
      for (const bit of marksBits) detail(doc, bit, m, x, w);
    }

    if (chosen.includes('skills') && skillNames.length) {
      heading(doc, 'Skills', m, x, w);
      for (const name of skillNames) detail(doc, name, m, x, w);
    }

    // A hairline between the columns, so the eye knows which is which.
    doc
      .strokeColor(RULE)
      .lineWidth(0.5)
      .moveTo(x + w + 9, headerBottom + 6)
      .lineTo(x + w + 9, doc.page.height - m.margin)
      .stroke();

    doc.y = headerBottom;
  }

  /* --- the story --- */
  const body = (text: string, size = m.body, colour = INK) =>
    doc.fillColor(colour).font('Helvetica').fontSize(size).text(text, mainX, doc.y, { width: mainW, lineGap: 1.5 });

  for (const section of chosen) {
    if (section === 'summary') {
      const text = (build.summary || profile.about || '').trim();
      if (!text) continue;
      heading(doc, 'Summary', m, mainX, mainW);
      body(text);
    }

    if (section === 'education') {
      const rows = profile.educations.filter((e) => !hidden.has(e.id));
      if (rows.length === 0) continue;
      heading(doc, 'Education', m, mainX, mainW);
      for (const e of rows) {
        const when = `${e.startYear}${e.endYear ? `–${e.endYear}` : ''}`;
        row(doc, `${e.degree}${e.institution ? `, ${e.institution}` : ''}`, when, m, mainX, mainW);
        const marks = [
          e.cgpa !== null ? `CGPA ${Number(e.cgpa)}` : null,
          e.percentage !== null ? `${Number(e.percentage)}%` : null,
          e.board,
        ].filter(Boolean);
        if (showMarks && marks.length) detail(doc, marks.join('  ·  '), m, mainX, mainW);
      }

      /*
       * The degree marks the college verified, said once and plainly.
       *
       * A campus recruiter screens on these before reading a word, and they
       * are the one thing on here somebody else has vouched for - so they are
       * not left to be inferred from the education rows. The sidebar has
       * already said them, so it does not say them twice.
       */
      if (showMarks && layout !== 'sidebar' && marksBits.length) {
        doc.moveDown(0.15);
        detail(doc, marksBits.join('  ·  '), m, mainX, mainW);
      }
    }

    if (section === 'experience') {
      const rows = profile.experiences.filter((x) => !hidden.has(x.id));
      if (rows.length === 0) continue;
      heading(doc, 'Experience', m, mainX, mainW);
      for (const x of rows) {
        row(
          doc,
          `${x.title}, ${x.organisation}`,
          `${month(x.startDate)} – ${x.isCurrent || !x.endDate ? 'Present' : month(x.endDate)}`,
          m,
          mainX,
          mainW,
        );
        if (x.location) detail(doc, x.location, m, mainX, mainW);
        if (x.description) body(x.description, m.small);
        doc.moveDown(0.3);
      }
    }

    if (section === 'projects') {
      const rows = profile.projects.filter((p) => !hidden.has(p.id));
      if (rows.length === 0) continue;
      heading(doc, 'Projects', m, mainX, mainW);
      for (const p of rows) {
        const when = p.startDate ? `${year(p.startDate)}${p.endDate ? `–${year(p.endDate)}` : ''}` : '';
        row(doc, p.title, when, m, mainX, mainW);
        if (p.description) body(p.description, m.small);

        // The link is the point of listing a project: it is the only claim on
        // here a reader can check for themselves.
        for (const l of linksOf(p.links)) {
          doc
            .fillColor('#1d4ed8')
            .font('Helvetica')
            .fontSize(m.small - 0.5)
            .text(l.label ? `${l.label}: ${l.url}` : l.url, mainX, doc.y, {
              width: mainW,
              link: l.url,
              underline: false,
            });
        }
        doc.moveDown(0.3);
      }
    }

    // The sidebar has already listed them down the left.
    if (section === 'skills' && layout !== 'sidebar') {
      if (skillNames.length === 0) continue;
      heading(doc, 'Skills', m, mainX, mainW);
      body(skillNames.join('  ·  '));
    }
  }

  doc.end();
  return done;
}
