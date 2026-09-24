import { Router } from 'express';
import { z } from 'zod';
import { JobOptionKind, JobStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import {
  assertEditable,
  eligibilityOf,
  eligibilityOptions,
  ownedJob,
  publishJob,
  publishReadiness,
  setEligibilityLists,
  setTargets,
} from './job.service.js';
import { can } from '../roles/can.js';
import { addOption, assertKnown, optionsFor, traitsOf } from './job.options.js';
import { embedUrlFrom, mapsLinkFrom } from './maps.js';
import { reachOf } from './reach.js';
import {
  ACCOMMODATIONS,
  GENDER_ELIGIBILITY,
  PWD_CATEGORIES,
  SHIFTS,
  TRAVEL,
  cleanKeys,
  isRestricted,
} from './inclusion.js';
import { CTC_INCLUDES, EMPLOYER_TYPES, OFFER_CONDITIONS } from './offerTerms.js';
import { SIMULATION_ROUND, assertSimulationRound } from '../proof/simulations.service.js';
import { annotateForCompany } from '../companyAccess/companyAccess.service.js';

export const jobRouter = Router();

jobRouter.use(requireRole('COMPANY'));

const optional = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/** A rupee figure. Wide enough for a CTC, tight enough to catch a typo. */
const money = z.coerce.number().min(0).max(100000000).optional();

export const jobSchema = z.object({
  /* --- what the role is ------------------------------------------------- */
  title: z.string().trim().min(2, 'Enter the role title.').max(160),
  description: z.string().trim().min(10, 'Describe the role.').max(6000),
  responsibilities: optional(4000),
  jobType: z.string().trim().min(1).max(60).default('FULL_TIME'),
  workMode: optional(60),
  location: optional(160),
  /* Where exactly, for a role with one office rather than only a city. */
  addressLine: optional(400),
  pincode: optional(12),
  /* Pasted off the map, not looked up. See maps.ts for why. */
  mapsLink: optional(1000),
  mapEmbedUrl: optional(2000),
  openings: z.coerce.number().int().min(1).max(100000).optional(),
  deadline: z.string().datetime('Pick a deadline.'),
  joiningFrom: z.string().datetime().optional().or(z.literal('')),

  /* --- what it pays ------------------------------------------------------ */
  /// The figures are always per year; this is only how they were stated.
  payPeriod: z.enum(['YEARLY', 'MONTHLY']).default('YEARLY'),
  ctcMin: money,
  ctcMax: money,
  ctcFixed: money,
  ctcVariable: money,
  joiningBonus: money,
  stipendPerMonth: z.coerce.number().min(0).max(10000000).optional(),
  internshipMonths: z.coerce.number().int().min(1).max(36).optional(),
  ppoCtc: money,
  bondMonths: z.coerce.number().int().min(0).max(120).optional(),
  bondAmount: money,
  bondNote: optional(1000),

  /* --- the gate before applying ------------------------------------------ */
  screeningTestName: optional(120),
  screeningTestUrl: optional(2000),
  screeningTestInstructions: optional(2000),
  screeningTestDeadline: z.string().datetime().optional().or(z.literal('')),
  screeningTestRequired: z.boolean().default(false),

  /* --- what is not open to discussion ------------------------------------ */
  terms: z
    .array(z.string().trim().min(3, 'Say what the condition is.').max(500))
    .max(20, 'Twenty conditions is more than anybody will read.')
    .default([]),

  /* --- who may apply ------------------------------------------------------ */
  minCgpa: z.coerce.number().min(0).max(10).optional(),
  minDegreePct: z.coerce.number().min(0).max(100).optional(),
  minTenthPct: z.coerce.number().min(0).max(100).optional(),
  minTwelfthPct: z.coerce.number().min(0).max(100).optional(),
  minDiplomaPct: z.coerce.number().min(0).max(100).optional(),
  minPgCgpa: z.coerce.number().min(0).max(10).optional(),
  minPgPct: z.coerce.number().min(0).max(100).optional(),
  preferredCgpa: z.coerce.number().min(0).max(10).optional(),
  preferredDegreePct: z.coerce.number().min(0).max(100).optional(),
  maxBacklogs: z.coerce.number().int().min(0).max(50).optional(),
  maxActiveBacklogs: z.coerce.number().int().min(0).max(50).optional(),
  maxGapYears: z.coerce.number().int().min(0).max(20).optional(),
  allowsLateralEntry: z.boolean().default(true),
  /** Said out loud: no marks bar at all. Clears every bar when it is on. */
  openToAll: z.boolean().default(false),
  allowedCourses: z.array(z.string().trim().max(120)).max(40).default([]),
  allowedSpecialisations: z.array(z.string().trim().max(120)).max(80).default([]),
  graduationYears: z.array(z.coerce.number().int().min(2000).max(2100)).max(20).default([]),
  /* --- who else it is open to, and what the work is like ------------------ */
  genderEligibility: z.enum(GENDER_ELIGIBILITY).default('ANY'),
  genderNote: optional(1000),
  pwdSuitable: z.enum(['YES', 'NO']).optional().or(z.literal('')),
  pwdCategories: z.array(z.string().max(40)).max(20).default([]),
  accommodations: z.array(z.string().max(40)).max(20).default([]),
  inclusionNote: optional(1000),
  shift: z.enum(SHIFTS).optional().or(z.literal('')),
  travel: z.enum(TRAVEL).optional().or(z.literal('')),
  relocationRequired: z.boolean().default(false),
  nightShiftSafety: optional(1500),

  /* --- who employs them, and the offer ------------------------------------ */
  designation: optional(160),
  sector: optional(120),
  employerType: z.enum(EMPLOYER_TYPES).optional().or(z.literal('')),
  employerName: optional(200),
  probationMonths: z.coerce.number().int().min(0).max(24).optional(),
  probationCtc: money,
  trainingMonths: z.coerce.number().int().min(0).max(24).optional(),
  trainingLocation: optional(160),
  trainingStipend: z.coerce.number().min(0).max(10000000).optional(),
  ctcIncludes: z.array(z.string().max(40)).max(20).default([]),
  ctcNote: optional(1000),
  resultDays: z.coerce.number().int().min(0).max(180).optional(),
  offerLetterDays: z.coerce.number().int().min(0).max(365).optional(),
  offerConditional: z.enum(['YES', 'NO']).optional().or(z.literal('')),
  offerConditions: z.array(z.string().max(40)).max(20).default([]),
  offerConditionNote: optional(1000),

  /** Asked for, rather than merely welcomed. Sorts applicants, never hides. */
  requiredSkillIds: z.array(z.string().trim().max(40)).max(40).default([]),
  skillIds: z.array(z.string().trim().max(40)).max(40).default([]),
});

const roundsSchema = z.object({
  rounds: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Name the round.').max(120),
        type: z.string().trim().min(1).max(60).default('RESUME_SCREEN'),
        isElimination: z.boolean().default(true),
        /** What sitting in it is actually like. */
        description: optional(2000),

        /* Somewhere to be, or a link to open. Never usefully both. */
        isOnline: z.boolean().default(false),
        addressLine: optional(400),
        pincode: optional(12),
        mapsLink: optional(1000),
        mapEmbedUrl: optional(2000),
        meetingLink: optional(500),
        shortlistCount: z.coerce.number().int().min(1).max(100000).optional(),
        // A campus round is a date in a college's calendar before it is
        // anything else - the placement cell books a hall from it.
        scheduledAt: z.string().datetime().optional().or(z.literal('')),
        durationMin: z.coerce.number().int().min(5).max(1440).optional(),
        mode: optional(60),
        venue: optional(160),
        config: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1, 'A role needs at least one round.')
    .max(12, 'Twelve rounds is plenty.'),
});

