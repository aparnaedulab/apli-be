import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { documentUpload } from '../../lib/upload.js';
import { isAssetRef, removeAsset, saveTenantAsset } from '../tenants/assets.js';
import { Prisma, ResumeSource } from '@prisma/client';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { badgesFor } from './badges.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { renderResume, resumeBuildSchema } from './resume.js';
import {
  assertVerifiedUnchanged,
  MAX_PROJECT_LINKS,
  loadProfile,
  serialiseProfile,
  setSkills,
} from './candidate.service.js';
import { ACCOMMODATIONS, PWD_CATEGORIES, TRAVEL, cleanKeys } from '../jobs/inclusion.js';

export const candidateRouter = Router();

candidateRouter.use(requireRole('CANDIDATE'));

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const basicsSchema = z.object({
  phone: optionalText(20),
  gender: optionalText(30),
  dateOfBirth: z.string().datetime().optional().or(z.literal('')),
  graduationYear: z.coerce.number().int().min(2000).max(2100).optional(),
  headline: optionalText(140),
  about: optionalText(2000),
  /*
   * One we stored for them, or a link they host themselves.
   *
   * A plain `.url()` refuses `/api/files/resume-....pdf`, which is what our
   * own upload hands back - the same trap a company logo fell into. Anything
   * that is neither is refused rather than put in front of a recruiter.
   */
  resumeUrl: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || isAssetRef(v) || /^https:\/\/\S+$/i.test(v),
      'Upload a PDF, or give an https link to your resume.',
    )
    .optional()
    .or(z.literal('')),
  /*
   * What a role's eligibility actually reads.
   *
   * Every bar a company can set has a column here, and until now the form
   * offered four of them - so a student could clear a role's diploma or
   * postgraduate bar on paper and be refused by it in the query, with
   * nowhere to put the number that would have let them through.
   */
  course: optionalText(120),
  specialisation: optionalText(120),
  cgpa: z.coerce.number().min(0).max(10).optional(),
  degreePct: z.coerce.number().min(0).max(100).optional(),
  tenthPct: z.coerce.number().min(0).max(100).optional(),
  twelfthPct: z.coerce.number().min(0).max(100).optional(),
  diplomaPct: z.coerce.number().min(0).max(100).optional(),
  pgCgpa: z.coerce.number().min(0).max(10).optional(),
  pgPct: z.coerce.number().min(0).max(100).optional(),
  backlogs: z.coerce.number().int().min(0).max(50).optional(),
  activeBacklogs: z.coerce.number().int().min(0).max(50).optional(),
  gapYears: z.coerce.number().int().min(0).max(20).optional(),
  isLateralEntry: z.boolean().optional(),

  /*
   * Declared, never inferred, and never a gate.
   *
   * A role states the groups it suits and the support it offers; these are
   * the same keys from the student's side, so the two can be matched. Unknown
   * keys are dropped rather than refused - a list that grows should not
   * invalidate a form somebody is halfway through.
   */
  isPwd: z.boolean().optional(),
  pwdCategories: z.array(z.string()).max(PWD_CATEGORIES.length).optional(),
  pwdPct: z.coerce.number().int().min(0).max(100).optional(),
  accommodations: z.array(z.string()).max(ACCOMMODATIONS.length).optional(),

  openToRelocate: z.boolean().optional(),
  openToNightShift: z.boolean().optional(),
  openToTravel: z.enum(TRAVEL).optional().or(z.literal('')),
});

const educationSchema = z.object({
  degree: z.string().trim().min(1, 'Enter the degree.').max(120),
  institution: z.string().trim().min(1, 'Enter the institution.').max(200),
  board: optionalText(120),
  startYear: z.coerce.number().int().min(1950).max(2100),
  endYear: z.coerce.number().int().min(1950).max(2100).optional(),
  cgpa: z.coerce.number().min(0).max(10).optional(),
  percentage: z.coerce.number().min(0).max(100).optional(),
});

const experienceSchema = z.object({
  title: z.string().trim().min(1, 'Enter the role.').max(140),
  organisation: z.string().trim().min(1, 'Enter the organisation.').max(200),
  location: optionalText(120),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional().or(z.literal('')),
  isCurrent: z.boolean().default(false),
  description: optionalText(2000),
});

