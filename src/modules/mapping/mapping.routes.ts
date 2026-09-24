import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requirePlatform, requireTenantId } from '../tenants/tenant.context.js';
import { loadTenant, markStepById } from '../tenants/onboarding.service.js';
import { addStudents, type AddStudentsResult, type StudentRow } from '../campus/students.service.js';
import { buildStudentTemplate } from '../campus/students.template.js';
import { rowsFromRequest } from '../campus/students.intake.js';
import { asWorkbook, workbookUpload } from '../../lib/upload.js';
import {
  catalogue,
  setUniversityPrograms,
  universityPrograms,
  collegeOf,
  collegePrograms,
  listStudents,
  mapStudents,
  mappingOverview,
  mappingSummary,
  offeredPrograms,
  setCollegePrograms,
  unmapStudents,
} from './mapping.service.js';

/**
 * Map data, twice: once for the university, across every college it has, and
 * once for a college, over itself. Same service, same rules; the college
 * routes simply fix the college to the caller's own and never offer the
 * university's unplaced students.
 */

const programsSchema = z.object({
  programs: z
    .array(
      z.object({
        courseId: z.string().trim().min(1),
        branchId: z.string().trim().min(1).nullable(),
        intake: z.number().int().min(0).max(100_000).nullable().optional(),
      }),
    )
    .max(500),
});

const studentQuerySchema = z.object({
  programId: z.string().trim().optional(),
  status: z.enum(['mapped', 'unmapped', 'all']).default('all'),
  includeUnplaced: z.enum(['true', 'false']).default('false'),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const idsSchema = z.object({
  candidateIds: z.array(z.string().trim().min(1)).min(1, 'Choose at least one student.').max(500),
});

/* -------------------------------------------------------------------------- */
/* University: /api/admin/mapping                                              */
/* -------------------------------------------------------------------------- */

export const adminMappingRouter = Router();
adminMappingRouter.use(requireRole('ADMIN'));

/** GET /api/admin/mapping — every college, and how far along its mapping is. */
adminMappingRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const [overview, offered] = await Promise.all([mappingOverview(tenantId), offeredPrograms(tenantId)]);
    res.json({ ...overview, offered });
  }),
);

/**
 * GET /api/admin/mapping/offered — the university's own courses and branches,
 * and the platform catalogue it picks them from.
 */
adminMappingRouter.get(
  '/offered',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const [all, programs] = await Promise.all([catalogue(), universityPrograms(tenantId)]);
    res.json({ catalogue: all, programs });
  }),
);

/** PUT /api/admin/mapping/offered */
adminMappingRouter.put(
  '/offered',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { programs } = programsSchema.parse(req.body);
    res.json({ programs: await setUniversityPrograms(requireTenantId(req), programs) });
  }),
);

/** GET /api/admin/mapping/summary — everything mapped so far. */
adminMappingRouter.get(
  '/summary',
  can('college:read'),
  asyncHandler(async (req, res) => {
    res.json({ colleges: await mappingSummary(requireTenantId(req)) });
  }),
);

/** GET /api/admin/mapping/colleges/:id/programs */
adminMappingRouter.get(
  '/colleges/:id/programs',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const college = await collegeOf(requireTenantId(req), req.params.id!);
    res.json({ college, programs: await collegePrograms(college.id) });
  }),
);

/** PUT /api/admin/mapping/colleges/:id/programs — the full set, replacing what was there. */
adminMappingRouter.put(
  '/colleges/:id/programs',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const college = await collegeOf(tenantId, req.params.id!);
    const { programs } = programsSchema.parse(req.body);
    res.json({ college, programs: await setCollegePrograms(tenantId, college.id, programs) });
  }),
);

/** GET /api/admin/mapping/colleges/:id/students */
adminMappingRouter.get(
  '/colleges/:id/students',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const college = await collegeOf(tenantId, req.params.id!);
    const q = studentQuerySchema.parse(req.query);
    res.json(
      await listStudents(tenantId, {
        ...q,
        collegeId: college.id,
        includeUnplaced: q.includeUnplaced === 'true',
      }),
    );
  }),
);

