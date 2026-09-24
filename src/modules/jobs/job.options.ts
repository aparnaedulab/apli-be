import { JobOptionKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict } from '../../lib/errors.js';

/**
 * The vocabularies behind the dropdowns on the job form.
 *
 * Each one ships with the choices almost everybody needs, and a company can
 * add its own. Those shipped choices live here in code rather than as seeded
 * rows, for the same reason the platform roles do: they change with releases,
 * they should be the same on every deployment, and nobody should be able to
 * delete "Live interview" out from under the roles that reference it.
 *
 * What a company adds belongs to that company. One recruiter inventing
 * "Machine test" should not put it in front of every other company on the
 * platform, which is why the rows carry a companyId.
 *
 * Employment type is in here too, but it is the awkward one: the form and the
 * server both change behaviour based on it, where the others are only words on
 * a screen. So rather than branching on four names it knows, the code branches
 * on what a type *does* - whether it pays a stipend, whether it converts - and
 * anybody adding one is asked those two questions. That is what makes the list
 * safe to open rather than merely open.
 */

export interface OptionTraits {
  /** Paid monthly for a fixed number of months, so the form asks for both. */
  paysStipend: boolean;
  /** Can turn into a permanent job, so the form asks what it converts to. */
  convertsToPpo: boolean;
}

export interface Option extends OptionTraits {
  value: string;
  label: string;
  /** False for the ones this company added, so the UI can say which. */
  isStandard: boolean;
}

type Shipped = { value: string; label: string } & Partial<OptionTraits>;

const SHIPPED: Record<JobOptionKind, Shipped[]> = {
  EMPLOYMENT_TYPE: [
    { value: 'FULL_TIME', label: 'Full time' },
    { value: 'INTERNSHIP', label: 'Internship', paysStipend: true },
    {
      value: 'INTERNSHIP_PPO',
      label: 'Internship with PPO',
      paysStipend: true,
      convertsToPpo: true,
    },
    { value: 'CONTRACT', label: 'Contract' },
  ],
  WORK_MODE: [
    { value: 'ONSITE', label: 'From the office' },
    { value: 'HYBRID', label: 'Hybrid' },
    { value: 'REMOTE', label: 'Remote' },
  ],
  ROUND_TYPE: [
    { value: 'RESUME_SCREEN', label: 'Resume screen' },
    { value: 'MCQ_TEST', label: 'Online test' },
    { value: 'VIDEO_INTERVIEW', label: 'Recorded interview' },
    { value: 'LIVE_INTERVIEW', label: 'Live interview' },
    { value: 'GROUP_DISCUSSION', label: 'Group discussion' },
    { value: 'ASSIGNMENT', label: 'Assignment' },
    { value: 'WORK_SIMULATION', label: 'Work simulation' },
  ],
  ROUND_MODE: [
    { value: 'ON_CAMPUS', label: 'On campus' },
    { value: 'ONLINE', label: 'Online' },
    { value: 'AT_OFFICE', label: 'At our office' },
  ],
};

export const OPTION_KINDS = Object.keys(SHIPPED) as JobOptionKind[];

/**
 * A stable key for something a person typed.
 *
 * The label can be renamed later; this is what sits on the round or the job,
 * so it has to survive that. Prefixed because a custom "Online test" must not
 * collide with the shipped MCQ_TEST and quietly inherit its meaning.
 */
export function valueFor(label: string): string {
  const slug = label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

  return `CUSTOM_${slug || 'OPTION'}`;
}

