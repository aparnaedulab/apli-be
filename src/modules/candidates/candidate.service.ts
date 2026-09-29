import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { ACCOMMODATIONS, PWD_CATEGORIES, cleanKeys } from '../jobs/inclusion.js';
import { LOCKED_NUMBER_KEYS, LOCKED_TEXT_KEYS, fieldFor } from '../students/fields.js';

/**
 * Profile completion, as five weighted sections. The student sees which ones
 * are outstanding rather than a bare percentage - "add one project" is
 * actionable, "you are 60% complete" is not.
 */
export interface CompletionSection {
  key: string;
  label: string;
  weight: number;
  done: boolean;
  hint: string;
}

export function completionFor(profile: {
  phone: string | null;
  graduationYear: number | null;
  resumeUrl: string | null;
  cgpa: number | null;
  tenthPct: number | null;
  twelfthPct: number | null;
  educations: unknown[];
  experiences: unknown[];
  projects: unknown[];
  skills: unknown[];
}): { percent: number; sections: CompletionSection[] } {
  const sections: CompletionSection[] = [
    {
      key: 'basics',
      label: 'Basic details',
      weight: 20,
      done: Boolean(profile.phone && profile.graduationYear),
      hint: 'Add your phone number and graduating year.',
    },
    {
      key: 'academics',
      label: 'Academic record',
      weight: 15,
      done: profile.cgpa !== null && profile.tenthPct !== null && profile.twelfthPct !== null,
      hint: 'Your college enters these from its roster - recruiters filter on them.',
    },
    {
      key: 'education',
      label: 'Education',
      weight: 15,
      done: profile.educations.length > 0,
      hint: 'Add at least one qualification.',
    },
    {
      key: 'skills',
      label: 'Skills',
      weight: 15,
      done: profile.skills.length >= 3,
      hint: 'List at least three skills.',
    },
    {
      key: 'evidence',
      label: 'Experience or projects',
      weight: 20,
      done: profile.experiences.length > 0 || profile.projects.length > 0,
      hint: 'Add one internship or one project.',
    },
    {
      key: 'resume',
      label: 'Resume',
      weight: 20,
      done: Boolean(profile.resumeUrl),
      hint: 'Add a link to your resume.',
    },
  ];

  /*
   * A share of the weight there is, not a sum of the weights earned.
   *
   * The six weights add up to 105, so a finished profile reported 105% - and
   * nobody saw it, because until recently a verified student was locked out
   * of five of the six sections and could never finish one. Dividing by the
   * total means the weights can be re-balanced later without the arithmetic
   * quietly breaking again.
   */
  const total = sections.reduce((sum, s) => sum + s.weight, 0);
  const earned = sections.reduce((sum, s) => sum + (s.done ? s.weight : 0), 0);
  const percent = total === 0 ? 0 : Math.round((earned / total) * 100);

  return { percent, sections };
}