export const toData = (d: z.infer<typeof jobSchema>) => {
  /*
   * A role declared open to everyone keeps no bars at all.
   *
   * The flag and the numbers could otherwise disagree - a recruiter sets 7.0,
   * changes their mind and ticks "open to everyone", and the row still says
   * 7.0 while the card says anyone may apply. The visibility query reads the
   * numbers, so the numbers are what must go.
   */
  const bar = <T>(v: T | undefined): T | null => (d.openToAll ? null : (v ?? null));

  return {
    title: d.title,
    description: d.description,
    responsibilities: d.responsibilities || null,
    jobType: d.jobType,
    workMode: d.workMode || null,
    location: d.location || null,
    addressLine: d.addressLine || null,
    pincode: d.pincode || null,
    // Checked before they are kept, because the embed becomes the src of an
    // iframe on a page students open.
    mapsLink: mapsLinkFrom(d.mapsLink ?? ''),
    mapEmbedUrl: embedUrlFrom(d.mapEmbedUrl ?? ''),
    openings: d.openings ?? null,
    deadline: new Date(d.deadline),
    joiningFrom: d.joiningFrom ? new Date(d.joiningFrom) : null,

    payPeriod: d.payPeriod,
    ctcMin: d.ctcMin ?? null,
    ctcMax: d.ctcMax ?? null,
    ctcFixed: d.ctcFixed ?? null,
    ctcVariable: d.ctcVariable ?? null,
    joiningBonus: d.joiningBonus ?? null,
    stipendPerMonth: d.stipendPerMonth ?? null,
    internshipMonths: d.internshipMonths ?? null,
    ppoCtc: d.ppoCtc ?? null,
    bondMonths: d.bondMonths ?? null,
    bondAmount: d.bondAmount ?? null,
    bondNote: d.bondNote || null,

    screeningTestName: d.screeningTestName || null,
    screeningTestUrl: d.screeningTestUrl || null,
    screeningTestInstructions: d.screeningTestInstructions || null,
    screeningTestDeadline: d.screeningTestDeadline ? new Date(d.screeningTestDeadline) : null,
    screeningTestRequired: d.screeningTestRequired,

    minCgpa: bar(d.minCgpa),
    minDegreePct: bar(d.minDegreePct),
    minTenthPct: bar(d.minTenthPct),
    minTwelfthPct: bar(d.minTwelfthPct),
    minDiplomaPct: bar(d.minDiplomaPct),
    minPgCgpa: bar(d.minPgCgpa),
    minPgPct: bar(d.minPgPct),
    preferredCgpa: bar(d.preferredCgpa),
    preferredDegreePct: bar(d.preferredDegreePct),
    maxBacklogs: bar(d.maxBacklogs),
    maxActiveBacklogs: bar(d.maxActiveBacklogs),
    maxGapYears: bar(d.maxGapYears),
    allowsLateralEntry: d.allowsLateralEntry,
    openToAll: d.openToAll,

    genderEligibility: d.genderEligibility,
    // Only a restriction or a preference has anything to explain.
    genderNote: d.genderEligibility === 'ANY' ? null : d.genderNote || null,
    pwdSuitable: d.pwdSuitable || null,
    // Which disabilities, and what support, only mean something on a role
    // that has said it suits a person with a disability.
    pwdCategories: d.pwdSuitable === 'YES' ? cleanKeys(d.pwdCategories, PWD_CATEGORIES) : [],
    accommodations: d.pwdSuitable === 'YES' ? cleanKeys(d.accommodations, ACCOMMODATIONS) : [],
    inclusionNote: d.inclusionNote || null,
    shift: d.shift || null,
    travel: d.travel || null,
    relocationRequired: d.relocationRequired,
    // Only a night shift has a night-shift arrangement to describe.
    nightShiftSafety: d.shift === 'NIGHT' || d.shift === 'ROTATIONAL' ? d.nightShiftSafety || null : null,

    designation: d.designation || null,
    sector: d.sector || null,
    employerType: d.employerType || null,
    // A direct hire has no other employer to name.
    employerName: d.employerType && d.employerType !== 'DIRECT' ? d.employerName || null : null,
    probationMonths: d.probationMonths ?? null,
    probationCtc: d.probationMonths ? (d.probationCtc ?? null) : null,
    trainingMonths: d.trainingMonths ?? null,
    trainingLocation: d.trainingMonths ? d.trainingLocation || null : null,
    trainingStipend: d.trainingMonths ? (d.trainingStipend ?? null) : null,
    ctcIncludes: cleanKeys(d.ctcIncludes, CTC_INCLUDES),
    ctcNote: d.ctcNote || null,
    resultDays: d.resultDays ?? null,
    offerLetterDays: d.offerLetterDays ?? null,
    offerConditional: d.offerConditional || null,
    offerConditions: d.offerConditional === 'YES' ? cleanKeys(d.offerConditions, OFFER_CONDITIONS) : [],
    offerConditionNote: d.offerConditional === 'YES' ? d.offerConditionNote || null : null,
  };
};

