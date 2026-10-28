import { CompanyStatus, InternshipOfferStatus, RunStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';

/**
 * Internship offers: a company offers one student an internship, usually on
 * the strength of their work on its simulation.
 *
 * A company can only offer to a student who has shown it their work - handed
 * a simulation in for its review, shared it with the company, or sent it a
 * test. Everyone else is a number in its analytics, not a name it can reach.
 * Every offer carries the company's promise that the student pays nothing.
 */

export const WORK_MODES = ['REMOTE', 'OFFICE', 'HYBRID'] as const;

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.')
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'Pick a date.');

export const offerSchema = z
  .object({
    candidateId: z.string().min(1).max(40),
    /** The simulation work that led to it, when there was one. */
    runId: z.string().min(1).max(40).optional().nullable(),
    role: z.string().trim().min(3, 'Name the role.').max(120),
    about: z.string().trim().min(40, 'Say what they will do - a few sentences.').max(4000),
    workMode: z.enum(WORK_MODES),
    city: z.string().trim().max(80).optional().nullable(),
    months: z.coerce.number().int().min(1, 'At least a month.').max(12, 'Up to twelve months.'),
    startsOn: ymd.optional().nullable(),
    stipend: z.coerce.number().int().min(0).max(1_000_000).optional().nullable(),
    respondBy: ymd,
    noFee: z.literal(true, { errorMap: () => ({ message: 'Confirm the student pays nothing.' }) }),
  })
  .superRefine((o, ctx) => {
    if (o.workMode !== 'REMOTE' && !o.city?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['city'], message: 'Say which city.' });
    }
    const today = new Date(new Date().toISOString().slice(0, 10));
    if (o.respondBy < today) ctx.addIssue({ code: 'custom', path: ['respondBy'], message: 'Give them until today or later.' });
    if (o.startsOn && o.startsOn < o.respondBy) {
      ctx.addIssue({ code: 'custom', path: ['startsOn'], message: 'Start after the reply-by date.' });
    }
  });
export type OfferInput = z.infer<typeof offerSchema>;

/** Today, as the start of the day: an offer may be answered on its reply-by date. */
const today = () => new Date(new Date().toISOString().slice(0, 10));

/** Still SENT, but past its reply-by date. */
const lapsed = (o: { status: InternshipOfferStatus; respondBy: Date }) =>
  o.status === InternshipOfferStatus.SENT && o.respondBy < today();

/** The status as either side reads it: a lapsed offer says so. */
const shownStatus = (o: { status: InternshipOfferStatus; respondBy: Date }) => (lapsed(o) ? 'LAPSED' : o.status);

/**
 * Whether a student has shown this company their work: a run on one of its
 * simulations handed in for review (or approved), shared with it, or a test
 * from one sent to it.
 */
export async function hasShownWork(companyId: string, candidateId: string) {
  const run = await prisma.workSimulationRun.findFirst({
    where: {
      candidateId,
      OR: [
        { simulation: { companyId }, OR: [{ submittedAt: { not: null } }, { status: RunStatus.COMPLETED }] },
        { shares: { some: { companyId } } },
        { simulation: { companyId }, attempts: { some: { sentAt: { not: null } } } },
      ],
    },
    select: { id: true },
  });
  return Boolean(run);
}

const OFFER_SELECT = {
  id: true,
  role: true,
  about: true,
  workMode: true,
  city: true,
  months: true,
  startsOn: true,
  stipend: true,
  respondBy: true,
  status: true,
  respondedAt: true,
  studentNote: true,
  createdAt: true,
  run: { select: { simulation: { select: { title: true, slug: true } } } },
} satisfies Prisma.InternshipOfferSelect;

type OfferRow = Prisma.InternshipOfferGetPayload<{ select: typeof OFFER_SELECT }>;