export async function loadProfile(candidateId: string) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      user: { select: { fullName: true, email: true } },
      educations: { orderBy: { startYear: 'desc' } },
      experiences: { orderBy: { startDate: 'desc' } },
      // Project has no createdAt column, so order by what it does have.
      projects: { orderBy: { title: 'asc' } },
      skills: { include: { skill: true } },
      batchMemberships: {
        include: {
          batch: {
            select: {
              id: true,
              name: true,
              course: true,
              graduationYear: true,
              college: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!candidate) throw notFound('Profile not found.');
  return candidate;
}

export type LoadedProfile = Awaited<ReturnType<typeof loadProfile>>;

/**
 * The facts a college vouches for, which a verified student may not move.
 *
 * Derived from the student field registry rather than written out here.
 * These are exactly the fields a role's eligibility reads, because that is
 * what makes them worth verifying - and the list used to be kept by hand, so
 * six of them (the degree, diploma and postgraduate marks, live backlogs and
 * gap years) were added to eligibility over the years and never reached the
 * lock. A verified student could set their live backlogs to zero and walk
 * into every role that asked for none. A test now holds the two together.
 *
 * Everything else on a profile - a phone number, a resume link, a project
 * finished last week - is the student's own account of themselves, and
 * freezing that too was never a stronger guarantee. It only produced a
 * profile nobody could finish.
 */
export const VERIFIED_FIELDS = LOCKED_NUMBER_KEYS;

/**
 * The same, for the ones that are names rather than numbers.
 *
 * Kept apart because they compare differently: case and spacing as the
 * roster happened to have them are not a change anybody made, and neither is
 * filling in a blank - what was never recorded was never verified.
 */
export const VERIFIED_TEXT_FIELDS = LOCKED_TEXT_KEYS;

export type VerifiedField = (typeof VERIFIED_FIELDS)[number];
export type VerifiedTextField = (typeof VERIFIED_TEXT_FIELDS)[number];

/** The batch a student was verified in, or null if nobody has verified them. */
export async function frozenBatchOf(candidateId: string): Promise<string | null> {
  const frozen = await prisma.batchMembership.findFirst({
    where: { candidateId, isFrozen: true },
    include: { batch: { select: { name: true } } },
  });
  return frozen?.batch.name ?? null;
}

/** What each locked field is called when a refusal has to name it. */
function nameThem(keys: readonly string[]): string {
  const labels = keys.map((k) => fieldFor(k).label.toLowerCase());
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Refuses a change to a verified fact, and only to a verified fact.
 *
 * Compared against what is stored rather than refused on sight, because the
 * form posts the whole basics block every time - including the verified
 * values, unchanged. Refusing those would block a student from editing their
 * own phone number, which is the thing this is meant to allow.
 *
 * The refusal names the fields that actually moved, not the whole category:
 * "your live backlogs are locked" is something a student can act on, where
 * "your marks are locked" sends them to their placement cell to ask which.
 */
export async function assertVerifiedUnchanged(
  candidateId: string,
  incoming: Record<string, unknown>,
): Promise<void> {
  const batch = await frozenBatchOf(candidateId);
  if (!batch) return;

  const current = (await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    select: Object.fromEntries(
      [...VERIFIED_FIELDS, ...VERIFIED_TEXT_FIELDS].map((k) => [k, true]),
    ) as Record<string, true>,
  })) as Record<string, unknown>;

  const moved: string[] = [];

  for (const field of VERIFIED_FIELDS) {
    const asked = incoming[field];
    if (asked === undefined) continue;
    const held = current[field];
    // Decimal columns come back as objects, so both sides are compared as
    // the numbers they are.
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    if (num(held) !== num(asked)) moved.push(field);
  }

  for (const field of VERIFIED_TEXT_FIELDS) {
    const asked = incoming[field];
    if (asked === undefined) continue;
    // Case and spacing as the roster happened to have them are not a change
    // anybody made. Nor is filling in a blank: what was never recorded was
    // never verified, and refusing it would leave a student whose college
    // imported no branch unable to state one for the rest of their degree.
    const tidy = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const held = tidy(current[field]);
    if (held !== '' && held !== tidy(asked)) moved.push(field);
  }

  if (moved.length > 0) {
    throw conflict(
      `Your college verified your record for ${batch}, so your ${nameThem(moved)} ${moved.length === 1 ? 'is' : 'are'} locked. Ask your placement cell if something there needs changing.`,
    );
  }
}

/** The most a project shows, and the most a reader will follow. */
export const MAX_PROJECT_LINKS = 6;

export interface ProjectLink {
  url: string;
  /** What it is - "Repository", "Live demo". Optional; the URL stands alone. */
  label?: string;
}

/**
 * A project's links as a list, whatever the column holds.
 *
 * The JSON column can hold anything a past write left there, and a screen
 * mapping over it should not have to wonder. Rubbish is dropped rather than
 * rendered as a broken link, the same as a company's photographs.
 */
export function linksOf(value: unknown): ProjectLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((l): l is ProjectLink => Boolean(l) && typeof (l as ProjectLink).url === 'string')
    .slice(0, MAX_PROJECT_LINKS)
    .map((l) => ({ url: l.url, ...(l.label ? { label: String(l.label) } : {}) }));
}

