import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { documentUpload } from '../../lib/upload.js';
import { isAssetRef, removeAsset, saveTenantAsset } from '../tenants/assets.js';
import { Prisma, RecordSource, ResumeSource } from '@prisma/client';
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
import { programByNames, programsForCandidate } from '../mapping/mapping.service.js';
import { sharedBasicsShape, type SharedBasics } from '../students/schema.js';
import { activeGenders, matchGender } from '../students/lists.js';

export const candidateRouter = Router();

candidateRouter.use(requireRole('CANDIDATE'));

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/**
 * The basics block.
 *
 * Two halves. The first is generated from the student field registry: every
 * fact a college could also have put on a class list, bounded by exactly the
 * rules the upload uses. The second is written out here, because it is the
 * part only a student can ever set and so has no second door to agree with.
 */
const basicsSchema = z.object({
  /* --- the same facts the class-list upload carries --------------------- */
  ...(sharedBasicsShape as Record<string, z.ZodTypeAny>),

  /* --- and the part that is theirs alone --------------------------------- */
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
   * Declared, never inferred, and never a gate.
   *
   * A role states the groups it suits and the support it offers; these are
   * the same keys from the student's side, so the two can be matched. Unknown
   * keys are dropped rather than refused - a list that grows should not
   * invalidate a form somebody is halfway through.
   *
   * Not on the class-list upload, deliberately: this is the student's own
   * declaration, and a disability recorded off a departmental spreadsheet is
   * not one anybody consented to share.
   */
  isPwd: z.boolean().optional(),
  pwdCategories: z.array(z.string()).max(PWD_CATEGORIES.length).optional(),
  pwdPct: z.coerce.number().int().min(0).max(100).optional(),
  accommodations: z.array(z.string()).max(ACCOMMODATIONS.length).optional(),

  openToRelocate: z.boolean().optional(),
  openToNightShift: z.boolean().optional(),
  openToTravel: z.enum(TRAVEL).optional().or(z.literal('')),
}) as unknown as z.ZodType<
  SharedBasics & {
    headline?: string;
    about?: string;
    resumeUrl?: string;
    isPwd?: boolean;
    pwdCategories?: string[];
    pwdPct?: number;
    accommodations?: string[];
    openToRelocate?: boolean;
    openToNightShift?: boolean;
    openToTravel?: (typeof TRAVEL)[number] | '';
  }
>;

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

/**
 * What `collegeProgramId` should become when the course or branch is saved.
 *
 * Returns the patch to merge in, which is `{}` when neither name was sent -
 * a student saving their backlogs is not restating their course, and must
 * not have their mapping rewritten as a side effect of it.
 *
 * A college with no programmes mapped yet has nothing to check against, so
 * the names are taken as given and the link is left alone. Once it has any,
 * the pair must be one of them: a course its college does not run is a
 * course that fails every role's criterion, and refusing it here is the only
 * place a student ever finds that out.
 */
async function programFor(
  candidateId: string,
  course: string | undefined,
  branch: string | undefined,
): Promise<{ collegeProgramId?: string | null }> {
  if (course === undefined && branch === undefined) return {};

  const candidate = await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    select: { collegeId: true, course: true, specialisation: true },
  });
  if (!candidate.collegeId) return {};

  // Either one may be absent; the other is whatever is already stored.
  const wantCourse = (course ?? candidate.course ?? '').trim();
  const wantBranch = (branch ?? candidate.specialisation ?? '').trim() || null;
  if (!wantCourse) return { collegeProgramId: null };

  const { source } = await programsForCandidate(candidateId);
  if (source !== 'college') return {};

  const program = await programByNames(candidate.collegeId, wantCourse, wantBranch);
  if (!program) {
    throw badRequest(
      wantBranch
        ? `Your college does not run ${wantCourse} – ${wantBranch}. Pick one of its programmes, or ask your placement cell to add it.`
        : `Choose the branch of ${wantCourse} you are on.`,
    );
  }

  return { collegeProgramId: program.id };
}

