import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { InviteKind, RoleScope } from '@prisma/client';
import { usableRole } from '../roles/usableRole.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { addStudents } from '../campus/students.service.js';
import { buildStudentTemplate } from '../campus/students.template.js';
import { rowsFromRequest } from '../campus/students.intake.js';
import { asWorkbook, workbookUpload } from '../../lib/upload.js';
import { addColleges, homeUniversityOf, parseCollegeRows } from './colleges.bulk.js';
import { collegeQuerySchema, listColleges } from './colleges.list.js';
import {
  batchSchema,
  deriveBatchName,
  toBatchData,
  uniqueBatchName,
} from '../campus/batch.schemas.js';
import { buildCollegeTemplate, parseCollegeWorkbook } from './colleges.template.js';
import multer from 'multer';
import { can } from '../roles/can.js';
import { requireTenantId } from '../tenants/tenant.context.js';

export const collegesRouter = Router();

// Layer 2: the whole router is operations-only. No handler re-checks this.
collegesRouter.use(requireRole('ADMIN'));

/**
 * A college, but only if it belongs to the institution this session is
 * acting in. Everything below that takes an id in the path goes through here,
 * so another tenant's college answers exactly like one that does not exist.
 */
async function ownCollege(req: Parameters<typeof requireTenantId>[0], id: string | undefined) {
  const college = await prisma.college.findFirst({
    where: { id: id ?? '', tenantId: requireTenantId(req) },
  });
  if (!college) throw notFound('No such college.');
  return college;
}

const blank = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const collegeSchema = z.object({
  // Required: without these the record is not usable by anyone downstream.
  name: z.string().trim().min(2, 'Enter the college name.').max(200),
  code: z
    .string()
    .trim()
    .min(2, 'Enter a short code, for example PICT.')
    .max(16, 'Keep the code short.')
    .regex(/^[A-Za-z0-9.-]+$/, 'Letters, numbers, dots and hyphens only.')
    .transform((v) => v.toUpperCase()),
  city: z.string().trim().min(2, 'Enter the city.').max(120),
  state: z.string().trim().min(2, 'Enter the state.').max(120),

  // Optional profile.
  collegeTypeId: z.string().trim().optional().or(z.literal('')),
  affiliation: blank(200),
  address: blank(400),
  pincode: blank(12),
  naacGrade: blank(8),
});

const nil = (v: string | undefined) => (v ? v : null);

/** A retired type stays on the colleges that have it, but cannot be chosen anew. */
async function assertTypeUsable(id: string | undefined): Promise<void> {
  if (!id) return;
  const type = await prisma.collegeType.findUnique({ where: { id } });
  if (!type) throw notFound('That college type does not exist.');
  if (!type.isActive) throw conflict(`${type.name} has been retired and cannot be chosen.`);
}

const toCollegeData = (d: z.infer<typeof collegeSchema>) => ({
  name: d.name,
  code: d.code,
  city: d.city,
  state: d.state,
  collegeTypeId: nil(d.collegeTypeId),
  affiliation: nil(d.affiliation),
  address: nil(d.address),
  pincode: nil(d.pincode),
  naacGrade: nil(d.naacGrade),
});

/** One row of a class list. Only name, email and mobile are required. */
const studentRowSchema = z.object({
  fullName: z.string().trim().max(120),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(24),
  batch: z.string().trim().max(120).optional(),
  course: z.string().trim().max(120).optional(),
  specialisation: z.string().trim().max(120).optional(),
  graduationYear: z.string().trim().max(8).optional(),
  rollNo: z.string().trim().max(40).optional(),
  prn: z.string().trim().max(40).optional(),
  division: z.string().trim().max(20).optional(),
  gender: z.string().trim().max(30).optional(),
  dateOfBirth: z.string().trim().max(24).optional(),
  cgpa: z.string().trim().max(8).optional(),
  degreePct: z.string().trim().max(8).optional(),
  tenthPct: z.string().trim().max(8).optional(),
  twelfthPct: z.string().trim().max(8).optional(),
  backlogs: z.string().trim().max(4).optional(),
});

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  invitedName: z.string().trim().max(120).optional().or(z.literal('')),
  /** Defaults to the placement officer: the first account a college gets. */
  roleId: z.string().trim().optional(),
});

/** GET /api/admin/colleges */
collegesRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    res.json(await listColleges(collegeQuerySchema.parse(req.query), requireTenantId(req)));
  }),
);

/** POST /api/admin/colleges */
collegesRouter.post(
  '/',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const data = collegeSchema.parse(req.body);
    const tenantId = requireTenantId(req);

    // Codes are unique across the whole platform, so the check is too - but
    // it names nobody, because the clash may be another institution's.
    const clash = await prisma.college.findUnique({ where: { code: data.code } });
    if (clash) throw conflict(`${data.code} is already on the portal.`);

    await assertTypeUsable(data.collegeTypeId);

    const college = await prisma.college.create({
      data: { ...toCollegeData(data), tenantId },
      include: { collegeType: { select: { id: true, name: true } } },
    });

    res.status(201).json({ college });
  }),
);

