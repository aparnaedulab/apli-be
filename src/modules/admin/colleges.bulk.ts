import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';

/**
 * Adding colleges by the list rather than one at a time.
 *
 * A university onboarding its affiliated colleges has a spreadsheet, not an
 * afternoon of form-filling - SPPU alone affiliates several hundred. This is
 * the same shape as the student importer on purpose: paste, partial success,
 * a reason per rejected row.
 */

export interface CollegeRow {
  name: string;
  code: string;
  city?: string;
  state?: string;
  type?: string;
  affiliation?: string;
  address?: string;
  pincode?: string;
  naacGrade?: string;
}

export interface AddCollegesResult {
  created: {
    id: string;
    name: string;
    code: string;
    city: string;
    type: string | null;
    affiliation: string | null;
  }[];
  skipped: { code: string; name: string; reason: string }[];
}

export interface AddCollegesOptions {
  /** Applied to rows with no State column of their own. */
  defaultState?: string;
  /** The institution every college in this import joins. */
  tenantId: string;
}

const YES = new Set(['yes', 'y', 'true', '1', 'affiliated']);
const NO = new Set(['no', 'n', 'false', '0', 'autonomous', 'none', '-', 'na', 'n/a']);

/**
 * The Affiliated column, which is a Yes/No question in the spreadsheet.
 *
 * "Yes" means the importing institution itself - that is the answer for almost
 * every row, which is why it is a tick rather than a name to retype. Anything
 * that is neither Yes nor No is taken literally, so a college affiliated to a
 * different university can still say so.
 */
function resolveAffiliation(raw: string | undefined, home: string): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const key = value.toLowerCase();
  if (YES.has(key)) return home;
  if (NO.has(key)) return null;
  return value;
}

const text = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Codes are identifiers, and identifiers that differ only in case are a bug. */
const normaliseCode = (v: string) => v.trim().toUpperCase();

const CODE_SHAPE = /^[A-Z0-9.-]{2,16}$/;

/**
 * The university a "Yes, affiliated" means: the institution's own name. The
 * deployment-wide HOME_UNIVERSITY is only a fallback for a tenant that cannot
 * be found, which should not happen outside a test.
 */
export async function homeUniversityOf(tenantId: string | null | undefined): Promise<string> {
  if (!tenantId) return env.HOME_UNIVERSITY;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  return tenant?.name ?? env.HOME_UNIVERSITY;
}