/** Everything this company may choose from, shipped first then their own. */
export async function optionsFor(companyId: string): Promise<Record<JobOptionKind, Option[]>> {
  const rows = await prisma.jobOption.findMany({
    where: { isActive: true, OR: [{ companyId }, { companyId: null }] },
    orderBy: { label: 'asc' },
  });

  const out = {} as Record<JobOptionKind, Option[]>;

  for (const kind of OPTION_KINDS) {
    const shipped: Option[] = SHIPPED[kind].map((o) => ({
      value: o.value,
      label: o.label,
      paysStipend: o.paysStipend ?? false,
      convertsToPpo: o.convertsToPpo ?? false,
      isStandard: true,
    }));

    const mine: Option[] = rows
      .filter((r) => r.kind === kind)
      .map((r) => ({
        value: r.value,
        label: r.label,
        paysStipend: r.paysStipend,
        convertsToPpo: r.convertsToPpo,
        isStandard: false,
      }));

    // A company row with a shipped value is a rename, not a second entry.
    const renamed = new Map(mine.map((m) => [m.value, m]));
    out[kind] = [
      ...shipped.map((o) => renamed.get(o.value) ?? o),
      ...mine.filter((m) => !shipped.some((o) => o.value === m.value)),
    ];
  }

  return out;
}

/** Adds one, or hands back the one that already says the same thing. */
export async function addOption(
  companyId: string,
  kind: JobOptionKind,
  label: string,
  traits: Partial<OptionTraits> = {},
): Promise<Option> {
  const clean = label.trim().replace(/\s+/g, ' ');

  // Case-insensitively, because "Machine test" and "machine test" in the same
  // dropdown is a bug that only ever looks like one to the person reading it.
  const existing = (await optionsFor(companyId))[kind].find(
    (o) => o.label.toLowerCase() === clean.toLowerCase(),
  );
  if (existing) {
    throw conflict(`"${existing.label}" is already on that list.`);
  }

  // A pre-placement offer is a promise made at the end of something; a type
  // that converts but is not an internship has nothing to convert from.
  const paysStipend = traits.paysStipend ?? false;
  const convertsToPpo = (traits.convertsToPpo ?? false) && paysStipend;

  const created = await prisma.jobOption.create({
    data: {
      kind,
      value: valueFor(clean),
      label: clean,
      companyId,
      paysStipend: kind === JobOptionKind.EMPLOYMENT_TYPE ? paysStipend : false,
      convertsToPpo: kind === JobOptionKind.EMPLOYMENT_TYPE ? convertsToPpo : false,
    },
  });

  return {
    value: created.value,
    label: created.label,
    paysStipend: created.paysStipend,
    convertsToPpo: created.convertsToPpo,
    isStandard: false,
  };
}

/**
 * What an employment type does, which is what the form and the server both
 * actually care about. An unknown one behaves like a plain job rather than
 * guessing, so nothing is asked for that cannot be honoured.
 */
export async function traitsOf(companyId: string, jobType: string): Promise<OptionTraits> {
  const found = (await optionsFor(companyId)).EMPLOYMENT_TYPE.find((o) => o.value === jobType);

  return {
    paysStipend: found?.paysStipend ?? false,
    convertsToPpo: found?.convertsToPpo ?? false,
  };
}

/**
 * Whether a value may be stored. Unknown values are refused rather than kept,
 * so a typo in a request cannot put a choice on a job that no dropdown offers
 * and nobody can ever select again.
 */
export async function assertKnown(
  companyId: string,
  kind: JobOptionKind,
  value: string | undefined | null,
): Promise<void> {
  if (!value) return;

  const known = (await optionsFor(companyId))[kind].some((o) => o.value === value);
  if (!known) {
    throw conflict(`"${value}" is not one of the choices. Add it to the list first.`);
  }
}

/**
 * Turns stored values back into the words a person chose.
 *
 * A company can rename a choice or invent one, so a college and a student
 * reading the role must be told what it says now - not the stable key the
 * round was saved with, which would show up as CUSTOM_MACHINE_TEST.
 */
export async function labelsFor(
  companyId: string,
): Promise<(kind: JobOptionKind, value: string | null) => string | null> {
  const lists = await optionsFor(companyId);

  return (kind, value) => {
    if (!value) return null;
    return lists[kind].find((o) => o.value === value)?.label ?? value;
  };
}
