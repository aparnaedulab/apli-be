import {
  CampusWeekStatus,
  CompanyStatus,
  MicroApplicationStatus,
  MicroProjectStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { tenantHasModule } from '../tenants/tenant.context.js';
import { companyMayReach, needsApprovalMessage } from '../companyAccess/companyAccess.service.js';

/**
 * Micro-internships and campus weeks.
 *
 * Neither moves money. The product owner has not decided how the platform is
 * paid, so a micro-internship's stipend is paid by the company straight to the
 * student, outside the platform, and all this records is that the company says
 * it paid and the student says it arrived. A campus week has no price at all.
 * Every screen that touches either says so rather than implying a payment
 * system exists.
 */

/* ========================================================================== */
/* Shared                                                                      */
/* ========================================================================== */

/**
 * A company may use either feature only once the platform has verified it:
 * both put a company in front of students, which is exactly what verification
 * is for.
 */
export async function verifiedCompanyOrThrow(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, status: true },
  });
  if (!company) throw notFound('No such company.');
  if (company.status !== CompanyStatus.VERIFIED) {
    throw forbidden('Your company must be verified before it can offer projects or campus weeks.');
  }
  return company;
}

async function notifyCompany(companyId: string, data: { type: string; title: string; body?: string; link: string; payload?: Prisma.InputJsonValue }) {
  const members = await prisma.companyMember.findMany({ where: { companyId }, select: { userId: true } });
  if (members.length === 0) return;
  await prisma.notification.createMany({
    data: members.map((m) => ({
      userId: m.userId,
      type: data.type,
      title: data.title,
      body: data.body ?? null,
      link: data.link,
      payload: data.payload ?? {},
    })),
  });
}

async function notifyStudent(candidateId: string, data: { type: string; title: string; body?: string; link: string; payload?: Prisma.InputJsonValue }) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { userId: true } });
  if (!c) return;
  await prisma.notification.create({
    data: { userId: c.userId, type: data.type, title: data.title, body: data.body ?? null, link: data.link, payload: data.payload ?? {} },
  });
}

/** What a company may see about a student: enough to choose, never how to reach them. */
const STUDENT_BASICS = {
  select: {
    id: true,
    course: true,
    specialisation: true,
    graduationYear: true,
    headline: true,
    user: { select: { fullName: true } },
    college: { select: { name: true, code: true } },
    skills: { select: { skill: { select: { name: true } } } },
    batchMemberships: { select: { isFrozen: true }, take: 5 },
  },
} as const;

type StudentBasicsRow = Prisma.CandidateGetPayload<typeof STUDENT_BASICS>;

function studentBasics(c: StudentBasicsRow) {
  return {
    id: c.id,
    name: c.user.fullName,
    headline: c.headline,
    course: c.course,
    specialisation: c.specialisation,
    graduationYear: c.graduationYear,
    college: c.college ? { name: c.college.name, code: c.college.code } : null,
    skills: c.skills.map((s) => s.skill.name),
    verified: c.batchMemberships.some((m) => m.isFrozen),
  };
}

const asStrings = (v: Prisma.JsonValue): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/* ========================================================================== */
/* Micro-internships                                                           */
/* ========================================================================== */

/** Places already taken: a selection holds its slot through delivery and completion. */
const HOLDS_SLOT: MicroApplicationStatus[] = [
  MicroApplicationStatus.SELECTED,
  MicroApplicationStatus.DELIVERED,
  MicroApplicationStatus.COMPLETED,
];

/** The type of the notification a student leaves when the money arrives. */
export const PAYMENT_CONFIRMED = 'MICRO_PAYMENT_CONFIRMED';

/** Whether the student has confirmed each payment, and when. */
async function paymentConfirmations(applicationIds: string[]): Promise<Map<string, Date>> {
  if (applicationIds.length === 0) return new Map();
  const rows = await prisma.microApplication.findMany({
    where: { id: { in: applicationIds }, paymentConfirmedAt: { not: null } },
    select: { id: true, paymentConfirmedAt: true },
  });
  return new Map(rows.map((r) => [r.id, r.paymentConfirmedAt!]));
}

export interface MicroProjectInput {
  title: string;
  brief: string;
  hours: number;
  stipend: number;
  skills: string[];
  slots: number;
  deadline: Date;
}

function projectView(p: Prisma.MicroProjectGetPayload<{ include: { applications: { select: { status: true } } } }>) {
  const counts: Record<string, number> = {};
  for (const a of p.applications) counts[a.status] = (counts[a.status] ?? 0) + 1;
  const taken = p.applications.filter((a) => HOLDS_SLOT.includes(a.status)).length;
  return {
    id: p.id,
    title: p.title,
    brief: p.brief,
    hours: p.hours,
    stipend: Number(p.stipend),
    skills: asStrings(p.skills),
    slots: p.slots,
    taken,
    deadline: p.deadline,
    status: p.status,
    counts,
    createdAt: p.createdAt,
  };
}

export async function listCompanyProjects(companyId: string) {
  const rows = await prisma.microProject.findMany({
    where: { companyId },
    orderBy: [{ status: 'asc' }, { deadline: 'asc' }],
    include: { applications: { select: { status: true } } },
  });
  return rows.map(projectView);
}

async function ownProject(companyId: string, projectId: string) {
  const p = await prisma.microProject.findFirst({ where: { id: projectId, companyId } });
  if (!p) throw notFound('No such project.');
  return p;
}

export async function createProject(companyId: string, input: MicroProjectInput) {
  const p = await prisma.microProject.create({
    data: { ...input, companyId, stipend: new Prisma.Decimal(input.stipend), status: MicroProjectStatus.DRAFT },
    include: { applications: { select: { status: true } } },
  });
  return projectView(p);
}

