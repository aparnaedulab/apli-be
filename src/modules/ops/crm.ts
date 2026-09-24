import { EmployerStage, PostingStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/**
 * The employer CRM: a placement cell's relationships with the companies it
 * courts, as a sales team would keep them.
 *
 * Everything here belongs to one college. Every read and write narrows by the
 * caller's collegeId, so an id guessed from another college finds nothing.
 */

export const STAGES: EmployerStage[] = [
  EmployerStage.PROSPECT,
  EmployerStage.CONTACTED,
  EmployerStage.INTERESTED,
  EmployerStage.VISITING,
  EmployerStage.HIRED,
  EmployerStage.DORMANT,
];

export type FollowUpState = 'overdue' | 'today' | 'upcoming';

/**
 * Where a follow-up stands, against the start and end of today.
 *
 * Pure so it can be tested without a clock: "today" means the calendar day
 * of `now`, in the server's time zone, which for an Indian deployment is IST.
 */
export function followUpState(followUpAt: Date | null, doneAt: Date | null, now = new Date()): FollowUpState | null {
  if (!followUpAt || doneAt) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (followUpAt < start) return 'overdue';
  if (followUpAt < end) return 'today';
  return 'upcoming';
}

/**
 * Which years each company came back, read from the college's own drives: a
 * company counts for a year when one of its roles was accepted into a drive
 * of that year. Keyed by company id.
 */
export async function yearsByCompany(collegeId: string): Promise<Map<string, { name: string; years: number[] }>> {
  const postings = await prisma.jobPosting.findMany({
    where: { status: PostingStatus.ACCEPTED, placement: { collegeId } },
    select: {
      placement: { select: { year: true } },
      job: { select: { company: { select: { id: true, name: true } } } },
    },
  });
  const map = new Map<string, { name: string; years: Set<number> }>();
  for (const p of postings) {
    const c = p.job.company;
    const row = map.get(c.id) ?? { name: c.name, years: new Set<number>() };
    row.years.add(p.placement.year);
    map.set(c.id, row);
  }
  return new Map(
    [...map].map(([id, v]) => [id, { name: v.name, years: [...v.years].sort((a, b) => a - b) }]),
  );
}

const RELATION_INCLUDE = {
  contacts: { orderBy: { name: 'asc' } },
  interactions: { orderBy: { happenedAt: 'desc' } },
} satisfies Prisma.EmployerRelationInclude;

/** The whole board: every employer, its history, and what needs doing now. */
export async function board(collegeId: string, now = new Date()) {
  const [relations, years] = await Promise.all([
    prisma.employerRelation.findMany({
      where: { collegeId },
      include: RELATION_INCLUDE,
      orderBy: [{ priority: 'asc' }, { companyName: 'asc' }],
    }),
    yearsByCompany(collegeId),
  ]);

  const followUps: {
    interactionId: string;
    relationId: string;
    companyName: string;
    summary: string;
    followUpAt: Date;
    state: 'overdue' | 'today';
  }[] = [];

  const employers = relations.map((r) => {
    for (const i of r.interactions) {
      const state = followUpState(i.followUpAt, i.followUpDoneAt, now);
      if (state === 'overdue' || state === 'today') {
        followUps.push({
          interactionId: i.id,
          relationId: r.id,
          companyName: r.companyName,
          summary: i.summary,
          followUpAt: i.followUpAt!,
          state,
        });
      }
    }
    const history = r.companyId ? (years.get(r.companyId)?.years ?? []) : [];
    const next = r.interactions
      .filter((i) => i.followUpAt && !i.followUpDoneAt)
      .sort((a, b) => a.followUpAt!.getTime() - b.followUpAt!.getTime())[0];
    return {
      id: r.id,
      companyId: r.companyId,
      companyName: r.companyName,
      stage: r.stage,
      priority: r.priority,
      notes: r.notes,
      contacts: r.contacts,
      interactions: r.interactions.map((i) => ({
        ...i,
        followUpState: followUpState(i.followUpAt, i.followUpDoneAt, now),
      })),
      lastContactAt: r.interactions[0]?.happenedAt ?? null,
      nextFollowUpAt: next?.followUpAt ?? null,
      yearsHired: history,
    };
  });

  followUps.sort((a, b) => a.followUpAt.getTime() - b.followUpAt.getTime());
  return { stages: STAGES, employers, followUps };
}

/**
 * Companies that have already sent roles to this college but are not on the
 * board yet - one click to add, already linked to the company.
 */
export async function suggestions(collegeId: string) {
  const [postings, existing] = await Promise.all([
    prisma.jobPosting.findMany({
      where: { placement: { collegeId } },
      select: { status: true, job: { select: { company: { select: { id: true, name: true } } } } },
    }),
    prisma.employerRelation.findMany({ where: { collegeId }, select: { companyId: true, companyName: true } }),
  ]);
  const onBoardIds = new Set(existing.map((e) => e.companyId).filter(Boolean));
  const onBoardNames = new Set(existing.map((e) => e.companyName.toLowerCase()));

  const byCompany = new Map<string, { companyId: string; name: string; roles: number; accepted: number }>();
  for (const p of postings) {
    const c = p.job.company;
    if (onBoardIds.has(c.id) || onBoardNames.has(c.name.toLowerCase())) continue;
    const row = byCompany.get(c.id) ?? { companyId: c.id, name: c.name, roles: 0, accepted: 0 };
    row.roles++;
    if (p.status === PostingStatus.ACCEPTED) row.accepted++;
    byCompany.set(c.id, row);
  }
  return [...byCompany.values()].sort((a, b) => b.roles - a.roles);
}

export async function ownRelation(collegeId: string, id: string) {
  const r = await prisma.employerRelation.findFirst({ where: { id, collegeId } });
  if (!r) throw notFound('That employer is not on your board.');
  return r;
}

export async function addEmployer(
  collegeId: string,
  input: { companyName?: string; companyId?: string; stage?: EmployerStage; priority?: number; notes?: string },
) {
  let name = input.companyName?.trim() ?? '';
  let companyId: string | null = null;

  // Linking to a company on the platform takes its real name, so the board
  // and the company's own roles can never disagree about who it is.
  if (input.companyId) {
    const company = await prisma.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true } });
    if (!company) throw notFound('That company is not on the platform.');
    companyId = company.id;
    name = company.name;
  }
  if (name.length < 2) throw badRequest('Enter the company name.');

  const clash = await prisma.employerRelation.findFirst({ where: { collegeId, companyName: name } });
  if (clash) throw conflict(`${name} is already on your board.`);

  return prisma.employerRelation.create({
    data: {
      collegeId,
      companyId,
      companyName: name,
      stage: input.stage ?? EmployerStage.PROSPECT,
      priority: input.priority ?? 2,
      notes: input.notes?.trim() || null,
    },
  });
}