/** One row of an affiliation list. Only the name and the short code are required. */
const collegeRowSchema = z.object({
  name: z.string().trim().max(200),
  code: z.string().trim().max(32),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  type: z.string().trim().max(60).optional(),
  affiliation: z.string().trim().max(200).optional(),
  address: z.string().trim().max(400).optional(),
  pincode: z.string().trim().max(12).optional(),
  naacGrade: z.string().trim().max(8).optional(),
});

/**
 * POST /api/admin/colleges/bulk
 *
 * Onboarding an affiliation list. Partial success is the point: one malformed
 * code in a paste of three hundred must not cost the other two hundred and
 * ninety-nine, and every rejected row comes back with the reason.
 */
collegesRouter.post(
  '/bulk',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        colleges: z.array(collegeRowSchema).max(1000).optional(),
        text: z.string().max(200_000).optional(),
        defaultState: z.string().trim().max(120).optional(),
      })
      .parse(req.body);

    const rows = body.colleges ?? (body.text ? parseCollegeRows(body.text) : []);
    if (rows.length === 0) throw conflict('Add at least one college.');

    const result = await addColleges(rows, {
      defaultState: body.defaultState,
      tenantId: requireTenantId(req),
    });

    res.status(201).json(result);
  }),
);

/**
 * GET /api/admin/colleges/bulk/template
 *
 * Generated per request rather than served as a static file, so the Type
 * column is a dropdown of the types that exist today.
 */
collegesRouter.get(
  '/bulk/template',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const buffer = await buildCollegeTemplate(await homeUniversityOf(requireTenantId(req)));
    res.set(asWorkbook('apli-colleges.xlsx')).send(Buffer.from(buffer));
  }),
);

/**
 * POST /api/admin/colleges/bulk/file
 *
 * The filled-in workbook. It is read into the same rows the paste box
 * produces and handed to the same importer, so an upload and a paste cannot
 * disagree about what is acceptable.
 */
collegesRouter.post(
  '/bulk/file',
  can('college:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw badRequest('Attach an .xlsx or .csv file. Download the template if you need one.');
    }

    const rows = /\.csv$/i.test(file.originalname)
      ? parseCollegeRows(file.buffer.toString('utf8'))
      : await parseCollegeWorkbook(file.buffer);

    if (rows.length === 0) {
      throw badRequest(
        'No colleges found in that file. Check the first row names the columns - the template shows the shape.',
      );
    }

    const body = z
      .object({ defaultState: z.string().trim().max(120).optional() })
      .parse(req.body ?? {});

    const result = await addColleges(rows, {
      defaultState: body.defaultState,
      tenantId: requireTenantId(req),
    });

    res.status(201).json({ ...result, fileName: file.originalname, rowsRead: rows.length });
  }),
);

/** GET /api/admin/colleges/:id */
collegesRouter.get(
  '/:id',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const college = await prisma.college.findFirst({
      where: { id: req.params.id, tenantId: requireTenantId(req) },
      include: {
        collegeType: { select: { id: true, name: true } },
        members: {
          include: { user: { select: { id: true, fullName: true, email: true, isActive: true } } },
          orderBy: { createdAt: 'asc' },
        },
        invites: {
          where: { acceptedAt: null, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            invitedName: true,
            expiresAt: true,
            role: { select: { id: true, name: true } },
          },
        },
        _count: { select: { batches: true, placements: true } },
      },
    });

    if (!college) throw notFound('No such college.');

    res.json({
      college: {
        ...college,
        collegeTypeId: college.collegeType?.id ?? null,
        type: college.collegeType?.name ?? null,
      },
    });
  }),
);

/** PATCH /api/admin/colleges/:id - correct the record. */
collegesRouter.patch(
  '/:id',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const data = collegeSchema.parse(req.body);

    const college = await ownCollege(req, req.params.id);

    const clash = await prisma.college.findFirst({
      where: { code: data.code, id: { not: college.id } },
    });
    if (clash) {
      // Naming the other college is only fair when it is this tenant's own.
      throw conflict(
        clash.tenantId === college.tenantId
          ? `The code ${data.code} is already used by ${clash.name}.`
          : `The code ${data.code} is already taken on the portal.`,
      );
    }

    await assertTypeUsable(data.collegeTypeId);

    const updated = await prisma.college.update({
      where: { id: college.id },
      data: toCollegeData(data),
    });

    res.json({ college: updated });
  }),
);

/** PATCH /api/admin/colleges/:id/verify */
collegesRouter.patch(
  '/:id/verify',
  can('college:write'),
  asyncHandler(async (req, res) => {
    const { isVerified } = z.object({ isVerified: z.boolean() }).parse(req.body);

    const college = await ownCollege(req, req.params.id);

    const updated = await prisma.college.update({
      where: { id: college.id },
      data: { isVerified },
      select: { id: true, isVerified: true },
    });

    res.json({ college: updated });
  }),
);

/**
 * POST /api/admin/colleges/:id/invites
 * Invites a placement officer. The raw token is returned once, here, and is
 * never readable again - lose it and you reissue.
 */
