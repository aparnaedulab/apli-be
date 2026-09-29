import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Prisma, TenantStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { hashPassword, SCOPE_INCLUDE } from '../auth/auth.service.js';
import { readCell } from './fields.js';
import { activeGenders, matchGender } from './lists.js';
import { programmeIndex, resolveProgramme } from './programme.js';
import { policyFor, selfFormFields } from './policy.js';
import { UNASSIGNED } from '../campus/students.service.js';

/**
 * A student putting themselves on their college's roster.
 *
 * ---------------------------------------------------------------------------
 * How somebody gets here
 *
 * From the public site, not from a link somebody had to send them. But the
 * platform deliberately does not let anybody list its institutions - the
 * public tenant lookup is rate limited precisely so a script cannot walk
 * slugs and enumerate them - and a registration page with a dropdown of
 * every university on the platform would give that away in one request.
 *
 * So the student types their college's code, which is unique platform-wide,
 * is printed on everything they own, and tells us the institution, its
 * branding, its intake policy and its batches in one lookup. Nothing is
 * disclosed until a real code is typed, and an institution that has not
 * switched registration on answers the same way as one that does not exist.
 *
 * ---------------------------------------------------------------------------
 * What it collects
 *
 * Whatever the institution said to collect, and nothing else. The old batch
 * join code took a name, an email and a password, which produced a student
 * with no course - and a student with no course matches only roles that
 * state no course criterion, so they were invisible to essentially the whole
 * drive with nothing on screen to explain it. The policy is what stops that
 * happening quietly.
 *
 * Registering is never the same as being verified. A self-registered student
 * is a claim, and the placement cell still has to freeze their record before
 * they can apply to anything - exactly as for a student the college entered
 * itself.
 */

export const registerRouter = Router();

/**
 * Generous for a person typing their own college code, tight for a script
 * guessing codes to find out which institutions exist.
 */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many tries. Wait a minute and try again.' },
  },
});

/**
 * One answer for "no such code", "that institution is not live" and "that
 * institution does not take registrations". Which of the three it is tells a
 * stranger something about an institution they have no business knowing.
 */
const NOT_OPEN =
  'We cannot find a college with that code that is taking registrations. Check the code with your placement cell.';

async function openCollege(code: string) {
  const tidy = code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 .-]{0,30}$/.test(tidy)) throw notFound(NOT_OPEN);

  const college = await prisma.college.findUnique({
    where: { code: tidy },
    select: {
      id: true,
      name: true,
      city: true,
      tenantId: true,
      tenant: {
        select: { name: true, shortName: true, slug: true, logoUrl: true, brandColor: true, status: true },
      },
    },
  });

  if (!college || college.tenant.status !== TenantStatus.ACTIVE) throw notFound(NOT_OPEN);

  const policy = await policyFor(college.tenantId);
  if (!policy.selfRegister) throw notFound(NOT_OPEN);

  return { college, policy };
}

/**
 * GET /api/public/register/:code
 *
 * What the form should ask, and who it belongs to. Everything here is
 * already on the college's public face except the batch names, which a
 * student has to be able to pick from and which say nothing a prospectus
 * does not.
 */