const listsOf = (d: z.infer<typeof jobSchema>) => ({
  courses: d.allowedCourses,
  specialisations: d.allowedSpecialisations,
  years: d.graduationYears,
  skillIds: d.skillIds,
  requiredSkillIds: d.requiredSkillIds,
});

/**
 * The conditions of the role, in the order they were written.
 *
 * Replaced wholesale rather than patched, the same as rounds: a list edited
 * in a form arrives as the whole list, and matching up which line moved where
 * would be guesswork.
 */
async function setTerms(jobId: string, terms: string[]): Promise<void> {
  const clean = terms.map((t) => t.trim()).filter(Boolean);

  await prisma.$transaction(async (tx) => {
    await tx.jobTerm.deleteMany({ where: { jobId } });
    if (clean.length) {
      await tx.jobTerm.createMany({
        data: clean.map((text, i) => ({ jobId, order: i + 1, text })),
      });
    }
  });
}

/**
 * The checks that need two fields at once, so they cannot live on the schema.
 *
 * Asynchronous because the employment type is an open list: what it means -
 * whether it pays a stipend, whether it converts - is a property of the chosen
 * option rather than something this code can know from its name.
 */
async function assertCoherent(companyId: string, d: z.infer<typeof jobSchema>): Promise<void> {
  if (d.ctcMin && d.ctcMax && d.ctcMin > d.ctcMax) {
    throw conflict('The minimum CTC is above the maximum.');
  }

  // The breakup has to add up to something the headline can contain, or the
  // college publishes one number and the student was promised another.
  const parts = (d.ctcFixed ?? 0) + (d.ctcVariable ?? 0);
  if (d.ctcMax && parts > d.ctcMax) {
    throw conflict('Fixed plus variable comes to more than the top of the CTC range.');
  }
  if (d.ctcFixed && d.ctcMin && d.ctcFixed > d.ctcMin) {
    throw conflict('The fixed component is above the bottom of the CTC range.');
  }

  /*
   * Every check below reads a bar, so none of them applies to a role that has
   * declared it has no bars. Without this, a recruiter who fills in criteria,
   * changes their mind and ticks "open to everyone" is refused the save over
   * numbers that were about to be thrown away.
   */
  if (!d.openToAll) {
    // A preference below the bar changes nothing, and reads as a mistake to
    // anybody who sees both numbers written down.
    if (d.preferredCgpa !== undefined && d.minCgpa !== undefined && d.preferredCgpa < d.minCgpa) {
      throw conflict('The preferred CGPA is below the minimum, so it would prefer nobody.');
    }
    if (
      d.preferredDegreePct !== undefined &&
      d.minDegreePct !== undefined &&
      d.preferredDegreePct < d.minDegreePct
    ) {
      throw conflict('The preferred percentage is below the minimum, so it would prefer nobody.');
    }

    /*
     * The trap this whole section exists to close: a role that welcomes lateral
     * entrants and then asks for a 12th standard result they were never going
     * to have. Refused rather than warned about, because it silently empties
     * exactly the group it just invited.
     */
    if (d.allowsLateralEntry && d.minTwelfthPct !== undefined && d.minDiplomaPct === undefined) {
      throw conflict(
        'Lateral-entry students have no 12th standard marks, so a 12th bar on its own excludes every one of them. Set a diploma percentage too.',
      );
    }

    if (d.maxActiveBacklogs !== undefined && d.maxBacklogs !== undefined) {
      if (d.maxActiveBacklogs > d.maxBacklogs) {
        throw conflict(
          'More live backlogs are allowed than backlogs in total, which cannot be met by anybody.',
        );
      }
    }
  }

  /*
   * Excluding people by gender is sometimes lawful and often not, so it is
   * never silent: the reason is written down, and the college reads it before
   * it lets the role anywhere near its students.
   */
  if (isRestricted(d.genderEligibility) && (d.genderNote ?? '').trim().length < 10) {
    throw conflict(
      'Say why this role is open to one gender only - the college reads it before accepting the request.',
    );
  }
  if (d.employerType && d.employerType !== 'DIRECT' && !(d.employerName ?? '').trim()) {
    throw conflict('Name the company whose payroll the student will be on.');
  }
  if (d.offerConditional === 'YES' && d.offerConditions.length === 0 && !(d.offerConditionNote ?? '').trim()) {
    throw conflict('Say what the offer is conditional on.');
  }
  if (d.probationCtc && d.ctcMin && d.probationCtc > d.ctcMin) {
    throw conflict('Pay during probation is above the CTC. Leave it blank if it is the same.');
  }

  if (d.pwdSuitable === 'YES' && d.pwdCategories.length === 0) {
    throw conflict('Choose at least one disability this role suits, or change the answer to “not assessed”.');
  }

  const traits = await traitsOf(companyId, d.jobType);

  if (!traits.paysStipend && (d.stipendPerMonth || d.internshipMonths)) {
    throw conflict('Stipend and duration belong to a type that pays one. Change the type.');
  }
  if (d.ppoCtc && !traits.convertsToPpo) {
    throw conflict('A pre-placement offer figure only applies to a type that converts.');
  }
  if (d.bondAmount && !d.bondMonths) {
    throw conflict('A bond amount needs the number of months it runs for.');
  }
  if (d.bondNote && !d.bondMonths && !d.bondAmount) {
    throw conflict('There are bond terms here but no bond. Add the months and the amount.');
  }

  // A test nobody can reach is a test that stops everybody applying.
  if (d.screeningTestRequired && !d.screeningTestUrl) {
    throw conflict('A test that has to be taken before applying needs a link to it.');
  }
  if (d.screeningTestUrl && !/^https?:\/\//i.test(d.screeningTestUrl)) {
    throw conflict('The test link should start with http:// or https://.');
  }
  if (d.screeningTestDeadline && new Date(d.screeningTestDeadline) > new Date(d.deadline)) {
    throw conflict('The test closes after applications do, which nobody could manage.');
  }
}

