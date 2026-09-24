import { Router } from 'express';
import { TenantStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { can } from '../roles/can.js';
import { getActiveUser } from '../auth/auth.service.js';
import { requirePlatform } from './tenant.context.js';
import { env } from '../../config/env.js';
import { imageUpload } from '../../lib/upload.js';
import { saveTenantAsset } from './assets.js';
import { describeSession } from './tenant.session.js';
import { CATEGORIES, MODULE_SCREENS, MODULES, PLANS, SCREENS, resolveModules } from './catalogue.js';
import {
  actAsSchema,
  academicsSchema,
  adminInviteSchema,
  collegesSchema,
  featuresSchema,
  attachBranchesSchema,
  batchesSchema,
  collegeInputSchema,
  bulkBranchesSchema,
  bulkCoursesSchema,
  identitySchema,
  newBranchSchema,
  newCourseSchema,
  slugSchema,
} from './onboarding.schemas.js';
import { createBatches, createBatchesFromMapping, createCollege, deleteBatch, deleteCollege, updateCollege } from './onboarding.structure.js';
import {
  completeOptionalStep,
  addBranch,
  addBranchesInBulk,
  addCourse,
  addCoursesInBulk,
  attachBranches,
  adminRoles,
  createTenant,
  inviteTenantAdmin,
  launchTenant,
  listTenants,
  onboardingState,
  revokeTenantInvite,
  saveAcademics,
  saveColleges,
  saveFeatures,
  setTenantStatus,
  slugAvailability,
  updateIdentity,
} from './onboarding.service.js';

/**
 * The platform console: where institutions are onboarded and looked after.
 *
 * Two fences, in order. requireRole('ADMIN') keeps out everyone who is not
 * operations; requirePlatform keeps out operations staff who belong to a
 * tenant, because a university's own admin must never see - let alone create -
 * other universities. Capabilities then narrow what platform staff may do:
 * onboarding is `college:write`, and switching a live institution on or off
 * is `settings:write`, a more senior call.
 */
export const platformRouter = Router();
platformRouter.use(requireRole('ADMIN'), requirePlatform);

/** GET /api/platform/tenants - every institution, for the console. */
platformRouter.get(
  '/tenants',
  can('college:read'),
  asyncHandler(async (_req, res) => {
    res.json({ tenants: await listTenants() });
  }),
);

/**
 * GET /api/platform/catalogue - everything the wizard offers to choose from,
 * in one request, so no step waits on a list to arrive.
 */
platformRouter.get(
  '/catalogue',
  can('college:read'),
  asyncHandler(async (_req, res) => {
    const [branches, courses, collegeTypes, states, naacGrades, roles] = await Promise.all([
      prisma.branch.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.course.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          specialisations: {
            where: { isActive: true },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, branchId: true },
          },
        },
      }),
      prisma.collegeType.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      prisma.refValue.findMany({
        where: { kind: 'STATE', isActive: true },
        orderBy: [{ position: 'asc' }, { value: 'asc' }],
        select: { value: true },
      }),
      prisma.refValue.findMany({
        where: { kind: 'NAAC_GRADE', isActive: true },
        orderBy: [{ position: 'asc' }, { value: 'asc' }],
        select: { value: true },
      }),
      adminRoles(),
    ]);

    res.json({
      categories: CATEGORIES,
      modules: MODULES,
      // The portal's tabs, and which tab each feature sits on - so a preview
      // can show features inside screens instead of as screens.
      screens: SCREENS,
      moduleScreens: MODULE_SCREENS,
      // Plans are sent already resolved, so the screen shows exactly the
      // modules a plan switches on, requirements included.
      plans: PLANS.map((p) => ({ ...p, modules: resolveModules(p.modules).enabled })),
      branches,
      courses,
      collegeTypes,
      states: states.map((s) => s.value),
      naacGrades: naacGrades.map((g) => g.value),
      adminRoles: roles,
      // Where the portal actually runs, so the address shown in the wizard is
      // the one people will type - not a made-up domain.
      portalBase: env.CLIENT_ORIGIN.replace(/\/+$/, ''),
    });
  }),
);