function shape(o: OfferRow) {
  const { run, ...rest } = o;
  return {
    ...rest,
    status: shownStatus(o),
    simulation: run ? { title: run.simulation.title, slug: run.simulation.slug } : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The company                                                                 */
/* -------------------------------------------------------------------------- */

export async function sendOffer(companyId: string, userId: string, input: OfferInput) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { status: true, name: true } });
  if (company?.status !== CompanyStatus.VERIFIED) throw forbidden('Your company is not verified yet, so it cannot offer internships.');
  if (!(await hasShownWork(companyId, input.candidateId))) {
    throw forbidden('You can offer an internship only to a student who has shown you their work.');
  }
  if (input.runId) {
    const run = await prisma.workSimulationRun.findFirst({
      where: { id: input.runId, candidateId: input.candidateId, simulation: { companyId } },
      select: { id: true },
    });
    if (!run) throw badRequest('That work is not on one of your simulations.');
  }
  const open = await prisma.internshipOffer.findFirst({
    where: { companyId, candidateId: input.candidateId, status: InternshipOfferStatus.SENT, respondBy: { gte: today() } },
    select: { id: true },
  });
  if (open) throw conflict('This student already has an offer from you waiting for an answer.');

  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: input.candidateId }, select: { userId: true } });
  const offer = await prisma.internshipOffer.create({
    data: {
      companyId,
      candidateId: input.candidateId,
      runId: input.runId ?? null,
      sentById: userId,
      role: input.role,
      about: input.about,
      workMode: input.workMode,
      city: input.workMode === 'REMOTE' ? input.city?.trim() || null : input.city!.trim(),
      months: input.months,
      startsOn: input.startsOn ?? null,
      stipend: input.stipend ?? null,
      respondBy: input.respondBy,
      noFeeAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.notification.create({
    data: {
      userId: candidate.userId,
      type: 'internship-offer',
      title: `${company.name} offered you an internship: ${input.role}`,
      link: '/student/jobs',
      payload: { offerId: offer.id },
    },
  });
  return companyOffers(companyId);
}

/** Every offer the company has made, newest first, with who it went to. */
export async function companyOffers(companyId: string) {
  const rows = await prisma.internshipOffer.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    select: {
      ...OFFER_SELECT,
      sentBy: { select: { fullName: true } },
      candidate: {
        select: {
          id: true,
          phone: true,
          course: true,
          specialisation: true,
          otherCollege: true,
          college: { select: { name: true } },
          listing: { select: { name: true } },
          user: { select: { fullName: true, email: true } },
        },
      },
    },
  });
  return rows.map(({ candidate: c, sentBy, ...o }) => ({
    ...shape(o),
    sentBy: sentBy.fullName,
    student: {
      id: c.id,
      name: c.user.fullName,
      email: c.user.email,
      phone: c.phone,
      college: c.college?.name ?? c.listing?.name ?? c.otherCollege ?? null,
      course: [c.course, c.specialisation].filter(Boolean).join(' · ') || null,
    },
  }));
}

/** Takes back an offer still waiting for an answer. */
export async function withdrawOffer(companyId: string, id: string) {
  const offer = await prisma.internshipOffer.findFirst({ where: { id, companyId }, select: { status: true } });
  if (!offer) throw notFound('No such offer.');
  if (offer.status !== InternshipOfferStatus.SENT) throw conflict('Only an offer waiting for an answer can be withdrawn.');
  await prisma.internshipOffer.update({ where: { id }, data: { status: InternshipOfferStatus.WITHDRAWN } });
  return companyOffers(companyId);
}

/* -------------------------------------------------------------------------- */
/* The student                                                                 */
/* -------------------------------------------------------------------------- */

/** Offers made to the student, waiting ones first. Withdrawn ones are not shown. */
export async function myOffers(candidateId: string) {
  const rows = await prisma.internshipOffer.findMany({
    where: { candidateId, status: { not: InternshipOfferStatus.WITHDRAWN } },
    orderBy: { createdAt: 'desc' },
    select: {
      ...OFFER_SELECT,
      sentBy: { select: { fullName: true, email: true } },
      company: { select: { name: true, logoUrl: true, website: true, city: true } },
    },
  });
  const offers = rows.map(({ sentBy, company, ...o }) => ({
    ...shape(o),
    company,
    // Who to talk to - once they have said yes.
    contact: o.status === InternshipOfferStatus.ACCEPTED ? { name: sentBy.fullName, email: sentBy.email } : null,
  }));
  const rank = (s: string) => (s === 'SENT' ? 0 : 1);
  return offers.sort((a, b) => rank(a.status) - rank(b.status));
}

export const respondSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  note: z.string().trim().max(500).optional(),
});

export async function respondToOffer(candidateId: string, id: string, input: z.infer<typeof respondSchema>) {
  const offer = await prisma.internshipOffer.findFirst({
    where: { id, candidateId },
    select: { status: true, respondBy: true, role: true, sentById: true, candidate: { select: { user: { select: { fullName: true } } } } },
  });
  if (!offer || offer.status === InternshipOfferStatus.WITHDRAWN) throw notFound('No such offer.');
  if (offer.status !== InternshipOfferStatus.SENT) throw conflict('You have already answered this offer.');
  if (lapsed(offer)) throw conflict('This offer has passed its reply-by date. Write to the company if you are still interested.');
  const accepted = input.decision === 'accept';
  await prisma.$transaction([
    prisma.internshipOffer.update({
      where: { id },
      data: {
        status: accepted ? InternshipOfferStatus.ACCEPTED : InternshipOfferStatus.DECLINED,
        respondedAt: new Date(),
        studentNote: input.note || null,
      },
    }),
    prisma.notification.create({
      data: {
        userId: offer.sentById,
        type: 'internship-offer-answer',
        title: `${offer.candidate.user.fullName} ${accepted ? 'accepted' : 'declined'} your offer: ${offer.role}`,
        link: '/company/offers',
        payload: { offerId: id },
      },
    }),
  ]);
  return myOffers(candidateId);
}
