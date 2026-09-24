import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { ACCOMMODATIONS, PWD_CATEGORIES, cleanKeys } from '../jobs/inclusion.js';

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
 * These are what a recruiter filters on, so "verified" has to mean they are
 * still what the college checked. Everything else on a profile - a phone
 * number, a resume link, a project finished last week - is the student's own
 * account of themselves, and freezing that too was never a stronger
 * guarantee. It only produced a profile nobody could finish: five of the six
 * completion sections are the student's own, so a verified student was capped
 * at fifteen per cent and then asked by every screen to fill in the rest.
 */
export const VERIFIED_FIELDS = ['graduationYear', 'cgpa', 'tenthPct', 'twelfthPct', 'backlogs'] as const;

export type VerifiedField = (typeof VERIFIED_FIELDS)[number];

/** The batch a student was verified in, or null if nobody has verified them. */
export async function frozenBatchOf(candidateId: string): Promise<string | null> {
  const frozen = await prisma.batchMembership.findFirst({
    where: { candidateId, isFrozen: true },
    include: { batch: { select: { name: true } } },
  });
  return frozen?.batch.name ?? null;
}

/**
 * Refuses a change to a verified fact, and only to a verified fact.
 *
 * Compared against what is stored rather than refused on sight, because the
 * form posts the whole basics block every time - including the verified
 * values, unchanged. Refusing those would block a student from editing their
 * own phone number, which is the thing this is meant to allow.
 */
export async function assertVerifiedUnchanged(
  candidateId: string,
  incoming: Partial<Record<VerifiedField, number | null | undefined>>,
): Promise<void> {
  const batch = await frozenBatchOf(candidateId);
  if (!batch) return;

  const current = await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    select: { graduationYear: true, cgpa: true, tenthPct: true, twelfthPct: true, backlogs: true },
  });

  for (const field of VERIFIED_FIELDS) {
    const asked = incoming[field];
    if (asked === undefined) continue;
    const held = current[field];
    // Decimal columns come back as objects, so both sides are compared as
    // the numbers they are.
    const same = (held === null ? null : Number(held)) === (asked === null ? null : Number(asked));
    if (!same) {
      throw conflict(
        `Your college verified your record for ${batch}, so your marks and graduating year are locked. Ask your placement cell if something there needs changing.`,
      );
    }
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
    batch: membership
      ? {
          id: membership.batch.id,
          name: membership.batch.name,
          course: membership.batch.course,
          graduationYear: membership.batch.graduationYear,
          college: membership.batch.college?.name ?? 'University-wide',
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