/** GET /api/platform/slug?value=sppu&exclude=<id> - is this address free? */
platformRouter.get(
  '/slug',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ value: z.string(), exclude: z.string().optional() })
      .parse(req.query);
    const parsed = slugSchema.safeParse(q.value);
    if (!parsed.success) {
      res.json({ valid: false, available: false, message: parsed.error.issues[0]?.message });
      return;
    }
    res.json({ valid: true, ...(await slugAvailability(parsed.data, q.exclude)) });
  }),
);

/**
 * POST /api/platform/uploads/:kind - a logo or favicon, before the tenant
 * necessarily exists. Returns the path to save on the tenant; the file is
 * only referenced once somebody saves the step.
 */
platformRouter.post(
  '/uploads/:kind',
  can('college:write'),
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'logo' && kind !== 'favicon') throw badRequest('Upload a logo or a favicon.');
    if (!req.file) throw badRequest('Choose an image to upload.');
    res.status(201).json({ url: await saveTenantAsset(kind, req.file.buffer) });
  }),
);

/**
 * POST /api/platform/branches - a branch for the master list. 200 with the
 * existing branch for the same name; 409 SIMILAR_BRANCH naming look-alikes
 * unless `confirm` is set.
 */
platformRouter.post(
  '/branches',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { branch, existed } = await addBranch(newBranchSchema.parse(req.body));
    res.status(existed ? 200 : 201).json({ branch, existed });
  }),
);

/** POST /api/platform/branches/bulk - a pasted list; look-alikes are held back, not added. */
platformRouter.post(
  '/branches/bulk',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { names } = bulkBranchesSchema.parse(req.body);
    res.json(await addBranchesInBulk(names));
  }),
);

/**
 * POST /api/platform/courses/bulk - a pasted list of courses and their
 * branches. `preview: true` (the default) changes nothing and says how every
 * branch name was read; `preview: false` does exactly that.
 */
platformRouter.post(
  '/courses/bulk',
  can('college:write'),
  asyncHandler(async (req, res) => {
    res.json(await addCoursesInBulk(bulkCoursesSchema.parse(req.body)));
  }),
);

/** POST /api/platform/courses/:id/branches - offer more master branches under a course. */
platformRouter.post(
  '/courses/:id/branches',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { branchIds } = attachBranchesSchema.parse(req.body);
    res.json({ course: await attachBranches(req.params.id!, branchIds) });
  }),
);

/**
 * POST /api/platform/courses - a course the catalogue is missing, added while
 * onboarding. Answers 200 with the existing course when the name is taken.
 */
platformRouter.post(
  '/courses',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { course, existed } = await addCourse(newCourseSchema.parse(req.body));
    res.status(existed ? 200 : 201).json({ course, existed });
  }),
);

/** POST /api/platform/tenants - step one creates the draft. */
platformRouter.post(
  '/tenants',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const tenant = await createTenant(identitySchema.parse(req.body), req.session.userId!);
    res.status(201).json({ tenant });
  }),
);

/** GET /api/platform/tenants/:id - the whole onboarding picture. */
platformRouter.get(
  '/tenants/:id',
  can('college:read'),
  asyncHandler(async (req, res) => {
    res.json(await onboardingState(req.params.id!));
  }),
);

/** PUT /api/platform/tenants/:id/identity */
platformRouter.put(
  '/tenants/:id/identity',
  can('college:write'),
  asyncHandler(async (req, res) => {
    await updateIdentity(req.params.id!, identitySchema.parse(req.body));
    res.json(await onboardingState(req.params.id!));
  }),
);

/** PUT /api/platform/tenants/:id/academics */
platformRouter.put(
  '/tenants/:id/academics',
  can('college:write'),
  asyncHandler(async (req, res) => {
    await saveAcademics(req.params.id!, academicsSchema.parse(req.body));
    res.json(await onboardingState(req.params.id!));
  }),
);