/** Shapes a candidate row for the API, with completion attached. */
export function serialiseProfile(candidate: LoadedProfile) {
  const skills = candidate.skills.map((cs) => cs.skill.name);
  const membership = candidate.batchMemberships[0];

  const { percent, sections } = completionFor({
    phone: candidate.phone,
    graduationYear: candidate.graduationYear,
    resumeUrl: candidate.resumeUrl,
    cgpa: candidate.cgpa === null ? null : Number(candidate.cgpa),
    tenthPct: candidate.tenthPct === null ? null : Number(candidate.tenthPct),
    twelfthPct: candidate.twelfthPct === null ? null : Number(candidate.twelfthPct),
    educations: candidate.educations,
    experiences: candidate.experiences,
    projects: candidate.projects.map((p) => ({ ...p, links: linksOf(p.links) })),
    skills,
  });

  return {
    id: candidate.id,
    fullName: candidate.user.fullName,
    email: candidate.user.email,
    phone: candidate.phone,
    dateOfBirth: candidate.dateOfBirth,
    gender: candidate.gender,
    graduationYear: candidate.graduationYear,
    headline: candidate.headline,
    about: candidate.about,
    resumeUrl: candidate.resumeUrl,
    // What they chose last time they built one here, so the builder can open
    // where they left it rather than at a blank form.
    resumeBuild: candidate.resumeBuild,
    course: candidate.course,
    specialisation: candidate.specialisation,
    cgpa: candidate.cgpa,
    degreePct: candidate.degreePct,
    tenthPct: candidate.tenthPct,
    twelfthPct: candidate.twelfthPct,
    diplomaPct: candidate.diplomaPct,
    pgCgpa: candidate.pgCgpa,
    pgPct: candidate.pgPct,
    backlogs: candidate.backlogs,
    activeBacklogs: candidate.activeBacklogs,
    gapYears: candidate.gapYears,
    isLateralEntry: candidate.isLateralEntry,
    // The student's side of what a role already states. Keys, not prose, so
    // the two lists can be compared rather than read.
    isPwd: candidate.isPwd,
    pwdCategories: cleanKeys(candidate.pwdCategories, PWD_CATEGORIES),
    pwdPct: candidate.pwdPct,
    accommodations: cleanKeys(candidate.accommodations, ACCOMMODATIONS),
    openToRelocate: candidate.openToRelocate,
    openToNightShift: candidate.openToNightShift,
    openToTravel: candidate.openToTravel,
    educations: candidate.educations,
    experiences: candidate.experiences,
    projects: candidate.projects.map((p) => ({ ...p, links: linksOf(p.links) })),
    skills,
    /*
     * The numbers the college holds them by, which the student could not see.
     *
     * A PRN is the university's own registration number and a roll number the
     * college's; both are typed into the roster by somebody else, both appear
     * on a hall ticket and a result, and a student who has never been shown
     * theirs cannot notice the digit that was mistyped at import. Read-only
     * here for the same reason the verified marks are.
     */
    prn: candidate.prn,
    batch: membership
      ? {
          id: membership.batch.id,
          name: membership.batch.name,
          course: membership.batch.course,
          graduationYear: membership.batch.graduationYear,
          college: membership.batch.college?.name ?? 'University-wide',
          rollNo: membership.rollNo,
          division: membership.division,
          isFrozen: membership.isFrozen,
          verifiedAt: membership.verifiedAt,
        }
      : null,
    completion: { percent, sections },
  };
}

/** Replaces the whole skill list. Skills are shared rows, created on demand. */
/**
 * What a student says they can do, against the list everybody shares.
 *
 * A student may add a skill the portal has never heard of - they know what
 * they learnt better than the catalogue does. What they may not do is add a
 * second spelling of one that already exists: a skill is only useful because
 * a student's "Node.js" and a role's "Node.js" are the same row, and
 * "NodeJS" beside it would be a skill that quietly matches nobody.
 *
 * So an existing skill is reused whatever the casing or spacing, and only a
 * genuinely new name creates a row.
 */
export async function setSkills(candidateId: string, names: string[]): Promise<void> {
  /** Spacing collapsed, the same way operations' own form does it. */
  const tidy = (n: string) => n.trim().replace(/\s+/g, ' ');

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = tidy(raw);
    if (!name || name.length > 60) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(name);
  }

  await prisma.$transaction(async (tx) => {
    await tx.candidateSkill.deleteMany({ where: { candidateId } });
    if (cleaned.length === 0) return;

    const known = await tx.skill.findMany({ select: { id: true, name: true } });
    const byName = new Map(known.map((s) => [s.name.toLowerCase(), s.id]));

    for (const name of cleaned) {
      const existing = byName.get(name.toLowerCase());
      const skillId = existing ?? (await tx.skill.create({ data: { name } })).id;
      byName.set(name.toLowerCase(), skillId);
      await tx.candidateSkill.create({ data: { candidateId, skillId } });
    }
  });
}
