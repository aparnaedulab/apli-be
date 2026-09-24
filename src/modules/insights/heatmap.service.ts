import { PostingStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The skill-demand heatmap (ops.skillHeatmap).
 *
 * Two questions a curriculum committee asks every year, answered from what
 * actually happened on the platform rather than from a survey:
 *
 *   What did recruiters ask for?  Skills on the roles posted into this
 *   college's drives - a role counts once, whether it went to one drive or
 *   three; openings weight it, because "Java, 40 openings" is louder than
 *   "Java, 1 opening".
 *
 *   How many of our students have it?  Of the students in that year's pool,
 *   the share who list the skill on their profile.
 *
 * The gap is where the first is high and the second low. Only counts and
 * percentages leave this file - never a student.
 */

export type HeatmapScope = { kind: 'college'; collegeId: string } | { kind: 'tenant'; tenantId: string };

export interface SkillRow {
  skillId: string;
  skill: string;
  /** Distinct roles asking for it. */
  roles: number;
  required: number;
  niceToHave: number;
  /** Openings on those roles; a role that did not say counts as one. */
  openings: number;
  /** Share of all roles analysed that ask for it, 0-100. */
  demandPct: number;
  /** Students in the pool listing it. */
  students: number;
  /** Share of the pool listing it, 0-100; null when the pool is empty. */
  coveragePct: number | null;
  /** 0-100: high demand with low coverage scores highest. */
  gap: number;
}

export interface BranchColumn {
  key: string;
  course: string | null;
  branch: string | null;
  students: number;
}

export interface SkillHeatmap {
  scope: { kind: 'college' | 'tenant'; name: string };
  year: number | null;
  years: number[];
  rolesAnalysed: number;
  pool: number;
  /** Where the pool came from, so a reader knows what 100% means. */
  poolBasis: 'drive batches' | 'passing year' | 'none';
  skills: SkillRow[];
  /** Skills × branches: coverage per branch for the most asked-for skills. */
  grid: {
    branches: BranchColumn[];
    rows: { skillId: string; skill: string; cells: (number | null)[] }[];
  };
  rising: { skill: string; now: number; before: number; change: number }[];
  perCollege?: { collegeId: string; name: string; students: number; roles: number }[];
  notes: string[];
}

/** How many skills the grid shows - past this it stops being readable. */
const GRID_SKILLS = 15;

const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

function collegeWhere(scope: HeatmapScope): Prisma.CollegeWhereInput {
  return scope.kind === 'college' ? { id: scope.collegeId } : { tenantId: scope.tenantId };
}

/**
 * The gap score. Demand share times the share of students who lack it, on a
 * 0-100 scale: a skill every role asks for and no student has scores 100; one
 * nobody asks for scores 0 however rare it is.
 */
export function gapScore(demandPct: number, coveragePct: number | null): number {
  const coverage = coveragePct ?? 0;
  return Math.round((demandPct / 100) * (1 - coverage / 100) * 100);
}

async function scopeName(scope: HeatmapScope): Promise<string> {
  if (scope.kind === 'college') {
    const c = await prisma.college.findUnique({ where: { id: scope.collegeId }, select: { name: true } });
    return c?.name ?? 'College';
  }
  const t = await prisma.tenant.findUnique({ where: { id: scope.tenantId }, select: { name: true } });
  return t?.name ?? 'Institution';
}

/**
 * Roles posted into the scope's drives of one year, with their skills. A
 * declined posting still says what the company wanted - but the college turned
 * it away, so its students were never going to be asked. Only postings that
 * were accepted or are still waiting count.
 */
async function demandFor(scope: HeatmapScope, year: number) {
  const jobs = await prisma.job.findMany({
    where: {
      postings: {
        some: {
          status: { not: PostingStatus.DECLINED },
          placement: { year, college: collegeWhere(scope) },
        },
      },
    },
    select: {
      id: true,
      openings: true,
      skills: { select: { isRequired: true, skill: { select: { id: true, name: true } } } },
      postings: {
        where: { status: { not: PostingStatus.DECLINED }, placement: { year, college: collegeWhere(scope) } },
        select: { placement: { select: { collegeId: true } } },
      },
    },
  });
  return jobs;
}

/**
 * The students the coverage is measured against. First choice: everyone in
 * a batch attached to that year's drives - the people those roles were
 * offered to. Failing that, students of the scope graduating that year.
 */
async function poolFor(scope: HeatmapScope, year: number) {
  const select = {
    id: true,
    collegeId: true,
    course: true,
    specialisation: true,
    skills: { select: { skillId: true } },
    batchMemberships: { select: { batch: { select: { collegeId: true, course: true, specialisation: true } } }, take: 1 },
  } as const;

  const inDrives = await prisma.candidate.findMany({
    where: {
      batchMemberships: {
        some: { batch: { placements: { some: { year, college: collegeWhere(scope) } } } },
      },
    },
    select,
  });
  if (inDrives.length > 0) return { basis: 'drive batches' as const, students: inDrives };

  const scopeFilter: Prisma.CandidateWhereInput =
    scope.kind === 'college'
      ? {
          OR: [
            { collegeId: scope.collegeId },
            { batchMemberships: { some: { batch: { collegeId: scope.collegeId } } } },
          ],
        }
      : {
          OR: [
            { college: { tenantId: scope.tenantId } },
            { batchMemberships: { some: { batch: { tenantId: scope.tenantId } } } },
          ],
        };

  const byYear = await prisma.candidate.findMany({ where: { ...scopeFilter, graduationYear: year }, select });
  return { basis: byYear.length > 0 ? ('passing year' as const) : ('none' as const), students: byYear };
}

function tallySkills(jobs: Awaited<ReturnType<typeof demandFor>>) {
  const map = new Map<string, { skill: string; roles: number; required: number; niceToHave: number; openings: number }>();
  for (const job of jobs) {
    for (const s of job.skills) {
      const row = map.get(s.skill.id) ?? { skill: s.skill.name, roles: 0, required: 0, niceToHave: 0, openings: 0 };
      row.roles += 1;
      if (s.isRequired) row.required += 1;
      else row.niceToHave += 1;
      row.openings += job.openings && job.openings > 0 ? job.openings : 1;
      map.set(s.skill.id, row);
    }
  }
  return map;
}

export async function skillHeatmap(scope: HeatmapScope, requestedYear?: number): Promise<SkillHeatmap> {
  const drives = await prisma.placement.findMany({
    where: { college: collegeWhere(scope) },
    distinct: ['year'],
    select: { year: true },
  });
  const years = drives.map((d) => d.year).sort((a, b) => b - a);
  const year = requestedYear ?? years[0] ?? null;

  const name = await scopeName(scope);
  const notes = [
    'Demand counts each role once, from roles posted into your seasons that year (declined ones are left out).',
    'Coverage is the share of students who list the skill on their own profile - self-reported, so it can lag behind what they can do.',
    'Only totals and percentages are shown. No student is identified.',
  ];

  if (year === null) {
    return {
      scope: { kind: scope.kind, name },
      year: null,
      years,
      rolesAnalysed: 0,
      pool: 0,
      poolBasis: 'none',
      skills: [],
      grid: { branches: [], rows: [] },
      rising: [],
      ...(scope.kind === 'tenant' ? { perCollege: [] } : {}),
      notes,
    };
  }

  const [jobs, lastYearJobs, pool] = await Promise.all([
    demandFor(scope, year),
    demandFor(scope, year - 1),
    poolFor(scope, year),
  ]);

  const tally = tallySkills(jobs);
  const students = pool.students;

  // Who has which skill, once per student.
  const holders = new Map<string, number>();
  for (const s of students) {
    for (const k of new Set(s.skills.map((x) => x.skillId))) holders.set(k, (holders.get(k) ?? 0) + 1);
  }

  const skills: SkillRow[] = [...tally.entries()].map(([skillId, t]) => {
    const demandPct = pct(t.roles, jobs.length) ?? 0;
    const have = holders.get(skillId) ?? 0;
    const coveragePct = pct(have, students.length);
    return { skillId, ...t, demandPct, students: have, coveragePct, gap: gapScore(demandPct, coveragePct) };
  });
  skills.sort((a, b) => b.gap - a.gap || b.roles - a.roles || a.skill.localeCompare(b.skill));

  // Branch columns: the student's own course and branch, else their batch's.
  const branchOf = (s: (typeof students)[number]) => {
    const b = s.batchMemberships[0]?.batch;
    const course = s.course ?? b?.course ?? null;
    const branch = s.specialisation ?? b?.specialisation ?? null;
    return { key: `${course ?? ''}|${branch ?? ''}`, course, branch };
  };
  const columns = new Map<string, BranchColumn & { members: typeof students }>();
  for (const s of students) {
    const b = branchOf(s);
    const col = columns.get(b.key) ?? { ...b, students: 0, members: [] };
    col.students += 1;
    col.members.push(s);
    columns.set(b.key, col);
  }
  const branchCols = [...columns.values()].sort((a, b) => b.students - a.students);

  const gridSkills = [...skills].sort((a, b) => b.roles - a.roles || a.skill.localeCompare(b.skill)).slice(0, GRID_SKILLS);
  const grid = {
    branches: branchCols.map(({ members: _m, ...c }) => c),
    rows: gridSkills.map((s) => ({
      skillId: s.skillId,
      skill: s.skill,
      cells: branchCols.map((c) => pct(c.members.filter((m) => m.skills.some((x) => x.skillId === s.skillId)).length, c.students)),
    })),
  };

  // Rising: more roles asked for it this year than last.
  const before = tallySkills(lastYearJobs);
  const rising = skills
    .map((s) => ({ skill: s.skill, now: s.roles, before: before.get(s.skillId)?.roles ?? 0 }))
    .map((r) => ({ ...r, change: r.now - r.before }))
    .filter((r) => r.change > 0)
    .sort((a, b) => b.change - a.change || a.skill.localeCompare(b.skill))
    .slice(0, 8);

  let perCollege: SkillHeatmap['perCollege'];
  if (scope.kind === 'tenant') {
    const colleges = await prisma.college.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    perCollege = colleges.map((c) => ({
      collegeId: c.id,
      name: c.name,
      students: students.filter((s) => (s.collegeId ?? s.batchMemberships[0]?.batch.collegeId) === c.id).length,
      roles: jobs.filter((j) => j.postings.some((p) => p.placement.collegeId === c.id)).length,
    }));
  }

  return {
    scope: { kind: scope.kind, name },
    year,
    years,
    rolesAnalysed: jobs.length,
    pool: students.length,
    poolBasis: pool.basis,
    skills,
    grid,
    rising,
    ...(perCollege ? { perCollege } : {}),
    notes,
  };
}