/** PUT /api/platform/tenants/:id/colleges */
platformRouter.put(
  '/tenants/:id/colleges',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const result = await saveColleges(
      req.params.id!,
      collegesSchema.parse(req.body),
      req.session.userId!,
    );
    res.json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/** POST /api/platform/tenants/:id/colleges - add one college. */
platformRouter.post(
  '/tenants/:id/colleges',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const result = await createCollege(req.params.id!, collegeInputSchema.parse(req.body), req.session.userId!);
    res.status(201).json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/** PUT /api/platform/tenants/:id/colleges/:collegeId - edit one college. */
platformRouter.put(
  '/tenants/:id/colleges/:collegeId',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const result = await updateCollege(
      req.params.id!,
      req.params.collegeId!,
      collegeInputSchema.parse(req.body),
      req.session.userId!,
    );
    res.json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/** DELETE /api/platform/tenants/:id/colleges/:collegeId - only an empty college. */
platformRouter.delete(
  '/tenants/:id/colleges/:collegeId',
  can('college:write'),
  asyncHandler(async (req, res) => {
    await deleteCollege(req.params.id!, req.params.collegeId!);
    res.json(await onboardingState(req.params.id!));
  }),
);

/** POST /api/platform/tenants/:id/batches - one batch, university-wide or per college. */
platformRouter.post(
  '/tenants/:id/batches',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    const result = await createBatches(req.params.id!, batchesSchema.parse(req.body));
    res.status(201).json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/**
 * POST /api/platform/tenants/:id/batches/from-mapping - one batch per mapped
 * college + course + branch, for each passing year chosen.
 */
platformRouter.post(
  '/tenants/:id/batches/from-mapping',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        graduationYears: z.array(z.number().int().min(2000).max(2100)).min(1, 'Choose at least one passing year.').max(10),
        collegeIds: z.array(z.string().min(1)).max(400).optional(),
      })
      .parse(req.body);
    const result = await createBatchesFromMapping(req.params.id!, input);
    res.status(201).json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/** DELETE /api/platform/tenants/:id/batches/:batchId - only a batch nobody is in. */
platformRouter.delete(
  '/tenants/:id/batches/:batchId',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    await deleteBatch(req.params.id!, req.params.batchId!);
    res.json(await onboardingState(req.params.id!));
  }),
);

/** POST /api/platform/tenants/:id/steps/:step/complete - pass an optional step. */
platformRouter.post(
  '/tenants/:id/steps/:step/complete',
  can('college:write'),
  asyncHandler(async (req, res) => {
    await completeOptionalStep(req.params.id!, req.params.step!);
    res.json(await onboardingState(req.params.id!));
  }),
);

/** PUT /api/platform/tenants/:id/features */
platformRouter.put(
  '/tenants/:id/features',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { selected, unverifiedCompanyAccess } = featuresSchema.parse(req.body);
    const result = await saveFeatures(req.params.id!, selected, { unverifiedCompanyAccess });
    res.json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/** POST /api/platform/tenants/:id/admins - invite somebody to run it. */
platformRouter.post(
  '/tenants/:id/admins',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const input = adminInviteSchema.parse(req.body);
    const result = await inviteTenantAdmin(
      req.params.id!,
      { ...input, roleId: input.roleId || undefined, phone: input.phone || undefined },
      req.session.userId!,
    );
    res.status(201).json({ ...(await onboardingState(req.params.id!)), result });
  }),
);

/** DELETE /api/platform/tenants/:id/admins/invites/:inviteId */
platformRouter.delete(
  '/tenants/:id/admins/invites/:inviteId',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    await revokeTenantInvite(req.params.id!, req.params.inviteId!);
    res.json(await onboardingState(req.params.id!));
  }),
);

/** POST /api/platform/tenants/:id/launch - the moment it goes live. */
platformRouter.post(
  '/tenants/:id/launch',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    await launchTenant(req.params.id!);
    res.json(await onboardingState(req.params.id!));
  }),
);

/** POST /api/platform/tenants/:id/status - suspend or reactivate. */
platformRouter.post(
  '/tenants/:id/status',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { status } = z
      .object({ status: z.enum([TenantStatus.ACTIVE, TenantStatus.SUSPENDED]) })
      .parse(req.body);
    await setTenantStatus(req.params.id!, status);
    res.json(await onboardingState(req.params.id!));
  }),
);

/**
 * POST /api/platform/act-as - step into an institution, or out of all of them.
 *
 * Only changes which tenant the session stands in; it never changes who the
 * person is or what they may do. Every admin screen then shows that
 * institution's rows and nobody else's.
 */
platformRouter.post(
  '/act-as',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const { tenantId } = actAsSchema.parse(req.body);

    if (tenantId) {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!tenant) throw notFound('That institution does not exist.');
      req.session.tenantId = tenant.id;
    } else {
      delete req.session.tenantId;
    }

    const user = await getActiveUser(req.session.userId!);
    res.json(await describeSession(req, user));
  }),
);