/** GET /api/admin/mapping/unplaced — students added with no college. */
adminMappingRouter.get(
  '/unplaced',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const q = studentQuerySchema.parse(req.query);
    res.json(await listStudents(requireTenantId(req), { ...q, status: 'all', includeUnplaced: true }));
  }),
);

/** POST /api/admin/mapping/programs/:id/students — map these students into this programme. */
adminMappingRouter.post(
  '/programs/:id/students',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const { candidateIds } = idsSchema.parse(req.body);
    res.json(await mapStudents(requireTenantId(req), req.params.id!, candidateIds));
  }),
);

/** POST /api/admin/mapping/unmap */
adminMappingRouter.post(
  '/unmap',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const { candidateIds } = idsSchema.parse(req.body);
    res.json(await unmapStudents(requireTenantId(req), candidateIds));
  }),
);

/**
 * POST /api/admin/mapping/students — the university's own student upload.
 *
 * Every row may name its college by code, or leave it blank. Rows with a
 * college go onto that college's roster (and straight into a programme where
 * their course and branch match one); rows without wait, unplaced, until Map
 * data puts them somewhere.
 */
adminMappingRouter.post(
  '/students',
  can('student:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const rows = await rowsFromRequest(req);
    res.status(201).json(await addUniversityStudents(tenantId, rows, req.session.userId!));
  }),
);

/** GET /api/admin/mapping/students/template — with a College code column. */
adminMappingRouter.get(
  '/students/template',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const colleges = await prisma.college.findMany({
      where: { tenantId: requireTenantId(req) },
      orderBy: { code: 'asc' },
      select: { code: true },
    });
    const buffer = await buildStudentTemplate({ collegeCodes: colleges.map((c) => c.code) });
    res.set(asWorkbook('University students.xlsx')).send(Buffer.from(buffer));
  }),
);

async function addUniversityStudents(
  tenantId: string,
  rows: StudentRow[],
  sentById: string,
): Promise<AddStudentsResult> {
  const colleges = await prisma.college.findMany({
    where: { tenantId },
    select: { id: true, code: true, name: true },
  });
  const byKey = new Map<string, string>();
  for (const c of colleges) {
    byKey.set(c.code.toLowerCase(), c.id);
    byKey.set(c.name.toLowerCase(), c.id);
  }

  const result: AddStudentsResult = { created: [], skipped: [], batchesCreated: [] };
  const groups = new Map<string | null, StudentRow[]>();

  for (const row of rows) {
    const named = row.college?.trim();
    const collegeId = named ? byKey.get(named.toLowerCase()) : null;
    if (named && !collegeId) {
      result.skipped.push({
        email: row.email || row.fullName || '(blank row)',
        reason: `No college with the code "${named}"`,
      });
      continue;
    }
    const key = collegeId ?? null;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const [collegeId, group] of groups) {
    const part = await addStudents(collegeId, group, sentById, { tenantId });
    result.created.push(...part.created);
    result.skipped.push(...part.skipped);
    result.batchesCreated.push(...part.batchesCreated);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* College: /api/campus/mapping                                                */
/* -------------------------------------------------------------------------- */

export const campusMappingRouter = Router();
campusMappingRouter.use(requireRole('CAMPUS'));

/** The college's institution, read from the college rather than trusted from the session. */
async function campusScope(req: Request) {
  const collegeId = requireCollegeId(req);
  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: { id: true, name: true, code: true, tenantId: true },
  });
  if (!college) throw badRequest('This account is not linked to a college.');
  return college;
}

/** GET /api/campus/mapping — what the university offers, and what this college runs. */
campusMappingRouter.get(
  '/',
  can('batch:read'),
  asyncHandler(async (req, res) => {
    const college = await campusScope(req);
    const [offered, programs, total, mapped] = await Promise.all([
      offeredPrograms(college.tenantId),
      collegePrograms(college.id),
      prisma.candidate.count({ where: { collegeId: college.id } }),
      prisma.candidate.count({ where: { collegeId: college.id, collegeProgramId: { not: null } } }),
    ]);
    res.json({
      college: { id: college.id, name: college.name, code: college.code },
      offered,
      programs,
      students: total,
      mapped,
    });
  }),
);