export async function updateProject(companyId: string, projectId: string, input: MicroProjectInput) {
  const p = await ownProject(companyId, projectId);
  if (p.status === MicroProjectStatus.COMPLETED || p.status === MicroProjectStatus.CLOSED) {
    throw conflict('This project is closed. Open a new one instead.');
  }
  const taken = await prisma.microApplication.count({ where: { projectId, status: { in: HOLDS_SLOT } } });
  if (input.slots < taken) {
    throw badRequest(`You have already chosen ${taken} student${taken === 1 ? '' : 's'}; keep at least that many places.`);
  }
  const updated = await prisma.microProject.update({
    where: { id: projectId },
    data: { ...input, stipend: new Prisma.Decimal(input.stipend) },
    include: { applications: { select: { status: true } } },
  });
  return projectView(updated);
}

export async function setProjectStatus(companyId: string, projectId: string, status: MicroProjectStatus) {
  const p = await ownProject(companyId, projectId);
  if (status === MicroProjectStatus.DRAFT) throw badRequest('A project cannot go back to draft.');
  if (status === MicroProjectStatus.OPEN) {
    if (p.deadline.getTime() <= Date.now()) throw badRequest('Move the deadline into the future before opening it.');
    if (p.status === MicroProjectStatus.COMPLETED) throw conflict('A completed project cannot reopen.');
  }
  const updated = await prisma.microProject.update({
    where: { id: projectId },
    data: { status },
    include: { applications: { select: { status: true } } },
  });
  return projectView(updated);
}

/** The project with every application, as the company reviews it. */
export async function companyProjectDetail(companyId: string, projectId: string) {
  await ownProject(companyId, projectId);
  const p = await prisma.microProject.findUniqueOrThrow({
    where: { id: projectId },
    include: { applications: { select: { status: true } } },
  });
  const apps = await prisma.microApplication.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: { candidate: STUDENT_BASICS },
  });
  const confirmed = await paymentConfirmations(apps.map((a) => a.id));
  return {
    project: projectView(p),
    applications: apps.map((a) => ({
      id: a.id,
      status: a.status,
      pitch: a.pitch,
      deliverable: a.deliverable,
      rating: a.rating,
      review: a.review,
      paidAt: a.paidAt,
      paymentConfirmedAt: confirmed.get(a.id) ?? null,
      createdAt: a.createdAt,
      student: studentBasics(a.candidate),
    })),
  };
}

async function ownApplication(companyId: string, applicationId: string) {
  const a = await prisma.microApplication.findFirst({
    where: { id: applicationId, project: { companyId } },
    include: { project: { select: { id: true, title: true, slots: true } } },
  });
  if (!a) throw notFound('No such application.');
  return a;
}

export async function decideApplication(companyId: string, applicationId: string, action: 'SELECT' | 'REJECT') {
  const a = await ownApplication(companyId, applicationId);
  if (a.status !== MicroApplicationStatus.APPLIED) {
    throw conflict('Only a new application can be selected or turned down.');
  }

  if (action === 'SELECT') {
    // Counted and written in one transaction so two recruiters clicking at
    // once cannot both take the last place.
    await prisma.$transaction(async (tx) => {
      const taken = await tx.microApplication.count({ where: { projectId: a.projectId, status: { in: HOLDS_SLOT } } });
      if (taken >= a.project.slots) {
        throw conflict(`All ${a.project.slots} place${a.project.slots === 1 ? ' is' : 's are'} filled.`);
      }
      await tx.microApplication.update({ where: { id: a.id }, data: { status: MicroApplicationStatus.SELECTED } });
    });
    await notifyStudent(a.candidateId, {
      type: 'MICRO_SELECTED',
      title: `You were chosen for "${a.project.title}"`,
      body: 'Do the work, then submit what you made from the project page.',
      link: '/student/micro-projects',
      payload: { applicationId: a.id },
    });
  } else {
    await prisma.microApplication.update({ where: { id: a.id }, data: { status: MicroApplicationStatus.REJECTED } });
    await notifyStudent(a.candidateId, {
      type: 'MICRO_REJECTED',
      title: `"${a.project.title}" went to someone else this time`,
      link: '/student/micro-projects',
      payload: { applicationId: a.id },
    });
  }
  return { status: action === 'SELECT' ? MicroApplicationStatus.SELECTED : MicroApplicationStatus.REJECTED };
}

export async function completeApplication(companyId: string, applicationId: string, rating: number, review: string) {
  const a = await ownApplication(companyId, applicationId);
  if (a.status !== MicroApplicationStatus.DELIVERED) {
    throw conflict('Mark it complete once the student has handed in their work.');
  }
  await prisma.microApplication.update({
    where: { id: a.id },
    data: { status: MicroApplicationStatus.COMPLETED, rating, review },
  });
  await notifyStudent(a.candidateId, {
    type: 'MICRO_COMPLETED',
    title: `"${a.project.title}" is complete`,
    body: `Rated ${rating} of 5. It now counts as employer-checked work.`,
    link: '/student/micro-projects',
    payload: { applicationId: a.id },
  });
}

export async function markPaid(companyId: string, applicationId: string) {
  const a = await ownApplication(companyId, applicationId);
  if (a.status !== MicroApplicationStatus.COMPLETED) throw conflict('Record the payment once the work is complete.');
  if (a.paidAt) return;
  await prisma.microApplication.update({ where: { id: a.id }, data: { paidAt: new Date() } });
  await notifyStudent(a.candidateId, {
    type: 'MICRO_PAID',
    title: `The company says it has paid you for "${a.project.title}"`,
    body: 'Confirm on the project page once the money has reached you.',
    link: '/student/micro-projects',
    payload: { applicationId: a.id },
  });
}