const projectSchema = z.object({
  title: z.string().trim().min(1, 'Enter the project title.').max(140),
  description: optionalText(2000),
  /**
   * Where the work can be seen. A repository, a live demo, a write-up: one
   * project is routinely all three, and a single box made a student choose
   * which of them a recruiter got to follow.
   */
  links: z
    .array(
      z.object({
        url: z.string().trim().url('Enter a valid link, including https://.'),
        label: z.string().trim().max(40, 'Keep the label short.').optional().or(z.literal('')),
      }),
    )
    .max(MAX_PROJECT_LINKS, `${MAX_PROJECT_LINKS} links is the most a project shows.`)
    .optional(),
  startDate: z.string().datetime().optional().or(z.literal('')),
  endDate: z.string().datetime().optional().or(z.literal('')),
});

/**
 * Points the profile at one of their resumes.
 *
 * `Candidate.resumeUrl` stays the single field everything else reads - an
 * application, a recruiter, the completion check - so adding a list did not
 * mean teaching all of them about it.
 */
async function useResume(
  candidateId: string,
  resume: { url: string; build: unknown },
): Promise<ReturnType<typeof serialiseProfile>> {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      resumeUrl: resume.url,
      resumeBuild: (resume.build ?? Prisma.DbNull) as Prisma.InputJsonValue,
    },
  });
  return serialiseProfile(await loadProfile(candidateId));
}

/** Something recognisable when they have not named it themselves. */
function defaultName(build: { layout?: string }): string {
  const when = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `${(build.layout ?? 'classic').replace(/^./, (c) => c.toUpperCase())} - ${when}`;
}

const nullable = (v: string | undefined) => (v ? v : null);
const nullableDate = (v: string | undefined) => (v ? new Date(v) : null);

/** GET /api/candidate/profile */
candidateRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const candidate = await loadProfile(requireCandidateId(req));
    res.json({ profile: serialiseProfile(candidate) });
  }),
);

/**
 * GET /api/candidate/badges
 *
 * Derived on read from rows that already exist, never stored: a second copy
 * of a fact is a fact that can drift from it.
 */
candidateRouter.get(
  '/badges',
  asyncHandler(async (req, res) => {
    res.json({ badges: await badgesFor(requireCandidateId(req)) });
  }),
);

/** PATCH /api/candidate/profile — the basics block */
candidateRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const data = basicsSchema.parse(req.body);

    /*
     * A verified student keeps writing their own half of this block. What
     * their college checked is refused only if they actually tried to move
     * it - see assertVerifiedUnchanged.
     */
    await assertVerifiedUnchanged(candidateId, {
      graduationYear: data.graduationYear,
      cgpa: data.cgpa,
      tenthPct: data.tenthPct,
      twelfthPct: data.twelfthPct,
      backlogs: data.backlogs,
    });

    /*
     * Nothing is written unless it was actually sent.
     *
     * `?? null` meant a block that left a field out cleared it - so saving
     * just a resume link wiped the phone number, the headline and the marks
     * along with it. Absent now means "not mentioned", which is what leaving
     * a field out has always meant; clearing one is done by sending it empty.
     */
    const given = <K extends keyof typeof data>(key: K, as?: (v: (typeof data)[K]) => unknown) =>
      data[key] === undefined ? {} : { [key]: as ? as(data[key]) : data[key] };

    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        ...given('phone', nullable),
        ...given('gender', nullable),
        ...given('dateOfBirth', nullableDate),
        ...given('headline', nullable),
        ...given('about', nullable),
        ...given('resumeUrl', nullable),
        ...given('graduationYear'),
        ...given('course', nullable),
        ...given('specialisation', nullable),
        ...given('cgpa'),
        ...given('degreePct'),
        ...given('tenthPct'),
        ...given('twelfthPct'),
        ...given('diplomaPct'),
        ...given('pgCgpa'),
        ...given('pgPct'),
        ...given('backlogs'),
        ...given('activeBacklogs'),
        ...given('gapYears'),
        ...given('isLateralEntry'),

        // Keys are filtered against the list rather than trusted, so a
        // renamed or retired group cannot be stored and later read as one
        // that still exists.
        ...given('isPwd'),
        ...given('pwdCategories', (v) => cleanKeys(v, PWD_CATEGORIES)),
        ...given('pwdPct'),
        ...given('accommodations', (v) => cleanKeys(v, ACCOMMODATIONS)),
        ...given('openToRelocate'),
        ...given('openToNightShift'),
        ...given('openToTravel', nullable),
      },
    });

    res.json({ profile: serialiseProfile(await loadProfile(candidateId)) });
  }),
);