/** GET /api/company/jobs */
jobRouter.get(
  '/',
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);

    const jobs = await prisma.job.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { rounds: true, applications: true } },
        postings: { select: { status: true } },
      },
    });

    res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        jobType: j.jobType,
        workMode: j.workMode,
        location: j.location,
        openings: j.openings,
        deadline: j.deadline,
        status: j.status,
        roundCount: j._count.rounds,
        applicationCount: j._count.applications,
        // A published job can be live at some colleges and pending at others.
        accepted: j.postings.filter((p) => p.status === 'ACCEPTED').length,
        pending: j.postings.filter((p) => p.status === 'PENDING').length,
        declined: j.postings.filter((p) => p.status === 'DECLINED').length,
      })),
    });
  }),
);

/** POST /api/company/jobs — always starts as a draft */
jobRouter.post(
  '/',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const data = jobSchema.parse(req.body);
    await assertKnown(companyId, JobOptionKind.EMPLOYMENT_TYPE, data.jobType);
    await assertKnown(companyId, JobOptionKind.WORK_MODE, data.workMode);
    await assertCoherent(companyId, data);

    const job = await prisma.job.create({
      data: { ...toData(data), companyId, createdById: req.session.userId! },
    });
    await setEligibilityLists(job.id, listsOf(data));
    await setTerms(job.id, data.terms);

    res.status(201).json({ job: { ...job, ...listsOf(data), terms: data.terms } });
  }),
);