/* --- students -------------------------------------------------------------- */

/**
 * Open projects from verified companies.
 *
 * The company check happens at read time, not when the project was opened: a
 * company suspended later stops reaching students at once. MicroProject keeps
 * companyId as a plain column, so verified companies are looked up alongside.
 */
async function openForStudents(): Promise<Prisma.MicroProjectWhereInput> {
  const verified = await prisma.company.findMany({
    where: { status: CompanyStatus.VERIFIED },
    select: { id: true },
  });
  return {
    status: MicroProjectStatus.OPEN,
    deadline: { gt: new Date() },
    companyId: { in: verified.map((c) => c.id) },
  };
}

async function companiesById(ids: string[]) {
  const rows = await prisma.company.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true, logoUrl: true },
  });
  return new Map(rows.map((c) => [c.id, c]));
}

export async function studentProjects(candidateId: string) {
  const [open, mine] = await Promise.all([
    prisma.microProject.findMany({
      where: await openForStudents(),
      orderBy: { deadline: 'asc' },
      include: { applications: { select: { status: true } } },
    }),
    prisma.microApplication.findMany({
      where: { candidateId },
      orderBy: { updatedAt: 'desc' },
      include: { project: { include: { applications: { select: { status: true } } } } },
    }),
  ]);
  const confirmed = await paymentConfirmations(mine.map((a) => a.id));
  const companies = await companiesById([...open.map((p) => p.companyId), ...mine.map((a) => a.project.companyId)]);
  const appliedTo = new Set(mine.map((a) => a.projectId));

  return {
    open: open.map((p) => ({
      ...projectView(p),
      counts: undefined,
      company: companies.get(p.companyId) ?? null,
      applied: appliedTo.has(p.id),
      full: p.applications.filter((a) => HOLDS_SLOT.includes(a.status)).length >= p.slots,
    })),
    mine: mine.map((a) => ({
      id: a.id,
      status: a.status,
      pitch: a.pitch,
      deliverable: a.deliverable,
      rating: a.rating,
      review: a.review,
      paidAt: a.paidAt,
      paymentConfirmedAt: confirmed.get(a.id) ?? null,
      createdAt: a.createdAt,
      project: { ...projectView(a.project), counts: undefined, company: companies.get(a.project.companyId) ?? null },
    })),
  };
}

export async function applyToProject(candidateId: string, projectId: string, pitch: string) {
  const project = await prisma.microProject.findFirst({ where: { id: projectId, ...(await openForStudents()) } });
  if (!project) throw notFound('This project is not open for applications.');

  const existing = await prisma.microApplication.findUnique({
    where: { projectId_candidateId: { projectId, candidateId } },
  });
  if (existing && existing.status !== MicroApplicationStatus.WITHDRAWN) {
    throw conflict('You have already applied.');
  }
  const app = existing
    ? await prisma.microApplication.update({
        where: { id: existing.id },
        data: { pitch, status: MicroApplicationStatus.APPLIED },
      })
    : await prisma.microApplication.create({ data: { projectId, candidateId, pitch } });

  await notifyCompany(project.companyId, {
    type: 'MICRO_APPLIED',
    title: `New application for "${project.title}"`,
    link: '/company/micro-projects',
    payload: { projectId, applicationId: app.id },
  });
  return app;
}

async function myApplication(candidateId: string, applicationId: string) {
  const a = await prisma.microApplication.findFirst({
    where: { id: applicationId, candidateId },
    include: { project: { select: { id: true, title: true, companyId: true } } },
  });
  if (!a) throw notFound('No such application.');
  return a;
}

export async function withdrawApplication(candidateId: string, applicationId: string) {
  const a = await myApplication(candidateId, applicationId);
  if (a.status !== MicroApplicationStatus.APPLIED && a.status !== MicroApplicationStatus.SELECTED) {
    throw conflict('This application can no longer be withdrawn.');
  }
  await prisma.microApplication.update({ where: { id: a.id }, data: { status: MicroApplicationStatus.WITHDRAWN } });
}

export async function deliver(candidateId: string, applicationId: string, deliverable: string) {
  const a = await myApplication(candidateId, applicationId);
  // Only the students the company chose can hand in work - otherwise anyone
  // could turn up with a deliverable and claim the project.
  if (a.status !== MicroApplicationStatus.SELECTED && a.status !== MicroApplicationStatus.DELIVERED) {
    throw forbidden('Only a student chosen for this project can hand in work.');
  }
  await prisma.microApplication.update({
    where: { id: a.id },
    data: { deliverable, status: MicroApplicationStatus.DELIVERED },
  });
  await notifyCompany(a.project.companyId, {
    type: 'MICRO_DELIVERED',
    title: `Work handed in for "${a.project.title}"`,
    link: '/company/micro-projects',
    payload: { projectId: a.project.id, applicationId: a.id },
  });
}

export async function confirmPayment(candidateId: string, applicationId: string) {
  const a = await myApplication(candidateId, applicationId);
  if (!a.paidAt) throw conflict('The company has not recorded a payment yet.');
  const already = await paymentConfirmations([a.id]);
  if (already.has(a.id)) return;
  await prisma.microApplication.update({ where: { id: a.id }, data: { paymentConfirmedAt: new Date() } });
  await notifyCompany(a.project.companyId, {
    type: PAYMENT_CONFIRMED,
    title: `Payment received for "${a.project.title}"`,
    body: 'The student confirmed the stipend reached them.',
    link: '/company/micro-projects',
    payload: { applicationId: a.id },
  });
}

/**
 * Completed micro-internships, as proof of work.
 *
 * The skills passport (a separate module) can read this to label these as
 * employer-verified: a company chose the student, received the work and rated
 * it.
 */