/**
 * POST /api/candidate/resume - a PDF, stored and handed back as an address.
 *
 * Nothing on the profile changes until the basics block is saved with that
 * address, so an abandoned upload leaves the old resume in place rather than
 * a half-changed profile.
 */
candidateRouter.post(
  '/resume',
  documentUpload.single('file'),
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    if (!req.file) throw badRequest('Choose a file to upload.');

    const url = await saveTenantAsset('resume', req.file.buffer);
    // Named after the file they chose, since that is what they will recognise
    // it by; the extension is ours and says nothing they need.
    const name = (req.file.originalname || 'Uploaded resume').replace(/\.pdf$/i, '').slice(0, 80);

    const resume = await prisma.resume.create({
      data: { candidateId, name: name || 'Uploaded resume', url, source: ResumeSource.UPLOADED },
    });

    res.status(201).json({ url, resume, profile: await useResume(candidateId, resume) });
  }),
);

/** GET /api/candidate/resumes - everything they keep, newest first. */
candidateRouter.get(
  '/resumes',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    res.json({
      resumes: await prisma.resume.findMany({
        where: { candidateId },
        orderBy: { createdAt: 'desc' },
      }),
    });
  }),
);

/** PATCH /api/candidate/resumes/:id - use this one, or rename it. */
candidateRouter.patch(
  '/resumes/:id',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { name, use } = z
      .object({ name: z.string().trim().min(1).max(80).optional(), use: z.boolean().optional() })
      .parse(req.body);

    const resume = await prisma.resume.findFirst({ where: { id: req.params.id, candidateId } });
    if (!resume) throw notFound('No such resume.');

    const updated = name ? await prisma.resume.update({ where: { id: resume.id }, data: { name } }) : resume;

    res.json({
      resume: updated,
      profile: use ? await useResume(candidateId, updated) : serialiseProfile(await loadProfile(candidateId)),
    });
  }),
);

/**
 * DELETE /api/candidate/resumes/:id - and the file with it.
 *
 * The file goes too, rather than being left on disk with nothing pointing at
 * it. If it was the one in use, the newest of what is left takes over - a
 * profile with resumes on it should not end up pointing at none of them.
 */
candidateRouter.delete(
  '/resumes/:id',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);

    const resume = await prisma.resume.findFirst({ where: { id: req.params.id, candidateId } });
    if (!resume) throw notFound('No such resume.');

    await prisma.resume.delete({ where: { id: resume.id } });
    await removeAsset(resume.url);

    const current = await prisma.candidate.findUniqueOrThrow({
      where: { id: candidateId },
      select: { resumeUrl: true },
    });

    if (current.resumeUrl === resume.url) {
      const next = await prisma.resume.findFirst({
        where: { candidateId },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { resumeUrl: next?.url ?? null, resumeBuild: next?.build ?? Prisma.DbNull },
      });
    }

    res.json({ profile: serialiseProfile(await loadProfile(candidateId)) });
  }),
);

/**
 * POST /api/candidate/resume/preview - the same PDF, not kept.
 *
 * The preview is the real renderer's output rather than a drawing of what it
 * might do. A second layout built in HTML to look like the PDF is a second
 * layout to keep in step, and the one that drifts is always the one being
 * looked at - so there is only ever one of them.
 *
 * Nothing is stored and nothing on the profile changes: a student trying
 * layouts is not making a decision yet.
 */
candidateRouter.post(
  '/resume/preview',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const build = resumeBuildSchema.parse(req.body);

    const pdf = await renderResume(await loadProfile(candidateId), build);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    // Never a stored file, so never cached as one.
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }),
);