collegesRouter.post(
  '/:id/invites',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const collegeId = req.params.id!;
    const data = inviteSchema.parse(req.body);
    const role = await usableRole(data.roleId, RoleScope.CAMPUS);

    await ownCollege(req, collegeId);

    const { invite, token } = await createInvite({
      kind: InviteKind.CAMPUS_MEMBER,
      email: data.email,
      invitedName: data.invitedName ? data.invitedName : undefined,
      collegeId,
      roleId: role.id,
      sentById: req.session.userId!,
    });

    res.status(201).json({
      invite: {
        id: invite.id,
        email: invite.email,
        invitedName: invite.invitedName,
        role: { id: role.id, name: role.name },
        expiresAt: invite.expiresAt,
      },
      link: inviteLinkFor(token),
    });
  }),
);

/** DELETE /api/admin/colleges/:id/invites/:inviteId - cancel a pending invite */
collegesRouter.delete(
  '/:id/invites/:inviteId',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const { id: collegeId, inviteId } = req.params;

    const result = await prisma.invite.updateMany({
      where: {
        id: inviteId,
        collegeId,
        college: { tenantId: requireTenantId(req) },
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) throw notFound('No pending invitation to cancel.');
    res.status(204).end();
  }),
);

/* -------------------------------------------------------------------------- */
/* Students, on behalf of a college                                            */
/*                                                                            */
/* Normally the college enters its own roster. Operations can do it too, for   */
/* the case that actually happens during a rollout: the college is on the      */
/* platform and has sent over a spreadsheet, but nobody there has accepted     */
/* their invitation yet. Every record still belongs to the college, and the    */
/* audit trail shows who created it.                                           */
/* -------------------------------------------------------------------------- */

/** GET /api/admin/colleges/:id/batches — for choosing where students go. */
collegesRouter.get(
  '/:id/batches',
  can('batch:read'),
  asyncHandler(async (req, res) => {
    const batches = await prisma.batch.findMany({
      where: { collegeId: req.params.id, tenantId: requireTenantId(req) },
      orderBy: [{ graduationYear: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { memberships: true } } },
    });

    res.json({
      batches: batches.map((b) => ({
        id: b.id,
        name: b.name,
        course: b.course,
        specialisation: b.specialisation,
        graduationYear: b.graduationYear,
        studyYear: b.studyYear,
        studentCount: b._count.memberships,
      })),
    });
  }),
);

/** POST /api/admin/colleges/:id/batches — create one if the college has none. */
collegesRouter.post(
  '/:id/batches',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    const collegeId = req.params.id!;
    const college = await ownCollege(req, collegeId);

    const data = batchSchema.parse(req.body);

    const taken = async (n: string) =>
      (await prisma.batch.findFirst({ where: { collegeId, name: n }, select: { id: true } })) !==
      null;

    let name: string;
    if (data.name?.trim()) {
      name = data.name.trim();
      if (await taken(name)) throw conflict(`This college already has a batch called ${name}.`);
    } else {
      const count = await prisma.batch.count({ where: { collegeId } });
      name = await uniqueBatchName(taken, deriveBatchName(data, count + 1));
    }

    const batch = await prisma.batch.create({
      data: { collegeId, tenantId: college.tenantId, ...toBatchData(data), name },
    });

    res.status(201).json({ batch });
  }),
);

/**
 * POST /api/admin/colleges/:id/students
 * No batch in the path: each row carries its own, and any batch that does not
 * exist yet is created. Operations can therefore populate a college straight
 * from a spreadsheet, without setting anything up first.
 */
collegesRouter.post(
  '/:id/students',
  can('student:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const college = await ownCollege(req, req.params.id);

    const rows = await rowsFromRequest(req);
    res.status(201).json(await addStudents(college.id, rows, req.session.userId!));
  }),
);

/** GET /api/admin/colleges/:id/students/template */
collegesRouter.get(
  '/:id/students/template',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const college = await ownCollege(req, req.params.id);

    const batches = await prisma.batch.findMany({
      where: { collegeId: req.params.id },
      orderBy: { name: 'asc' },
      select: { name: true },
    });

    const buffer = await buildStudentTemplate({
      batchNames: batches.map((b) => b.name),
      collegeName: college.name,
    });
    res.set(asWorkbook('apli-students.xlsx')).send(Buffer.from(buffer));
  }),
);

/** POST /api/admin/colleges/:id/batches/:batchId/students — into one batch */
collegesRouter.post(
  '/:id/batches/:batchId/students',
  can('student:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    // Scoped through the college in the path, so a batch id from elsewhere
    // simply does not match.
    const batch = await prisma.batch.findFirst({
      where: { id: req.params.batchId, collegeId: req.params.id, tenantId: requireTenantId(req) },
    });
    if (!batch) throw notFound('No such batch at this college.');

    const rows = await rowsFromRequest(req);

    // The college comes from the path, not from the batch: the two are the
    // same here by construction.
    res.status(201).json(await addStudents(req.params.id!, rows, req.session.userId!, { batch }));
  }),
);