export async function completedMicroInternships(candidateId: string) {
  const rows = await prisma.microApplication.findMany({
    where: { candidateId, status: MicroApplicationStatus.COMPLETED },
    orderBy: { updatedAt: 'desc' },
    include: { project: true },
  });
  const companies = await companiesById(rows.map((a) => a.project.companyId));
  return rows.map((a) => ({
    applicationId: a.id,
    title: a.project.title,
    company: companies.get(a.project.companyId) ?? null,
    hours: a.project.hours,
    skills: asStrings(a.project.skills),
    rating: a.rating,
    review: a.review,
    completedAt: a.updatedAt,
  }));
}

/* ========================================================================== */
/* Campus weeks                                                                */
/* ========================================================================== */

/**
 * What a session can be.
 *
 * The first four are a company's week. PREP and WORKSHOP are what a placement
 * cell runs on its own - the aptitude session before a drive, the resume
 * clinic - and they are in the same list because they are the same thing to a
 * student: somewhere to be, at a time, that they can put their name down for.
 */
export const EVENT_KINDS = ['TALK', 'CHALLENGE', 'ALUMNI', 'INTERVIEWS', 'PREP', 'WORKSHOP'] as const;

/** How a student came to be on a session's list. Only GOING is registered. */
export const ATTENDEE_STATUS = ['INVITED', 'GOING', 'DECLINED'] as const;
export type AttendeeStatus = (typeof ATTENDEE_STATUS)[number];

export interface WeekEventInput {
  kind: (typeof EVENT_KINDS)[number];
  title: string;
  startsAt: Date;
  durationMin: number;
  where?: string;
  simulationId?: string;
  /** The role this session is about, where it is about one. */
  jobId?: string;
}

export interface WeekInput {
  collegeId: string;
  title: string;
  message?: string;
  startDate: Date;
  endDate: Date;
  events: WeekEventInput[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * The checks every event passes, whoever is creating it.
 *
 * `companyId` null is the college running its own: there is no simulation to
 * own and no access gate to clear, because the college is not reaching into
 * somebody else's institution. Everything else - the dates, the sessions
 * falling inside them, the institution having the module - is the same for
 * both, so it is written once.
 */
async function validateWeek(companyId: string | null, input: WeekInput) {
  const single = companyId === null;
  if (input.endDate.getTime() < input.startDate.getTime()) throw badRequest('It must end after it starts.');
  if (input.endDate.getTime() - input.startDate.getTime() > 14 * DAY) {
    throw badRequest('Keep it to two weeks at most.');
  }
  if (startOfDay(input.startDate).getTime() < startOfDay(new Date()).getTime()) {
    throw badRequest('Choose dates from today onwards.');
  }
  if (input.events.length === 0) throw badRequest('Add at least one session.');
  const from = startOfDay(input.startDate).getTime();
  const to = startOfDay(input.endDate).getTime() + DAY;
  for (const e of input.events) {
    const t = e.startsAt.getTime();
    if (t < from || t >= to) throw badRequest(`"${e.title}" falls outside the dates you set.`);
  }

  const simIds = input.events.map((e) => e.simulationId).filter(Boolean) as string[];
  if (simIds.length > 0) {
    if (single) throw badRequest('Only a company can attach one of its simulations.');
    const sims = await prisma.simulation.count({
      where: { id: { in: simIds }, companyId, status: 'PUBLISHED' },
    });
    if (sims !== new Set(simIds).size) throw badRequest('A challenge can only link one of your published simulations.');
  }

  const college = await prisma.college.findUnique({
    where: { id: input.collegeId },
    select: { id: true, name: true, tenantId: true },
  });
  if (!college) throw notFound('No such college.');
  if (!(await tenantHasModule(college.tenantId, 'showcase.campusWeeks'))) {
    throw badRequest(`${college.name} does not host campus events on the platform.`);
  }

  // A session may name a role, and only a role this creator is entitled to
  // name: the college's own postings, or the company's own jobs.
  const jobIds = [...new Set(input.events.map((e) => e.jobId).filter(Boolean) as string[])];
  if (jobIds.length > 0) {
    const ok = await prisma.job.count({
      where: {
        id: { in: jobIds },
        ...(single
          ? { postings: { some: { placement: { collegeId: college.id }, status: 'ACCEPTED' } } }
          : { companyId: companyId! }),
      },
    });
    if (ok !== jobIds.length) throw badRequest('A session can only be about a role you can see.');
  }

  if (!single && !(await companyMayReach(companyId!, college.tenantId))) {
    const tenant = await prisma.tenant.findUnique({ where: { id: college.tenantId! }, select: { name: true, shortName: true } });
    throw conflict(needsApprovalMessage([tenant?.shortName || tenant?.name || college.name]));
  }
  return college;
}

/** Colleges a company may propose a week to: those whose institution offers campus weeks. */
export async function collegesOffering() {
  const tenants = await prisma.tenantModule.findMany({
    where: { moduleKey: 'showcase.campusWeeks', enabled: true, tenant: { status: 'ACTIVE' } },
    select: { tenantId: true },
  });
  if (tenants.length === 0) return [];
  return prisma.college.findMany({
    where: { tenantId: { in: tenants.map((t) => t.tenantId) } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, code: true, city: true },
  });
}

const WEEK_INCLUDE = {
  events: {
    orderBy: { startsAt: 'asc' },
    include: {
      registrations: {
        select: { candidateId: true, attended: true, status: true, invitedAt: true },
      },
    },
  },
} as const;

type WeekRow = Prisma.CampusWeekGetPayload<{ include: typeof WEEK_INCLUDE }>;
type RegRow = WeekRow['events'][number]['registrations'][number];

/** Going, and only going. An invitation nobody answered is not a head count. */
const going = (rs: RegRow[]) => rs.filter((r) => r.status === 'GOING');
const invited = (rs: RegRow[]) => rs.filter((r) => r.status === 'INVITED');

/**
 * A week with counts only - who registered and who came, never who they are.
 * The company learns how its week landed without receiving a list of
 * students it could contact outside the platform.
 */
function weekForCompany(w: WeekRow, collegeName: string) {
  return {
    id: w.id,
    title: w.title,
    message: w.message,
    startDate: w.startDate,
    endDate: w.endDate,
    status: w.status,
    decisionNote: w.decisionNote,
    college: { id: w.collegeId, name: collegeName },
    events: w.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      startsAt: e.startsAt,
      durationMin: e.durationMin,
      where: e.where,
      simulationId: e.simulationId,
      jobId: e.jobId,
      registered: going(e.registrations).length,
      invited: invited(e.registrations).length,
      attended: e.registrations.filter((r) => r.attended).length,
    })),
  };
}