/**
 * POST /api/candidate/resume/build - a resume made from their own profile.
 *
 * Built and then used in one step: the file is stored and set as their
 * resume, because a student who has just pressed Build has said what they
 * want. Their choices are kept so coming back to change one line does not
 * mean making every choice again.
 */
candidateRouter.post(
  '/resume/build',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const build = resumeBuildSchema.parse(req.body);

    const profile = await loadProfile(candidateId);
    const pdf = await renderResume(profile, build);
    const url = await saveTenantAsset('resume', pdf);

    const resume = await prisma.resume.create({
      data: {
        candidateId,
        name: (req.body?.name as string | undefined)?.trim().slice(0, 80) || defaultName(build),
        url,
        source: ResumeSource.BUILT,
        build,
      },
    });

    res.status(201).json({ url, resume, profile: await useResume(candidateId, resume) });
  }),
);

/** PUT /api/candidate/skills */
candidateRouter.put(
  '/skills',
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { skills } = z.object({ skills: z.array(z.string()).max(60) }).parse(req.body);

    await setSkills(candidateId, skills);
    res.json({ profile: serialiseProfile(await loadProfile(candidateId)) });
  }),
);

/* --- repeating sections ---------------------------------------------------
   Education, experience and projects are the same shape of operation three
   times over, so they share one factory rather than three near-identical
   blocks of route handlers.
-------------------------------------------------------------------------- */

type SectionName = 'education' | 'experience' | 'project';

function mountSection<S extends z.ZodTypeAny>(
  path: string,
  name: SectionName,
  schema: S,
  toData: (input: z.infer<S>) => Record<string, unknown>,
) {
  const model = {
    education: prisma.education,
    experience: prisma.experience,
    project: prisma.project,
  }[name] as {
    create: (a: unknown) => Promise<unknown>;
    updateMany: (a: unknown) => Promise<{ count: number }>;
    deleteMany: (a: unknown) => Promise<{ count: number }>;
  };

  candidateRouter.post(
    path,
    asyncHandler(async (req, res) => {
      const candidateId = requireCandidateId(req);
      const input = schema.parse(req.body);

      await model.create({ data: { ...toData(input), candidateId } });
      res.status(201).json({ profile: serialiseProfile(await loadProfile(candidateId)) });
    }),
  );

  candidateRouter.patch(
    `${path}/:id`,
    asyncHandler(async (req, res) => {
      const candidateId = requireCandidateId(req);
      const input = schema.parse(req.body);

      // Scoped by candidateId as well as id, so one student cannot edit
      // another student's row by guessing its id.
      const result = await model.updateMany({
        where: { id: req.params.id, candidateId },
        data: toData(input),
      });
      if (result.count === 0) throw notFound('That entry does not exist.');

      res.json({ profile: serialiseProfile(await loadProfile(candidateId)) });
    }),
  );

  candidateRouter.delete(
    `${path}/:id`,
    asyncHandler(async (req, res) => {
      const candidateId = requireCandidateId(req);

      const result = await model.deleteMany({ where: { id: req.params.id, candidateId } });
      if (result.count === 0) throw notFound('That entry does not exist.');

      res.json({ profile: serialiseProfile(await loadProfile(candidateId)) });
    }),
  );
}

mountSection('/education', 'education', educationSchema, (d) => ({
  degree: d.degree,
  institution: d.institution,
  board: nullable(d.board),
  startYear: d.startYear,
  endYear: d.endYear ?? null,
  cgpa: d.cgpa ?? null,
  percentage: d.percentage ?? null,
}));

mountSection('/experience', 'experience', experienceSchema, (d) => ({
  title: d.title,
  organisation: d.organisation,
  location: nullable(d.location),
  startDate: new Date(d.startDate),
  endDate: nullableDate(d.endDate),
  isCurrent: d.isCurrent,
  description: nullable(d.description),
}));

mountSection('/projects', 'project', projectSchema, (d) => ({
  title: d.title,
  description: nullable(d.description),
  // A label nobody typed is dropped rather than stored empty, so a link
  // carries either words worth reading or none at all.
  links: (d.links ?? []).map((l) => ({ url: l.url, ...(l.label ? { label: l.label } : {}) })),
  startDate: nullableDate(d.startDate),
  endDate: nullableDate(d.endDate),
}));