/**
 * GET /api/company/jobs/meta
 *
 * The courses, branches, years and skills a recruiter may choose from.
 *
 * Offered rather than typed because eligibility is matched on exact strings:
 * a recruiter who types "B.E." when every student has "B.Tech" publishes a
 * role that nobody can see, and nothing anywhere says so.
 */
jobRouter.get(
  '/meta',
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);

    const [options, skills, lists] = await Promise.all([
      eligibilityOptions(),
      prisma.skill.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      optionsFor(companyId),
    ]);

    res.json({
      ...options,
      skills,
      options: lists,
      // The fixed lists behind the inclusion step, so the form and the
      // server can never disagree on what a key means.
      inclusion: { pwdCategories: PWD_CATEGORIES, accommodations: ACCOMMODATIONS },
      offer: { ctcIncludes: CTC_INCLUDES, conditions: OFFER_CONDITIONS },
    });
  }),
);

/**
 * POST /api/company/jobs/options
 *
 * Adds a choice to one of the dropdowns on the job form. It belongs to this
 * company: the platform ships the vocabulary almost everybody needs, and one
 * recruiter inventing a round type should not change what every other company
 * sees.
 */
jobRouter.post(
  '/options',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);

    const { kind, label, paysStipend, convertsToPpo } = z
      .object({
        kind: z.nativeEnum(JobOptionKind),
        label: z
          .string()
          .trim()
          .min(2, 'Give it a name.')
          .max(60, 'Keep it short enough to read in a dropdown.'),
        // Only an employment type has these; for the other lists they are
        // ignored, because those are words on a screen and nothing else.
        paysStipend: z.boolean().default(false),
        convertsToPpo: z.boolean().default(false),
      })
      .parse(req.body);

    res.status(201).json({
      option: await addOption(companyId, kind, label, { paysStipend, convertsToPpo }),
    });
  }),
);