async function collegeNames(ids: string[]) {
  const rows = await prisma.college.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function companyWeeks(companyId: string) {
  const weeks = await prisma.campusWeek.findMany({
    where: { companyId },
    orderBy: { startDate: 'desc' },
    include: WEEK_INCLUDE,
  });
  const names = await collegeNames([...new Set(weeks.map((w) => w.collegeId))]);
  return weeks.map((w) => weekForCompany(w, names.get(w.collegeId) ?? 'A college'));
}

export async function proposeWeek(companyId: string, companyName: string, input: WeekInput) {
  const college = await validateWeek(companyId, input);
  const week = await prisma.campusWeek.create({
    data: {
      companyId,
      collegeId: college.id,
      title: input.title,
      message: input.message ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      events: {
        create: input.events.map((e) => ({
          kind: e.kind,
          title: e.title,
          startsAt: e.startsAt,
          durationMin: e.durationMin,
          where: e.where ?? null,
          simulationId: e.simulationId ?? null,
          jobId: e.jobId ?? null,
        })),
      },
    },
    include: WEEK_INCLUDE,
  });

  // The placement cell hears about it where it already looks.
  const staff = await prisma.campusMember.findMany({ where: { collegeId: college.id }, select: { userId: true } });
  if (staff.length > 0) {
    await prisma.notification.createMany({
      data: staff.map((s) => ({
        userId: s.userId,
        type: 'CAMPUS_WEEK_PROPOSED',
        title: `${companyName} proposed a campus week`,
        body: input.title,
        link: '/campus/events',
        payload: { weekId: week.id },
      })),
    });
  }
  return weekForCompany(week, college.name);
}

export async function updateProposedWeek(companyId: string, weekId: string, input: WeekInput) {
  const week = await prisma.campusWeek.findFirst({ where: { id: weekId, companyId } });
  if (!week) throw notFound('No such campus week.');
  if (week.status !== CampusWeekStatus.PROPOSED) throw conflict('Only a week still waiting for the college can be changed.');
  if (input.collegeId !== week.collegeId) throw badRequest('Propose a new week to change the college.');
  const college = await validateWeek(companyId, input);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.campusWeekEvent.deleteMany({ where: { weekId } });
    return tx.campusWeek.update({
      where: { id: weekId },
      data: {
        title: input.title,
        message: input.message ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        events: {
          create: input.events.map((e) => ({
            kind: e.kind,
            title: e.title,
            startsAt: e.startsAt,
            durationMin: e.durationMin,
            where: e.where ?? null,
            simulationId: e.simulationId ?? null,
            jobId: e.jobId ?? null,
          })),
        },
      },
      include: WEEK_INCLUDE,
    });
  });
  return weekForCompany(updated, college.name);
}

/**
 * The company's own roles, for naming what a session is about and for
 * inviting the people who applied to one.
 */
export async function companyJobsForEvents(companyId: string) {
  return prisma.job.findMany({
    where: { companyId, status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
    select: { id: true, title: true },
    take: 100,
  });
}

/** A week the company owns, for a route that needs the college it is at. */
export async function companyWeekCollege(companyId: string, weekId: string) {
  const w = await prisma.campusWeek.findFirst({ where: { id: weekId, companyId }, select: { id: true, collegeId: true } });
  if (!w) throw notFound('No such campus week.');
  return w;
}

export async function withdrawProposedWeek(companyId: string, weekId: string) {
  const week = await prisma.campusWeek.findFirst({ where: { id: weekId, companyId } });
  if (!week) throw notFound('No such campus week.');
  if (week.status !== CampusWeekStatus.PROPOSED) throw conflict('Only a week still waiting for the college can be withdrawn.');
  await prisma.campusWeek.delete({ where: { id: weekId } });
}

/* --- the college ------------------------------------------------------------ */

async function collegeWeek(collegeId: string, weekId: string) {
  const w = await prisma.campusWeek.findFirst({ where: { id: weekId, collegeId }, include: WEEK_INCLUDE });
  if (!w) throw notFound('No such campus week.');
  return w;
}

/** The college's view: its own students are its own, so it sees who registered. */
export async function weeksForCollege(collegeId: string) {
  const weeks = await prisma.campusWeek.findMany({
    where: { collegeId },
    orderBy: [{ status: 'asc' }, { startDate: 'asc' }],
    include: WEEK_INCLUDE,
  });
  const companyIds = [...new Set(weeks.map((w) => w.companyId).filter((id): id is string => id !== null))];
  const companies = await prisma.company.findMany({
    where: { id: { in: companyIds } },
    select: { id: true, name: true, status: true },
  });
  const byId = new Map(companies.map((c) => [c.id, c]));
  const candidateIds = [...new Set(weeks.flatMap((w) => w.events.flatMap((e) => e.registrations.map((r) => r.candidateId))))];
  const students = await prisma.candidate.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, course: true, specialisation: true, user: { select: { fullName: true } } },
  });
  const who = new Map(students.map((s) => [s.id, s]));

  return weeks.map((w) => {
    const c = w.companyId ? byId.get(w.companyId) : undefined;
    return {
      id: w.id,
      title: w.title,
      message: w.message,
      startDate: w.startDate,
      endDate: w.endDate,
      status: w.status,
      decisionNote: w.decisionNote,
      /** Null when the placement cell is running it itself. */
      company: c ? { id: c.id, name: c.name, verified: c.status === CompanyStatus.VERIFIED } : null,
      mine: w.companyId === null,
      events: w.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        startsAt: e.startsAt,
        durationMin: e.durationMin,
        where: e.where,
        jobId: e.jobId,
        registered: going(e.registrations).length,
        invited: invited(e.registrations).length,
        attended: e.registrations.filter((r) => r.attended).length,
        people: e.registrations.map((r) => ({
          candidateId: r.candidateId,
          name: who.get(r.candidateId)?.user.fullName ?? 'A student',
          course: [who.get(r.candidateId)?.course, who.get(r.candidateId)?.specialisation].filter(Boolean).join(' '),
          status: r.status,
          invited: r.invitedAt !== null,
          attended: r.attended,
        })),
      })),
    };
  });
}