/** GET /api/candidate/profile */
candidateRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const candidate = await loadProfile(requireCandidateId(req));
    res.json({ profile: serialiseProfile(candidate) });
  }),
);

/**
 * GET /api/candidate/programs
 *
 * The courses and branches this student may say they are on.
 *
 * Separate from `/api/catalogue`, which is every course on the platform and
 * right for the screens that keep that list. A student is on one of their own
 * college's programmes; offering them the platform's is offering a course
 * nobody at their college has ever studied, which then matches no role and
 * explains nothing. `source` says whose list came back, so the form knows
 * whether it may still let somebody type their own.
 */
candidateRouter.get(
  '/programs',
  asyncHandler(async (req, res) => {
    res.json(await programsForCandidate(requireCandidateId(req)));
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
    await assertVerifiedUnchanged(candidateId, data as Record<string, unknown>);

    /*
     * Gender, against the list operations keeps.
     *
     * The form has offered that list as a dropdown for a long time, but
     * nothing checked what actually arrived - and a role open to one gender
     * groups on the recorded spelling, so "M" where the list says "Male"
     * made that role invisible to them. Rewritten to the list's spelling for
     * the same reason.
     */
    let gender = data.gender;
    if (gender !== undefined) {
      const matched = matchGender(gender || null, await activeGenders());
      if (!matched.ok) throw badRequest(matched.reason);
      gender = matched.value ?? '';
    }

    /*
     * The course and branch, checked against the programmes their college
     * actually runs, and the Map data link moved with them.
     *
     * These two names are not decoration: every eligibility check reads them
     * (jobs/visibility.ts), and `collegeProgramId` is what a college's
     * reports count by. Writing the names straight through left the two
     * disagreeing - the link said CSE, the names said Mechanical - and
     * nothing anywhere said so. A college that has mapped its programmes
     * gets a closed list; one that has not is left free to type, because the
     * alternative is a student who cannot record their own course at all.
     */
    const program = await programFor(candidateId, data.course, data.specialisation);

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
        ...(gender === undefined ? {} : { gender: nullable(gender) }),
        ...given('dateOfBirth', nullableDate),
        ...given('headline', nullable),
        ...given('about', nullable),
        ...given('resumeUrl', nullable),
        ...given('graduationYear'),
        ...given('course', nullable),
        ...given('specialisation', nullable),
        ...program,
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
  /** Runs before an edit or a delete, and throws if the row is not theirs. */
  guard?: (candidateId: string, id: string) => Promise<void>,
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
      await guard?.(candidateId, req.params.id!);

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
      await guard?.(candidateId, req.params.id!);

      const result = await model.deleteMany({ where: { id: req.params.id, candidateId } });
      if (result.count === 0) throw notFound('That entry does not exist.');

      res.json({ profile: serialiseProfile(await loadProfile(candidateId)) });
    }),
  );
}

mountSection(
  '/education',
  'education',
  educationSchema,
  (d) => ({
    degree: d.degree,
    institution: d.institution,
    board: nullable(d.board),
    startYear: d.startYear,
    endYear: d.endYear ?? null,
    cgpa: d.cgpa ?? null,
    percentage: d.percentage ?? null,
  }),
  /*
   * A qualification the college entered is not the student's to remove.
   *
   * It is the same fact as the verified marks, arriving through the same
   * door - and the marks are locked while the row carrying the evidence for
   * them was not, so a student could delete it and write their own. The
   * refusal says who to ask rather than only saying no.
   */
  async (candidateId, id) => {
    const row = await prisma.education.findFirst({
      where: { id, candidateId },
      select: { source: true, degree: true },
    });
    if (row?.source === RecordSource.COLLEGE) {
      throw conflict(
        `${row.degree} was entered by your college, so it is part of your verified record and cannot be changed here. Ask your placement cell if it is wrong.`,
      );
    }
  },
);

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