/**
 * GET /api/company/jobs/:id/reach
 *
 * How many students the role as written would actually reach. Writing
 * criteria was otherwise done blind: 8.0 in a CGPA box could leave twelve
 * students or twelve hundred, and the first anybody knew was when nobody
 * applied.
 */
jobRouter.get(
  '/:id/reach',
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await ownedJob(companyId, req.params.id!);

    res.json(await reachOf(req.params.id!));
  }),
);

/** GET /api/company/jobs/:id */
jobRouter.get(
  '/:id',
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await ownedJob(companyId, req.params.id!);

    const [job, readiness] = await Promise.all([
      prisma.job.findUniqueOrThrow({
        where: { id: req.params.id },
        include: {
          // The preview shows the card a student sees, which carries the
          // company's name rather than the recruiter's.
          company: { select: { name: true } },
          rounds: { orderBy: { order: 'asc' } },
          courses: true,
          specialisations: true,
          gradYears: true,
          skills: { include: { skill: { select: { id: true, name: true } } } },
          team: { include: { user: { select: { id: true, fullName: true, email: true } } } },
          terms: { orderBy: { order: 'asc' } },
          postings: {
            include: {
              placement: {
                select: {
                  id: true,
                  name: true,
                  year: true,
                  college: { select: { name: true } },
                },
              },
            },
          },
          _count: { select: { applications: true } },
        },
      }),
      publishReadiness(req.params.id!),
    ]);

    // Everybody at the company, so the picker has a list to choose from.
    const colleagues = await prisma.companyMember.findMany({
      where: { companyId },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        role: { select: { name: true } },
      },
    });

    res.json({
      job: {
        ...job,
        ...eligibilityOf(job),
        team: job.team.map((t) => ({ ...t.user })),
        terms: job.terms.map((t) => t.text),
        // Derived, never stored: a separate "number of rounds" field would
        // sooner or later disagree with the rounds themselves.
        roundCount: job.rounds.length,
        colleagues: colleagues.map((m) => ({ ...m.user, roleName: m.role.name })),
        applicationCount: job._count.applications,
        postings: job.postings.map((p) => ({
          id: p.id,
          status: p.status,
          declineReason: p.declineReason,
          decidedAt: p.decidedAt,
          placementId: p.placement.id,
          placementName: p.placement.name,
          placementYear: p.placement.year,
          collegeName: p.placement.college.name,
        })),
      },
      readiness,
    });
  }),
);

/** PATCH /api/company/jobs/:id — drafts only */
jobRouter.patch(
  '/:id',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);
    assertEditable(job);

    const data = jobSchema.parse(req.body);
    await assertKnown(companyId, JobOptionKind.EMPLOYMENT_TYPE, data.jobType);
    await assertKnown(companyId, JobOptionKind.WORK_MODE, data.workMode);
    await assertCoherent(companyId, data);

    const updated = await prisma.job.update({ where: { id: job.id }, data: toData(data) });
    await setEligibilityLists(job.id, listsOf(data));
    await setTerms(job.id, data.terms);

    res.json({ job: { ...updated, ...listsOf(data), terms: data.terms } });
  }),
);