/* --- the college's own events ---------------------------------------------- */

/**
 * An event the placement cell runs itself.
 *
 * There is nobody to approve it, so it is APPROVED the moment it is saved and
 * the students are told. The same row as a company's week, with `companyId`
 * null: one set of sessions, one registration table, one student screen.
 */
export async function createCollegeEvent(collegeId: string, input: WeekInput) {
  if (input.collegeId !== collegeId) throw forbidden('You can only run events at your own college.');
  const college = await validateWeek(null, input);

  const week = await prisma.campusWeek.create({
    data: {
      companyId: null,
      collegeId: college.id,
      title: input.title,
      message: input.message ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      status: CampusWeekStatus.APPROVED,
      events: {
        create: input.events.map((e) => ({
          kind: e.kind,
          title: e.title,
          startsAt: e.startsAt,
          durationMin: e.durationMin,
          where: e.where ?? null,
          jobId: e.jobId ?? null,
        })),
      },
    },
    include: WEEK_INCLUDE,
  });

  // Announced to the college's students, because an event nobody hears about
  // is an empty room. Invitations narrow it afterwards; this is the notice.
  const students = await prisma.candidate.findMany({ where: { collegeId }, select: { userId: true } });
  if (students.length > 0) {
    await prisma.notification.createMany({
      data: students.map((s) => ({
        userId: s.userId,
        type: 'CAMPUS_EVENT_ANNOUNCED',
        title: `Your placement cell has put on "${input.title}"`,
        body: 'Open events to put your name down.',
        link: '/student/events',
        payload: { weekId: week.id },
      })),
    });
  }
  return week.id;
}

export async function updateCollegeEvent(collegeId: string, weekId: string, input: WeekInput) {
  const existing = await collegeWeek(collegeId, weekId);
  if (existing.companyId !== null) throw forbidden('A company owns this one - you can move a session, not rewrite it.');
  if (existing.status === CampusWeekStatus.DONE) throw conflict('This event is closed.');
  await validateWeek(null, { ...input, collegeId });

  /*
   * Sessions are replaced, so anybody who had put their name down for one
   * would lose their place. Keeping registrations is the whole point of the
   * screen, so a session that is still recognisably the same one - same kind
   * and title - keeps its row and its list.
   */
  await prisma.$transaction(async (tx) => {
    const keep = new Map(existing.events.map((e) => [`${e.kind}|${e.title}`, e.id]));
    const seen = new Set<string>();
    for (const e of input.events) {
      const key = `${e.kind}|${e.title}`;
      const id = keep.get(key);
      seen.add(key);
      const data = {
        kind: e.kind,
        title: e.title,
        startsAt: e.startsAt,
        durationMin: e.durationMin,
        where: e.where ?? null,
        jobId: e.jobId ?? null,
      };
      if (id) await tx.campusWeekEvent.update({ where: { id }, data });
      else await tx.campusWeekEvent.create({ data: { ...data, weekId } });
    }
    const gone = existing.events.filter((e) => !seen.has(`${e.kind}|${e.title}`)).map((e) => e.id);
    if (gone.length > 0) await tx.campusWeekEvent.deleteMany({ where: { id: { in: gone } } });

    await tx.campusWeek.update({
      where: { id: weekId },
      data: {
        title: input.title,
        message: input.message ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
      },
    });
  });
}

export async function deleteCollegeEvent(collegeId: string, weekId: string) {
  const existing = await collegeWeek(collegeId, weekId);
  if (existing.companyId !== null) throw forbidden('Decline a company’s week rather than deleting it.');
  await prisma.campusWeek.delete({ where: { id: weekId } });
}

