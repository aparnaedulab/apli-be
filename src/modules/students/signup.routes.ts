import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { TenantStatus } from '@prisma/client';
import { z } from 'zod';
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { hashPassword, SCOPE_INCLUDE } from '../auth/auth.service.js';
import { openSession } from '../tenants/tenant.session.js';
import { UNASSIGNED } from '../campus/students.service.js';
import { activeGenders, activeInterests, matchGender } from './lists.js';
import { suggestCities } from './cities.js';
import { welcomeStudent } from './welcome.mail.js';

/**
 * Open sign-up for students.
 *
 * Work simulations are open to every student, from any college, so this
 * door has no gate: no college code, no invitation, no approval. A student
 * gives their name, email and a password, says where they study, and is
 * signed in.
 *
 * Where they study is a choice from the colleges already on Apli.ai, from
 * the directory of colleges the platform team keeps, or a name typed in when
 * theirs is in neither. A chosen college puts the
 * student on that college's roster - in its "Unassigned" group, the same
 * place a self-registered student has always landed - so the university can
 * see who from its colleges has joined. Nothing about that is a check: the
 * college does not approve the student, and the student is not verified by
 * signing up.
 *
 * The colleges' names are public reference data here, the way a dropdown of
 * universities is on any sign-up form. The search still asks for two
 * letters, returns a handful, and is rate limited, so it answers people
 * typing rather than scripts listing.
 */
export const signupRouter = Router();

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many searches. Wait a minute and try again.' },
  },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many tries. Wait a minute and try again.' },
  },
});

/** Colleges a student may pick: those whose institution is live. */
const LIVE_COLLEGE = { tenant: { status: TenantStatus.ACTIVE } } as const;

/**
 * GET /api/public/cities?q=nas
 *
 * Up to eight cities for "City you live in": the ones Apli.ai knows, then
 * the rest of India from OpenStreetMap. See cities.ts.
 */
signupRouter.get(
  '/cities',
  searchLimiter,
  asyncHandler(async (req, res) => {
    res.json({ cities: await suggestCities(String(req.query.q ?? '')) });
  }),
);

/**
 * GET /api/public/colleges?q=pic
 *
 * Up to eight colleges whose name or city matches: partner colleges whose
 * institution is live, then the directory.
 */
signupRouter.get(
  '/colleges',
  searchLimiter,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      res.json({ colleges: [] });
      return;
    }

    const [colleges, listings] = await Promise.all([
      prisma.college.findMany({
        where: {
          ...LIVE_COLLEGE,
          OR: [{ name: { contains: q } }, { code: { contains: q } }, { city: { contains: q } }],
        },
        orderBy: { name: 'asc' },
        take: 8,
        select: { id: true, name: true, city: true, tenant: { select: { shortName: true, name: true } } },
      }),
      prisma.collegeListing.findMany({
        where: { isActive: true, OR: [{ name: { contains: q } }, { city: { contains: q } }] },
        orderBy: { name: 'asc' },
        take: 8,
        select: { id: true, name: true, city: true, affiliation: true },
      }),
    ]);

    // Partners first. A listed college that has since partnered would be
    // offered twice, so a listing with a partner's name and city gives way.
    const partnerKeys = new Set(colleges.map((c) => `${c.name.toLowerCase()}|${c.city.toLowerCase()}`));
    const options = [
      ...colleges.map((c) => ({
        id: c.id,
        source: 'partner' as const,
        name: c.name,
        city: c.city,
        institution: c.tenant.shortName ?? c.tenant.name,
      })),
      ...listings
        .filter((l) => !partnerKeys.has(`${l.name.toLowerCase()}|${l.city.toLowerCase()}`))
        .map((l) => ({
          id: l.id,
          source: 'listing' as const,
          name: l.name,
          city: l.city,
          institution: l.affiliation,
        })),
    ];

    res.json({ colleges: options.slice(0, 8) });
  }),
);

/**
 * GET /api/public/signup/options
 *
 * What the form offers: courses, degree levels, genders and the fields of
 * work a student can say they want to try.
 */
signupRouter.get(
  '/signup/options',
  searchLimiter,
  asyncHandler(async (_req, res) => {
    const [courses, genders, interests] = await Promise.all([
      prisma.course.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { name: true, level: true, years: true },
      }),
      activeGenders(),
      activeInterests(),
    ]);
    res.json({
      // Each with its level, so the form offers only the courses of the level picked.
      courses,
      genders,
      degreeLevels: DEGREE_LEVELS,
      interests,
    });
  }),
);

const thisYear = new Date().getFullYear();

/** How far into their studies a student is. */
export const DEGREE_LEVELS = [
  { key: 'DIPLOMA', label: 'Diploma' },
  { key: 'UG', label: 'Undergraduate' },
  { key: 'PG', label: 'Postgraduate' },
  { key: 'PHD', label: 'PhD' },
] as const;

const signupSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191),
    password: z.string().min(10, 'Use at least 10 characters for your password.').max(200),
    collegeId: z.string().trim().max(40).optional(),
    listingId: z.string().trim().max(40).optional(),
    otherCollege: z.string().trim().max(150).optional(),
    course: z.string().trim().min(2, 'Choose your course.').max(120),
    degreeLevel: z.enum(['DIPLOMA', 'UG', 'PG', 'PHD'], {
      errorMap: () => ({ message: 'Choose your level of study.' }),
    }),
    specialisation: z.string().trim().max(120).optional(),
    city: z.string().trim().min(2, 'Enter the city you live in.').max(120),
    /** Which country's code the number goes with, e.g. IN. */
    phoneCountry: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => isSupportedCountry(v), 'Pick a country code from the list.')
      .default('IN'),
    phone: z.string().trim().min(1, 'Enter your mobile number.').max(24),
    gender: z.string().trim().min(1, 'Choose your gender, or "Prefer not to say".').max(40),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth.')
      .transform((v) => new Date(`${v}T00:00:00.000Z`))
      .refine((d) => !Number.isNaN(d.getTime()), 'Enter your date of birth.')
      .refine((d) => ageOn(d) >= 14 && ageOn(d) <= 70, 'Check your date of birth.'),
    /** Out of 10. The college confirms it later; until then it is the student's word. */
    cgpa: z.coerce
      .number()
      .min(0, 'A CGPA is between 0 and 10.')
      .max(10, 'A CGPA is between 0 and 10.')
      .transform((v) => Math.round(v * 100) / 100)
      .optional(),
    interests: z
      .array(z.string().trim().min(1).max(80))
      .max(3, 'Pick up to three.')
      .default([])
      .transform((list) => [...new Set(list)]),
    /** The batch: the year they joined and the year they finish (2022 - 2026). */
    startYear: z.coerce
      .number({ invalid_type_error: 'Pick your batch.' })
      .int()
      .min(thisYear - 8, 'Pick your batch.')
      .max(thisYear + 1, 'Pick your batch.'),
    graduationYear: z.coerce
      .number({ invalid_type_error: 'Pick your batch.' })
      .int()
      .min(thisYear - 1, 'Pick the year you finish your course.')
      .max(thisYear + 7, 'Pick the year you finish your course.'),
    agree: z.literal(true, { errorMap: () => ({ message: 'Agree to the terms to create your account.' }) }),
  })
  .refine((b) => Boolean(b.collegeId) || Boolean(b.listingId) || Boolean(b.otherCollege), {
    message: 'Tell us where you study.',
    path: ['collegeId'],
  })
  // The number is checked against its country's numbering - as a check of
  // its own, so it is reported alongside any other mistake - and kept in one
  // form, "+91 90000 00000", whatever spacing it was typed with.
  .refine((b) => b.graduationYear > b.startYear && b.graduationYear - b.startYear <= 7, {
    message: 'Pick your batch.',
    path: ['startYear'],
  })
  .superRefine((b, ctx) => {
    if (b.phone && !phoneOf(b)?.isValid()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Enter a valid mobile number for that country.' });
    }
  })
  .transform((b) => ({ ...b, phone: phoneOf(b)!.formatInternational() }));

/** Whole years old on the given date of birth, today. */
function ageOn(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function phoneOf(b: { phone?: string; phoneCountry?: string }) {
  return parsePhoneNumberFromString(b.phone ?? '', (b.phoneCountry || 'IN') as CountryCode);
}

/**
 * POST /api/public/signup/student
 *
 * Creates the account and the student record, and signs them in.
 */
signupRouter.post(
  '/signup/student',
  signupLimiter,
  asyncHandler(async (req, res) => {
    const body = signupSchema.parse(req.body);

    const college = body.collegeId
      ? await prisma.college.findFirst({
          where: { id: body.collegeId, ...LIVE_COLLEGE },
          select: { id: true, tenantId: true },
        })
      : null;
    if (body.collegeId && !college) throw badRequest('Pick your college from the list, or type its name.');

    const listing =
      !college && body.listingId
        ? await prisma.collegeListing.findFirst({ where: { id: body.listingId, isActive: true }, select: { id: true } })
        : null;
    if (!college && body.listingId && !listing) throw badRequest('Pick your college from the list, or type its name.');

    const gender = matchGender(body.gender, await activeGenders());
    if (!gender.ok || !gender.value) throw badRequest('Pick your gender from the list.');

    // A course on the list carries its level, so the level cannot disagree with it.
    const listed = await prisma.course.findFirst({ where: { name: body.course, isActive: true }, select: { level: true } });
    const degreeLevel = listed?.level ?? body.degreeLevel;

    // Interests come from the list the platform team keeps.
    if (body.interests.length) {
      const offered = new Set(await activeInterests());
      if (body.interests.some((i) => !offered.has(i))) {
        throw badRequest('Pick your interests from the list.');
      }
    }

    const passwordHash = await hashPassword(body.password);

    const user = await prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: body.email } })) {
        throw conflict('An account with that email address already exists. Sign in instead.');
      }

      const created = await tx.user.create({
        data: { email: body.email, fullName: body.fullName, passwordHash, role: 'CANDIDATE' },
      });

      const candidate = await tx.candidate.create({
        data: {
          userId: created.id,
          collegeId: college?.id ?? null,
          listingId: listing?.id ?? null,
          otherCollege: college || listing ? null : (body.otherCollege ?? null),
          course: body.course,
          specialisation: body.specialisation || null,
          degreeLevel,
          city: body.city,
          phone: body.phone,
          dateOfBirth: body.dateOfBirth,
          gender: gender.value,
          cgpa: body.cgpa ?? null,
          interests: body.interests,
          startYear: body.startYear,
          graduationYear: body.graduationYear,
        },
      });

      // On the college's roster, so its university can see who has joined.
      if (college) {
        const landing =
          (await tx.batch.findFirst({ where: { collegeId: college.id, name: UNASSIGNED } })) ??
          (await tx.batch.create({
            data: { collegeId: college.id, tenantId: college.tenantId, name: UNASSIGNED },
          }));
        await tx.batchMembership.create({ data: { batchId: landing.id, candidateId: candidate.id } });
      }

      return tx.user.findUniqueOrThrow({ where: { id: created.id }, include: SCOPE_INCLUDE });
    });

    await openSession(req, user);

    // Only if their institution switched it on; it never holds up the sign-up.
    void welcomeStudent({ email: body.email, name: body.fullName, tenantId: college?.tenantId ?? null });

    res.status(201).json({
      user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role },
    });
  }),
);