/** PUT /api/campus/mapping/programs */
campusMappingRouter.put(
  '/programs',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    const college = await campusScope(req);
    const { programs } = programsSchema.parse(req.body);
    res.json({ programs: await setCollegePrograms(college.tenantId, college.id, programs) });
  }),
);

/** GET /api/campus/mapping/students */
campusMappingRouter.get(
  '/students',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const college = await campusScope(req);
    const q = studentQuerySchema.parse(req.query);
    res.json(await listStudents(college.tenantId, { ...q, collegeId: college.id, includeUnplaced: false }));
  }),
);

/** POST /api/campus/mapping/programs/:id/students */
campusMappingRouter.post(
  '/programs/:id/students',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const college = await campusScope(req);
    const { candidateIds } = idsSchema.parse(req.body);
    res.json(
      await mapStudents(college.tenantId, req.params.id!, candidateIds, { ownCollegeOnly: college.id }),
    );
  }),
);

/** POST /api/campus/mapping/unmap */
campusMappingRouter.post(
  '/unmap',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const college = await campusScope(req);
    const { candidateIds } = idsSchema.parse(req.body);
    res.json(await unmapStudents(college.tenantId, candidateIds, { ownCollegeOnly: college.id }));
  }),
);

/* -------------------------------------------------------------------------- */
/* Platform onboarding: /api/platform/tenants/:tenantId/mapping                */
/* -------------------------------------------------------------------------- */

/**
 * The same university-side mapping, for the platform team inside the
 * onboarding wizard. The wizard names its institution in the path rather
 * than stepping into it, so these read the tenant from there.
 */
export const platformMappingRouter = Router({ mergeParams: true });
platformMappingRouter.use(requireRole('ADMIN'));
platformMappingRouter.use(requirePlatform);

async function wizardTenant(req: Request): Promise<string> {
  const tenant = await loadTenant(String(req.params.tenantId ?? ''));
  return tenant.id;
}

/** GET /api/platform/tenants/:tenantId/mapping */
platformMappingRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const tenantId = await wizardTenant(req);
    const [overview, offered] = await Promise.all([mappingOverview(tenantId), offeredPrograms(tenantId)]);
    res.json({ ...overview, offered });
  }),
);

platformMappingRouter.get(
  '/summary',
  can('college:read'),
  asyncHandler(async (req, res) => {
    res.json({ colleges: await mappingSummary(await wizardTenant(req)) });
  }),
);

platformMappingRouter.get(
  '/colleges/:id/programs',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const college = await collegeOf(await wizardTenant(req), req.params.id!);
    res.json({ college, programs: await collegePrograms(college.id) });
  }),
);

platformMappingRouter.put(
  '/colleges/:id/programs',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const tenantId = await wizardTenant(req);
    const college = await collegeOf(tenantId, req.params.id!);
    const { programs } = programsSchema.parse(req.body);
    const saved = await setCollegePrograms(tenantId, college.id, programs);
    if (saved.length > 0) await markStepById(tenantId, 'mapping');
    res.json({ college, programs: saved });
  }),
);

platformMappingRouter.get(
  '/colleges/:id/students',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const tenantId = await wizardTenant(req);
    const college = await collegeOf(tenantId, req.params.id!);
    const q = studentQuerySchema.parse(req.query);
    res.json(
      await listStudents(tenantId, { ...q, collegeId: college.id, includeUnplaced: q.includeUnplaced === 'true' }),
    );
  }),
);

platformMappingRouter.post(
  '/programs/:id/students',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const { candidateIds } = idsSchema.parse(req.body);
    res.json(await mapStudents(await wizardTenant(req), req.params.id!, candidateIds));
  }),
);

platformMappingRouter.post(
  '/unmap',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const { candidateIds } = idsSchema.parse(req.body);
    res.json(await unmapStudents(await wizardTenant(req), candidateIds));
  }),
);