export async function decideWeek(collegeId: string, weekId: string, status: 'APPROVED' | 'DECLINED', note: string | undefined) {
  const w = await collegeWeek(collegeId, weekId);
  if (w.companyId === null) throw conflict('This is your own event - there is nothing to decide.');
  if (w.status !== CampusWeekStatus.PROPOSED) throw conflict('This week has already been decided.');
  if (status === 'DECLINED' && !note) throw badRequest('Say why - the company is shown this.');

  await prisma.campusWeek.update({
    where: { id: weekId },
    data: { status, decisionNote: note ?? null },
  });

  const company = await prisma.company.findUnique({ where: { id: w.companyId }, select: { name: true } });
  await notifyCompany(w.companyId, {
    type: 'CAMPUS_WEEK_DECISION',
    title: status === 'APPROVED' ? `Your campus week "${w.title}" is on` : `Your campus week "${w.title}" was declined`,
    body: note,
    link: '/company/campus-weeks',
    payload: { weekId },
  });

  // Announced to the college's students the moment it is approved - that is
  // what the week is for.
  if (status === 'APPROVED') {
    const students = await prisma.candidate.findMany({ where: { collegeId }, select: { userId: true } });
    if (students.length > 0) {
      await prisma.notification.createMany({
        data: students.map((s) => ({
          userId: s.userId,
          type: 'CAMPUS_WEEK_ANNOUNCED',
          title: `${company?.name ?? 'A company'} is coming to campus`,
          body: `${w.title} - register for the sessions you want to attend.`,
          link: '/student/events',
          payload: { weekId },
        })),
      });
    }
  }
}

export async function adjustEvent(
  collegeId: string,
  weekId: string,
  eventId: string,
  input: { startsAt?: Date; durationMin?: number; where?: string },
) {
  const w = await collegeWeek(collegeId, weekId);
  if (w.status === CampusWeekStatus.DECLINED || w.status === CampusWeekStatus.DONE) {
    throw conflict('This week can no longer be changed.');
  }
  const event = w.events.find((e) => e.id === eventId);
  if (!event) throw notFound('No such session.');
  if (input.startsAt) {
    const from = startOfDay(w.startDate).getTime();
    const to = startOfDay(w.endDate).getTime() + DAY;
    if (input.startsAt.getTime() < from || input.startsAt.getTime() >= to) {
      throw badRequest('Keep the session inside the week’s dates.');
    }
  }
  await prisma.campusWeekEvent.update({
    where: { id: eventId },
    data: {
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      ...(input.durationMin ? { durationMin: input.durationMin } : {}),
      ...(input.where !== undefined ? { where: input.where || null } : {}),
    },
  });
}

export async function markAttendance(collegeId: string, weekId: string, eventId: string, candidateId: string, attended: boolean) {
  const w = await collegeWeek(collegeId, weekId);
  if (w.status !== CampusWeekStatus.APPROVED && w.status !== CampusWeekStatus.DONE) {
    throw conflict('Attendance is taken once the week is approved.');
  }
  if (!w.events.some((e) => e.id === eventId)) throw notFound('No such session.');
  const reg = await prisma.campusWeekRegistration.findUnique({ where: { eventId_candidateId: { eventId, candidateId } } });
  if (!reg) throw notFound('That student is not on this session’s list.');
  await prisma.campusWeekRegistration.update({
    where: { eventId_candidateId: { eventId, candidateId } },
    // Somebody who turned up was going, whatever they had said beforehand.
    data: { attended, ...(attended ? { status: 'GOING' } : {}) },
  });
}

/* --- invitations ----------------------------------------------------------- */

/**
 * Who the creator is asking to come.
 *
 * Self-enrolment is the default and stays open; this is for the session that
 * is *for* somebody in particular - the prep session for everyone shortlisted
 * on Thursday's drive, the workshop for one batch.
 *
 * A college may invite its own students, by name, by batch or by who applied
 * to a role it hosts. A company may invite only the people who applied to one
 * of its own jobs: it already sees those applicants, and it still never
 * learns anything about anybody else. Inviting the same student twice is the
 * same as inviting them once, and somebody who already said yes is left
 * alone.
 */
export interface InviteScope {
  candidateIds?: string[];
  batchId?: string;
  jobId?: string;
}

async function candidatesFor(collegeId: string, scope: InviteScope, companyId: string | null): Promise<string[]> {
  const ids = new Set<string>();

  if (scope.candidateIds?.length) {
    if (companyId) throw forbidden('Invite by role - a company does not choose students by name here.');
    const rows = await prisma.candidate.findMany({
      where: { id: { in: scope.candidateIds }, collegeId },
      select: { id: true },
    });
    for (const r of rows) ids.add(r.id);
  }

  if (scope.batchId) {
    if (companyId) throw forbidden('Invite by role - a batch is the college’s to invite.');
    const rows = await prisma.batchMembership.findMany({
      where: { batchId: scope.batchId, candidate: { collegeId } },
      select: { candidateId: true },
    });
    for (const r of rows) ids.add(r.candidateId);
  }

  if (scope.jobId) {
    const rows = await prisma.application.findMany({
      where: {
        jobId: scope.jobId,
        candidate: { collegeId },
        ...(companyId ? { job: { companyId } } : {}),
      },
      select: { candidateId: true },
    });
    for (const r of rows) ids.add(r.candidateId);
  }

  return [...ids];
}

/**
 * Invite students to one session.
 *
 * Returns how many were newly asked, so the screen can say "28 invited"
 * rather than leaving somebody to guess whether it worked.
 */