registerRouter.get(
  '/register/:code',
  limiter,
  asyncHandler(async (req, res) => {
    const { college, policy } = await openCollege(String(req.params.code ?? ''));

    const [batches, programmes, genders] = await Promise.all([
      prisma.batch.findMany({
        where: { OR: [{ collegeId: college.id }, { collegeId: null, tenantId: college.tenantId }] },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      programmeIndex(college.id),
      activeGenders(),
    ]);

    res.json({
      college: { name: college.name, city: college.city, code: String(req.params.code).toUpperCase() },
      institution: {
        name: college.tenant.name,
        shortName: college.tenant.shortName,
        slug: college.tenant.slug,
        logoUrl: college.tenant.logoUrl,
        brandColor: college.tenant.brandColor,
      },
      needsApproval: policy.selfNeedsApproval,
      batches,
      programmes: programmes.all.map((p) => ({ id: p.id, label: p.label })),
      genders,
      // Name, email and a password are always asked; these are the rest.
      fields: selfFormFields(policy).map((f) => ({
        key: f.key,
        label: f.label,
        note: f.note,
        type: f.type,
        required: policy.fields[f.key] === 'required',
        min: f.min,
        max: f.max,
      })),
    });
  }),
);

const bodySchema = z.object({
  code: z.string().trim().min(1).max(32),
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  batchId: z.string().trim().max(40).optional(),
  /** Everything the policy asked for, as text - the same shape a sheet gives. */
  answers: z.record(z.string().trim().max(200)).default({}),
});

/**
 * POST /api/public/register
 *
 * Creates the account, the student record and their place in a batch
 * together, the same three rows a roster upload creates - so a student who
 * registered and a student the college entered are the same kind of thing
 * everywhere downstream.
 */
registerRouter.post(
  '/register',
  limiter,
  asyncHandler(async (req, res) => {
    const body = bodySchema.parse(req.body);
    const { college, policy } = await openCollege(body.code);

    const asked = selfFormFields(policy);
    const values: Record<string, unknown> = {};
    const problems: string[] = [];

    for (const field of asked) {
      const raw = body.answers[field.key];
      if (!raw?.trim()) {
        if (policy.fields[field.key] === 'required') problems.push(field.label.toLowerCase());
        continue;
      }
      const read = readCell(field, raw);
      if (read.ok) values[field.key] = read.value;
      else problems.push(read.reason);
    }

    if (problems.length > 0) throw badRequest(`Check these: ${problems.join('; ')}.`);

    // The same list the roster upload is held to, so one student cannot be
    // recorded as "M" and another as "Male".
    const gender = matchGender(
      typeof values.gender === 'string' ? values.gender : null,
      await activeGenders(),
    );
    if (!gender.ok) throw badRequest(gender.reason);

    // And the same programme check. A student who picks something their
    // college does not run is told so here rather than discovering it as
    // silence from every role for three years.
    const resolved = resolveProgramme(await programmeIndex(college.id), {
      programme: typeof values.programme === 'string' ? values.programme : null,
      course: typeof values.course === 'string' ? values.course : null,
      branch: typeof values.specialisation === 'string' ? values.specialisation : null,
    });
    if (resolved.problem) throw badRequest(resolved.problem);

    const batch = body.batchId
      ? await prisma.batch.findFirst({
          where: {
            id: body.batchId,
            OR: [{ collegeId: college.id }, { collegeId: null, tenantId: college.tenantId }],
          },
        })
      : null;
    if (body.batchId && !batch) throw badRequest('Pick a batch from the list.');

    const passwordHash = await hashPassword(body.password);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const dp2 = (v: unknown) =>
      typeof v === 'number' ? new Prisma.Decimal(v.toFixed(2)) : null;

    const user = await prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: body.email } })) {
        throw conflict('An account with that email address already exists. Sign in instead.');
      }

      const created = await tx.user.create({
        data: {
          email: body.email,
          fullName: body.fullName,
          phone: typeof values.phone === 'string' ? values.phone : null,
          passwordHash,
          role: 'CANDIDATE',
        },
      });

      const candidate = await tx.candidate.create({
        data: {
          userId: created.id,
          collegeId: college.id,
          course: resolved.course,
          specialisation: resolved.branch,
          collegeProgramId: resolved.programme?.id ?? null,
          graduationYear: num(values.graduationYear) ?? batch?.graduationYear ?? null,
          phone: typeof values.phone === 'string' ? values.phone : null,
          gender: gender.value,
          dateOfBirth: (values.dateOfBirth as Date | null) ?? null,
          prn: typeof values.prn === 'string' ? values.prn : null,
          cgpa: dp2(values.cgpa),
          degreePct: dp2(values.degreePct),
          tenthPct: dp2(values.tenthPct),
          twelfthPct: dp2(values.twelfthPct),
          diplomaPct: dp2(values.diplomaPct),
          pgCgpa: dp2(values.pgCgpa),
          pgPct: dp2(values.pgPct),
          isLateralEntry: (values.isLateralEntry as boolean | null) ?? false,
          backlogs: num(values.backlogs),
          activeBacklogs: num(values.activeBacklogs),
          gapYears: num(values.gapYears),
        },
      });

      /*
       * A batch they did not pick is the college's "Unassigned" group rather
       * than none at all: a student with no batch is on no roster screen, so
       * nobody would ever see them to check them.
       */
      const landing =
        batch ??
        (await tx.batch.findFirst({ where: { collegeId: college.id, name: UNASSIGNED } })) ??
        (await tx.batch.create({
          data: { collegeId: college.id, tenantId: college.tenantId, name: UNASSIGNED },
        }));

      await tx.batchMembership.create({
        data: {
          batchId: landing.id,
          candidateId: candidate.id,
          rollNo: typeof values.rollNo === 'string' ? values.rollNo : null,
          division: typeof values.division === 'string' ? values.division : null,
        },
      });

      return tx.user.findUniqueOrThrow({ where: { id: created.id }, include: SCOPE_INCLUDE });
    });

    // Signed in immediately: they can fill in the rest of their profile while
    // they wait. Applying still needs the college to verify them, which is
    // the same gate every student passes through.
    req.session.userId = user.id;
    req.session.role = user.role;

    res.status(201).json({
      user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role },
      needsApproval: policy.selfNeedsApproval,
    });
  }),
);