/** PUT /api/company/jobs/:id/rounds — replaces the ordered list */
jobRouter.put(
  '/:id/rounds',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);
    assertEditable(job);

    const { rounds } = roundsSchema.parse(req.body);

    for (const r of rounds) {
      await assertKnown(companyId, JobOptionKind.ROUND_TYPE, r.type);
      // A simulation round is only as good as the simulation behind it.
      if (r.type === SIMULATION_ROUND) await assertSimulationRound(companyId, r.config);
      await assertKnown(companyId, JobOptionKind.ROUND_MODE, r.mode);
    }

    await prisma.$transaction(async (tx) => {
      await tx.round.deleteMany({ where: { jobId: job.id } });
      await tx.round.createMany({
        data: rounds.map((r, i) => ({
          jobId: job.id,
          order: i + 1,
          name: r.name,
          type: r.type,
          isElimination: r.isElimination,
          description: r.description || null,
          shortlistCount: r.shortlistCount ?? null,

          /*
           * One or the other, never a leftover of both. A round switched to
           * online keeping a hall address, or back with a dead meeting link,
           * is how a student ends up at the wrong place entirely.
           */
          isOnline: r.isOnline,
          meetingLink: r.isOnline ? r.meetingLink || null : null,
          addressLine: r.isOnline ? null : r.addressLine || null,
          pincode: r.isOnline ? null : r.pincode || null,
          mapsLink: r.isOnline ? null : mapsLinkFrom(r.mapsLink ?? ''),
          mapEmbedUrl: r.isOnline ? null : embedUrlFrom(r.mapEmbedUrl ?? ''),
          scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : null,
          durationMin: r.durationMin ?? null,
          mode: r.mode || null,
          venue: r.venue || null,
          config: r.config as object,
        })),
      });
    });

    const saved = await prisma.round.findMany({
      where: { jobId: job.id },
      orderBy: { order: 'asc' },
    });
    res.json({ rounds: saved });
  }),
);

/**
 * GET /api/company/drives
 * The marketplace side: every open drive a recruiter could aim at, with enough
 * detail to choose sensibly.
 */
jobRouter.get(
  '/:id/targets',
  can('job:read'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);

    const [allDrives, chosen, waiting] = await Promise.all([
      prisma.placement.findMany({
        where: { isOpen: true },
        orderBy: [{ year: 'desc' }, { name: 'asc' }],
        include: {
          college: { select: { name: true, code: true, city: true, state: true, naacGrade: true, tenantId: true } },
          batches: {
            select: {
              id: true,
              name: true,
              course: true,
              graduationYear: true,
              _count: { select: { memberships: true } },
            },
            orderBy: { name: 'asc' },
          },
        },
      }),
      prisma.jobPosting.findMany({
        where: { jobId: job.id },
        select: {
          placementId: true,
          status: true,
          batches: { select: { batchId: true } },
        },
      }),

      /*
       * Colleges on the portal with no drive open.
       *
       * You target a drive, not a college - a placement season is the thing a
       * cell opens, accepts roles into and closes. But a college that simply
       * vanishes from this list looks like a college that is not on the
       * portal, and a recruiter has no way to tell the two apart. Listed with
       * the reason instead.
       */
      prisma.college.findMany({
        where: { placements: { none: { isOpen: true } } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, city: true, state: true },
      }),
    ]);

    const chosenBy = new Map(chosen.map((c) => [c.placementId, c]));
    // Institutions that want to approve a company first say so here, before
    // the recruiter picks, rather than only when saving is refused.
    const drives = await annotateForCompany(companyId, allDrives);

    res.json({
      drives: drives.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        year: d.year,
        collegeName: d.college.name,
        collegeCode: d.college.code,
        collegeCity: d.college.city,
        collegeState: d.college.state,
        naacGrade: d.college.naacGrade,
        courses: [...new Set(d.batches.map((b) => b.course))],
        studentCount: d.batches.reduce((n, b) => n + b._count.memberships, 0),
        status: chosenBy.get(d.id)?.status ?? null,
        needsApproval: d.needsApproval,

        // Every batch in the drive, and which of them this role was narrowed
        // to. An empty chosen list means the whole drive, not none of it.
        batches: d.batches.map((b) => ({
          id: b.id,
          name: b.name,
          course: b.course,
          graduationYear: b.graduationYear,
          studentCount: b._count.memberships,
        })),
        chosenBatchIds: (chosenBy.get(d.id)?.batches ?? []).map((x) => x.batchId),
      })),

      notOpenYet: waiting.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        where: [c.city, c.state].filter(Boolean).join(', '),
      })),
    });
  }),
);