export async function inviteToEvent(
  collegeId: string,
  weekId: string,
  eventId: string,
  scope: InviteScope,
  by: { companyId: string | null; label: string },
) {
  const w = await collegeWeek(collegeId, weekId);
  if (by.companyId !== null && w.companyId !== by.companyId) throw notFound('No such event.');
  if (w.status !== CampusWeekStatus.APPROVED) throw conflict('Invite once the event is on.');
  const event = w.events.find((e) => e.id === eventId);
  if (!event) throw notFound('No such session.');
  if (event.startsAt.getTime() <= Date.now()) throw conflict('This session has already started.');

  const candidateIds = await candidatesFor(collegeId, scope, by.companyId);
  if (candidateIds.length === 0) return { invited: 0, already: 0 };

  const existing = await prisma.campusWeekRegistration.findMany({
    where: { eventId, candidateId: { in: candidateIds } },
    select: { candidateId: true },
  });
  const had = new Set(existing.map((r) => r.candidateId));
  const fresh = candidateIds.filter((id) => !had.has(id));

  if (fresh.length > 0) {
    await prisma.campusWeekRegistration.createMany({
      data: fresh.map((candidateId) => ({
        eventId,
        candidateId,
        status: 'INVITED',
        invitedAt: new Date(),
      })),
    });
    const students = await prisma.candidate.findMany({
      where: { id: { in: fresh } },
      select: { userId: true },
    });
    await prisma.notification.createMany({
      data: students.map((s) => ({
        userId: s.userId,
        type: 'CAMPUS_EVENT_INVITE',
        title: `${by.label} invited you to "${event.title}"`,
        body: 'Say whether you are coming.',
        link: '/student/events',
        payload: { weekId, eventId },
      })),
    });
  }

  return { invited: fresh.length, already: had.size };
}

export async function finishWeek(collegeId: string, weekId: string) {
  const w = await collegeWeek(collegeId, weekId);
  if (w.status !== CampusWeekStatus.APPROVED) throw conflict('Only an approved week can be closed.');
  await prisma.campusWeek.update({ where: { id: weekId }, data: { status: CampusWeekStatus.DONE } });
}

/* --- students ------------------------------------------------------------ */

export async function weeksForStudent(candidateId: string) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { collegeId: true } });
  if (!c?.collegeId) return [];
  const weeks = await prisma.campusWeek.findMany({
    where: {
      collegeId: c.collegeId,
      status: { in: [CampusWeekStatus.APPROVED, CampusWeekStatus.DONE] },
      endDate: { gte: new Date(Date.now() - 30 * DAY) },
    },
    orderBy: { startDate: 'asc' },
    include: WEEK_INCLUDE,
  });
  const companies = await prisma.company.findMany({
    where: { id: { in: [...new Set(weeks.map((w) => w.companyId).filter((id): id is string => id !== null))] } },
    select: { id: true, name: true, logoUrl: true },
  });
  const byId = new Map(companies.map((x) => [x.id, x]));

  // The roles any session is about, so a student can see which drive the prep
  // belongs to without opening anything.
  const jobIds = [...new Set(weeks.flatMap((w) => w.events.map((e) => e.jobId).filter((id): id is string => id !== null)))];
  const jobs = jobIds.length
    ? await prisma.job.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, title: true, company: { select: { name: true } } },
      })
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, { id: j.id, title: j.title, company: j.company.name }]));

  return weeks.map((w) => ({
    id: w.id,
    title: w.title,
    message: w.message,
    startDate: w.startDate,
    endDate: w.endDate,
    status: w.status,
    /** Null when the student's own placement cell is running it. */
    company: w.companyId ? (byId.get(w.companyId) ?? null) : null,
    events: w.events.map((e) => {
      const mine = e.registrations.find((r) => r.candidateId === candidateId);
      return {
        id: e.id,
        kind: e.kind,
        title: e.title,
        startsAt: e.startsAt,
        durationMin: e.durationMin,
        where: e.where,
        job: e.jobId ? (jobById.get(e.jobId) ?? null) : null,
        registered: going(e.registrations).length,
        /** GOING, INVITED, DECLINED - or null where they are not on the list. */
        myStatus: (mine?.status as AttendeeStatus | undefined) ?? null,
        mine: mine?.status === 'GOING',
        invited: mine?.invitedAt != null,
        attended: mine?.attended ?? false,
        started: e.startsAt.getTime() <= Date.now(),
      };
    }),
  }));
}

async function openEventForStudent(candidateId: string, eventId: string) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { collegeId: true } });
  const event = await prisma.campusWeekEvent.findUnique({ where: { id: eventId }, include: { week: true } });
  // Another college's week answers exactly like one that does not exist.
  if (!event || !c?.collegeId || event.week.collegeId !== c.collegeId || event.week.status !== CampusWeekStatus.APPROVED) {
    throw notFound('No such session.');
  }
  if (event.startsAt.getTime() <= Date.now()) throw conflict('This session has already started.');
  return event;
}

/** Registering twice is the same as registering once. */
export async function register(candidateId: string, eventId: string) {
  await openEventForStudent(candidateId, eventId);
  await prisma.campusWeekRegistration.upsert({
    where: { eventId_candidateId: { eventId, candidateId } },
    update: { status: 'GOING' },
    create: { eventId, candidateId, status: 'GOING' },
  });
}

/**
 * Taking a name off the list.
 *
 * Somebody who was invited keeps a row, marked DECLINED, so the creator is
 * not left wondering and so the invitation is not sent again. Somebody who
 * found the session themselves simply leaves.
 */
export async function unregister(candidateId: string, eventId: string) {
  await openEventForStudent(candidateId, eventId);
  const row = await prisma.campusWeekRegistration.findUnique({
    where: { eventId_candidateId: { eventId, candidateId } },
    select: { invitedAt: true },
  });
  if (!row) return;
  if (row.invitedAt) {
    await prisma.campusWeekRegistration.update({
      where: { eventId_candidateId: { eventId, candidateId } },
      data: { status: 'DECLINED' },
    });
  } else {
    await prisma.campusWeekRegistration.delete({ where: { eventId_candidateId: { eventId, candidateId } } });
  }
}

export async function publishedSimulations(companyId: string) {
  return prisma.simulation.findMany({
    where: { companyId, status: 'PUBLISHED' },
    orderBy: { title: 'asc' },
    select: { id: true, title: true },
  });
}