export async function addColleges(
  rows: CollegeRow[],
  options: AddCollegesOptions,
): Promise<AddCollegesResult> {
  const result: AddCollegesResult = { created: [], skipped: [] };
  if (rows.length === 0) return result;

  // The type list is small and fixed for the duration of one paste, so it is
  // read once rather than per row.
  const types = await prisma.collegeType.findMany({ where: { isActive: true } });
  // "Yes, affiliated" means affiliated to the institution doing the import.
  const home = await homeUniversityOf(options.tenantId);
  const typeByName = new Map(types.map((t) => [t.name.toLowerCase(), t]));

  // Codes already taken, and codes taken earlier in this same paste. Codes are
  // unique across the platform; names only matter inside the institution,
  // where a repeat is almost certainly the same college typed twice.
  const existing = await prisma.college.findMany({
    select: { code: true, name: true, tenantId: true },
  });
  const takenCodes = new Set(existing.map((c) => c.code));
  const takenNames = new Set(
    existing.filter((c) => c.tenantId === options.tenantId).map((c) => c.name.toLowerCase()),
  );

  for (const row of rows) {
    const name = row.name?.trim() ?? '';
    const code = normaliseCode(row.code ?? '');

    if (name.length < 2 || code.length < 2) {
      result.skipped.push({
        code: code || '—',
        name: name || '—',
        reason: 'Needs a name and a short code, for example "PICT".',
      });
      continue;
    }

    if (!CODE_SHAPE.test(code)) {
      result.skipped.push({
        code,
        name,
        reason: `"${code}" is not a usable code. Letters, numbers, dots and hyphens, up to 16 characters.`,
      });
      continue;
    }

    if (takenCodes.has(code)) {
      result.skipped.push({ code, name, reason: `${code} is already on the portal.` });
      continue;
    }

    // Not enforced by the database - two colleges may legitimately share a
    // name in different cities - but an exact repeat inside one import is
    // almost always the same college typed twice.
    if (takenNames.has(name.toLowerCase())) {
      result.skipped.push({
        code,
        name,
        reason: `A college called "${name}" is already on the portal.`,
      });
      continue;
    }

    const city = text(row.city);
    const state = text(row.state) ?? text(options.defaultState);
    if (!city || !state) {
      result.skipped.push({
        code,
        name,
        reason: 'Needs a city and a state.',
      });
      continue;
    }

    // Types come from the list operations maintains. A row naming one that is
    // not on it is refused rather than quietly imported without a type, which
    // would leave a college nobody can filter for and nobody knows is wrong.
    let collegeTypeId: string | null = null;
    const typeName = text(row.type);
    if (typeName) {
      const match = typeByName.get(typeName.toLowerCase());
      if (!match) {
        result.skipped.push({
          code,
          name,
          reason: `"${typeName}" is not a college type. Add it under Settings first, or leave the column blank.`,
        });
        continue;
      }
      collegeTypeId = match.id;
    }

    const pincode = text(row.pincode);
    if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) {
      result.skipped.push({ code, name, reason: `"${pincode}" is not a six-digit PIN code.` });
      continue;
    }

    const created = await prisma.college.create({
      data: {
        tenantId: options.tenantId,
        name,
        code,
        city,
        state,
        collegeTypeId,
        affiliation: resolveAffiliation(row.affiliation, home),
        address: text(row.address) ?? null,
        pincode: pincode ?? null,
        naacGrade: text(row.naacGrade) ?? null,
      },
      include: { collegeType: { select: { name: true } } },
    });

    takenCodes.add(code);
    takenNames.add(name.toLowerCase());

    result.created.push({
      id: created.id,
      name: created.name,
      code: created.code,
      city: created.city,
      type: created.collegeType?.name ?? null,
      affiliation: created.affiliation,
    });
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Pasting a spreadsheet                                                       */
/* -------------------------------------------------------------------------- */

const HEADERS: Record<keyof CollegeRow, string[]> = {
  name: ['name', 'college', 'collegename', 'institute', 'institutename', 'institution'],
  code: ['code', 'collegecode', 'shortcode', 'shortname', 'abbreviation', 'abbr', 'dtecode'],
  city: ['city', 'town', 'district', 'location'],
  state: ['state'],
  type: ['type', 'collegetype', 'category', 'stream', 'discipline'],
  affiliation: ['affiliated', 'affiliation', 'affiliatedto', 'university'],
  address: ['address', 'addressline', 'street'],
  pincode: ['pincode', 'pin', 'postalcode', 'zip', 'zipcode'],
  naacGrade: ['naac', 'naacgrade', 'grade', 'accreditation'],
};

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function headerMap(cells: string[]): Partial<Record<number, keyof CollegeRow>> | null {
  const map: Partial<Record<number, keyof CollegeRow>> = {};
  let matched = 0;

  cells.forEach((cell, i) => {
    const key = normalise(cell);
    for (const [field, aliases] of Object.entries(HEADERS) as [keyof CollegeRow, string[]][]) {
      if (aliases.includes(key)) {
        map[i] = field;
        matched++;
        return;
      }
    }
  });

  // Both identifying columns have to be named, or this is probably the first
  // college rather than a header.
  const fields = Object.values(map);
  return matched >= 2 && fields.includes('name') && fields.includes('code') ? map : null;
}

const splitCells = (line: string) => line.split(/[\t,;]/).map((c) => c.trim());

/**
 * With a header row, columns can be in any order and any subset. Without one,
 * the fallback is the order the single-college form asks for them in:
 * name, code, city, state, type.
 */
export function parseCollegeRows(input: string): CollegeRow[] {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const map = headerMap(splitCells(lines[0]!));

  if (map) {
    return lines.slice(1).map((line) => {
      const cells = splitCells(line);
      const row: CollegeRow = { name: '', code: '' };
      for (const [index, field] of Object.entries(map)) {
        const value = cells[Number(index)];
        if (value) row[field as keyof CollegeRow] = value;
      }
      return row;
    });
  }

  return lines.map((line) => {
    const [name = '', code = '', city, state, type] = splitCells(line);
    return { name, code, city, state, type };
  });
}