/** PUT /api/company/jobs/:id/targets */
jobRouter.put(
  '/:id/targets',
  can('posting:target'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);

    const body = z
      .object({
        /*
         * The old shape stays accepted: a list of drive ids means the whole
         * of each, which is what it has always meant.
         */
        placementIds: z.array(z.string()).optional(),
        targets: z
          .array(
            z.object({
              placementId: z.string().trim().min(1),
              /** Empty or absent means every batch in that drive. */
              batchIds: z.array(z.string().trim().min(1)).max(200).default([]),
            }),
          )
          .max(200)
          .optional(),
      })
      .parse(req.body);

    const targets =
      body.targets ?? (body.placementIds ?? []).map((placementId) => ({ placementId }));

    res.json(await setTargets(job, targets));
  }),
);

/**
 * PUT /api/company/jobs/:id/team
 *
 * Who at the company is running this particular hire - the manual's fourth
 * section. Only people who already belong to the company: this names who is
 * involved, it does not grant anybody access they did not have.
 */
jobRouter.put(
  '/:id/team',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);

    const { userIds } = z
      .object({ userIds: z.array(z.string().trim().min(1)).max(50).default([]) })
      .parse(req.body);

    const members = await prisma.companyMember.findMany({
      where: { companyId, userId: { in: userIds } },
      select: { userId: true },
    });
    const allowed = new Set(members.map((m) => m.userId));

    const stranger = userIds.find((id) => !allowed.has(id));
    if (stranger) throw conflict('Somebody on that list is not part of your company.');

    await prisma.$transaction(async (tx) => {
      await tx.jobTeamMember.deleteMany({ where: { jobId: job.id } });
      if (userIds.length) {
        await tx.jobTeamMember.createMany({
          data: [...new Set(userIds)].map((userId) => ({ jobId: job.id, userId })),
        });
      }
    });

    res.json({ team: userIds });
  }),
);

/**
 * POST /api/company/jobs/:id/declare-no-fee
 *
 * The recruiter's own statement that nothing is charged at any stage, with
 * who made it and when. Its own action rather than a field on the form, so
 * saving another step can never clear it - and so it is a thing somebody
 * did, not a box that happened to be ticked.
 */
jobRouter.post(
  '/:id/declare-no-fee',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);
    if (job.status !== JobStatus.DRAFT) throw conflict('Only a draft can be declared.');
    await prisma.job.update({
      where: { id: job.id },
      data: { noFeeDeclaredAt: new Date(), noFeeDeclaredById: req.session.userId! },
    });
    res.status(204).end();
  }),
);

/** POST /api/company/jobs/:id/publish */
jobRouter.post(
  '/:id/publish',
  can('job:publish'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);

    if (job.status === JobStatus.PUBLISHED) throw conflict('This role is already published.');
    if (job.status === JobStatus.CLOSED) throw conflict('This role has been closed.');

    res.json({ job: await publishJob(job.id) });
  }),
);

/** POST /api/company/jobs/:id/close */
jobRouter.post(
  '/:id/close',
  can('job:publish'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);

    const closed = await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.CLOSED },
    });
    res.json({ job: closed });
  }),
);

/** DELETE /api/company/jobs/:id — drafts only */
jobRouter.delete(
  '/:id',
  can('job:write'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    const job = await ownedJob(companyId, req.params.id!);

    if (job.status !== JobStatus.DRAFT) {
      throw forbidden('Only a draft can be deleted. Close the role instead.');
    }

    await prisma.job.delete({ where: { id: job.id } });
    res.status(204).end();
  }),
);
