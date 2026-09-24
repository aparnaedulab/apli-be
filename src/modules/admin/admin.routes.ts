import { Router } from 'express';
import { z } from 'zod';
import { ApplicationStatus, JobStatus, Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { canPublish, verifiedCompany } from '../company/verification.js';
import { homeUniversityOf } from './colleges.bulk.js';
import { addStudents } from '../campus/students.service.js';
import { buildStudentTemplate } from '../campus/students.template.js';
import { rowsFromRequest } from '../campus/students.intake.js';
import { asWorkbook, workbookUpload } from '../../lib/upload.js';
import {
  batchSchema,
  deriveBatchName,
  toBatchData,
  uniqueBatchName,
} from '../campus/batch.schemas.js';
import { can } from '../roles/can.js';
import { inTenant, requireTenantId } from '../tenants/tenant.context.js';
import { operationsOverview } from './overview.service.js';

export const adminRouter = Router();

adminRouter.use(requireRole('ADMIN'));

/**
 * Operations sees its whole institution, across every college in it. These
 * are read-only views by design: the point is oversight, not reaching in and
 * editing another organisation's data. The only writes here are the ones that
 * are genuinely ops work — disabling an account, cancelling an invitation.
 *
 * Every query narrows to the session's tenant. For a tenant admin that is
 * their own institution; for the platform team it is whichever institution
 * they have stepped into. A row from another tenant answers 404, exactly as a
 * row that does not exist - which, from where the caller stands, it does not.
 */

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Every list endpoint answers in the same shape, so one UI component reads them all. */
function paged<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

const skipTake = (p: { page: number; pageSize: number }) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/admin/meta
 *
 * Settings the screens need but should not hold their own copy of. The
 * university name is the one that matters: it labels the affiliation toggle on
 * the college form, it is what "Yes" means in the bulk-upload spreadsheet, and
 * it is the value written to the database. Three copies of a string that must
 * agree is how they stop agreeing.
 */
/**
 * GET /api/admin/batches/:id — one batch and who is in it.
 *
 * Not scoped through a college, because a university-wide batch has none and
 * would otherwise be unreachable. Operations already sees every college.
 */
adminRouter.get(
  '/batches/:id',
  can('batch:read'),
  asyncHandler(async (req, res) => {
    const batch = await prisma.batch.findFirst({
      where: { id: req.params.id, tenantId: requireTenantId(req) },
      include: { college: { select: { id: true, name: true, code: true } } },
    });
    if (!batch) throw notFound('No such batch.');

    const memberships = await prisma.batchMembership.findMany({
      where: { batchId: batch.id },
      orderBy: [{ rollNo: 'asc' }, { joinedAt: 'asc' }],
      include: {
        candidate: {
          select: {
            id: true,
            phone: true,
            prn: true,
            cgpa: true,
            course: true,
            specialisation: true,
            graduationYear: true,
            college: { select: { name: true, code: true } },
            user: { select: { fullName: true, email: true, isActive: true } },
          },
        },
      },
    });

    res.json({
      batch: {
        ...batch,
        collegeName: batch.college?.name ?? 'University-wide',
      },
      students: memberships.map((m) => ({
        membershipId: m.id,
        candidateId: m.candidate.id,
        name: m.candidate.user.fullName,
        email: m.candidate.user.email,
        rollNo: m.rollNo,
        division: m.division,
        prn: m.candidate.prn,
        phone: m.candidate.phone,
        cgpa: m.candidate.cgpa,
        course: m.candidate.course,
        specialisation: m.candidate.specialisation,
        graduationYear: m.candidate.graduationYear,
        // Shown because a university-wide batch holds students from several.
        college: m.candidate.college?.name ?? null,
        collegeCode: m.candidate.college?.code ?? null,
        isFrozen: m.isFrozen,
        joinedAt: m.joinedAt,
        hasClaimed: m.candidate.user.isActive,
      })),
    });
  }),
);

/**
 * POST /api/admin/batches/:id/students — into one batch, whatever it belongs to.
 *
 * A student always belongs to a college even when their batch does not, so a
 * university-wide batch needs to be told which college these particular
 * students come from. A college's own batch answers that itself.
 */
adminRouter.post(
  '/batches/:id/students',
  can('student:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req);
    const batch = await prisma.batch.findFirst({ where: { id: req.params.id, tenantId } });
    if (!batch) throw notFound('No such batch.');

    // On a multipart request the other fields arrive as form values.
    const collegeId = batch.collegeId ?? String(req.body?.collegeId ?? '').trim();
    if (!collegeId) {
      throw badRequest(
        'This batch spans the university, so say which college these students belong to.',
      );
    }
    if (!(await prisma.college.findFirst({ where: { id: collegeId, tenantId } }))) {
      throw notFound('No such college.');
    }

    const rows = await rowsFromRequest(req);
    res.status(201).json(await addStudents(collegeId, rows, req.session.userId!, { batch }));
  }),
);

/** GET /api/admin/batches/:id/students/template — no Batch column: it is chosen. */
adminRouter.get(
  '/batches/:id/students/template',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const batch = await prisma.batch.findFirst({
      where: { id: req.params.id, tenantId: requireTenantId(req) },
    });
    if (!batch) throw notFound('No such batch.');

    const buffer = await buildStudentTemplate({ fixedBatchName: batch.name });
    res.set(asWorkbook(`${batch.name.replace(/[^\w -]/g, '')} students.xlsx`)).send(
      Buffer.from(buffer),
    );
  }),
);

/**
 * POST /api/admin/batches
 *
 * A batch, with or without a college. Operations is the only caller that can
 * leave the college out: a university-wide group like "First year" spans every
 * affiliated college, and belongs to the university rather than to any one of
 * them.
 *
 * A college's own drives still only offer that college's own batches, so a
 * university-wide batch cannot be pulled into a college drive by accident. It
 * is a roster grouping until university-level drives exist.
 */
adminRouter.post(
  '/batches',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    const data = batchSchema.extend({ collegeId: z.string().trim().optional() }).parse(req.body);
    const collegeId = data.collegeId?.trim() || null;
    const tenantId = requireTenantId(req);

    if (collegeId) {
      const college = await prisma.college.findFirst({ where: { id: collegeId, tenantId } });
      if (!college) throw notFound('No such college.');
    }

    // The tenant is part of the question: two universities may each have a
    // university-wide "First year", and neither's is a clash with the other's.
    const taken = async (name: string) =>
      (await prisma.batch.findFirst({
        where: { collegeId, tenantId, name },
        select: { id: true },
      })) !== null;

    // A name that was typed is honoured or refused; a name nobody typed is
    // derived and then made unique, because refusing it would be refusing a
    // clash over a name the person never chose.
    let name: string;
    if (data.name?.trim()) {
      name = data.name.trim();
      if (await taken(name)) {
        throw conflict(
          collegeId
            ? `That college already has a batch called ${name}.`
            : `There is already a university-wide batch called ${name}.`,
        );
      }
    } else {
      const count = await prisma.batch.count({ where: { collegeId, tenantId } });
      name = await uniqueBatchName(taken, deriveBatchName(data, count + 1));
    }

    const batch = await prisma.batch.create({
      data: { collegeId, tenantId, ...toBatchData(data), name },
      include: { college: { select: { name: true } } },
    });

    res.status(201).json({
      batch: { ...batch, collegeName: batch.college?.name ?? 'University-wide' },
    });
  }),
);

adminRouter.get(
  '/meta',
  asyncHandler(async (req, res) => {
    // The signed-in institution's own name; each tenant is its own "home".
    res.json({ homeUniversity: await homeUniversityOf(requireTenantId(req)) });
  }),
);

/**
 * GET /api/admin/overview?days=30 - what is going on, rather than how much of
 * it there is.
 *
 * Read-only and fenced to the signed-in institution, behind the same
 * report:read permission as /stats.
 */
adminRouter.get(
  '/overview',
  can('report:read'),
  asyncHandler(async (req, res) => {
    // A window shorter than a week hides the weekend; longer than a year stops
    // being "what is going on" and starts being an annual report.
    const days = z.coerce.number().int().min(7).max(365).default(30).parse(req.query.days ?? 30);
    res.json(await operationsOverview({ tenantId: requireTenantId(req), days }));
  }),
);

adminRouter.get(
  '/stats',
  can('report:read'),
  asyncHandler(async (req, res) => {
    const t = requireTenantId(req);
    const application = inTenant.application(t);

    const [
      colleges,
      companies,
      verifiedCompanies,
      users,
      students,
      frozen,
      batches,
      openDrives,
      jobs,
      publishedJobs,
      pendingPostings,
      applications,
      pendingInvites,
      byStatus,
    ] = await Promise.all([
      prisma.college.count({ where: inTenant.college(t) }),
      // Companies are shared by every institution, so these two describe the
      // marketplace the tenant can draw on rather than rows it owns.
      prisma.company.count(),
      prisma.company.count({ where: verifiedCompany }),
      prisma.user.count({ where: inTenant.user(t) }),
      prisma.candidate.count({ where: inTenant.candidate(t) }),
      prisma.batchMembership.count({ where: { isFrozen: true, batch: { tenantId: t } } }),
      prisma.batch.count({ where: inTenant.batch(t) }),
      prisma.placement.count({ where: { isOpen: true, ...inTenant.placement(t) } }),
      prisma.job.count({ where: inTenant.job(t) }),
      prisma.job.count({ where: { status: JobStatus.PUBLISHED, ...inTenant.job(t) } }),
      prisma.jobPosting.count({
        where: {
          status: 'PENDING',
          job: { status: { not: JobStatus.DRAFT } },
          placement: { college: { tenantId: t } },
        },
      }),
      prisma.application.count({ where: application }),
      prisma.invite.count({
        where: { AND: [{ acceptedAt: null, revokedAt: null }, inTenant.invite(t)] },
      }),
      prisma.application.groupBy({
        by: ['status'],
        where: application,
        _count: { _all: true },
      }),
    ]);

    const placed = await prisma.application.count({
      where: {
        status: { in: [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
        ...application,
      },
    });

    res.json({
      stats: {
        colleges,
        companies,
        verifiedCompanies,
        unverifiedCompanies: companies - verifiedCompanies,
        users,
        students,
        frozen,
        unverifiedStudents: students - frozen,
        batches,
        openDrives,
        jobs,
        publishedJobs,
        pendingPostings,
        applications,
        placed,
        pendingInvites,
      },
      funnel: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/users',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const p = listQuery.extend({ role: z.nativeEnum(Role).optional() }).parse(req.query);

    const where: Prisma.UserWhereInput = {
      AND: [
        inTenant.user(requireTenantId(req)),
        p.role ? { role: p.role } : {},
        p.q ? { OR: [{ email: { contains: p.q } }, { fullName: { contains: p.q } }] } : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(p),
        include: {
          campusMember: {
            include: { college: { select: { name: true } }, role: { select: { name: true } } },
          },
          companyMember: {
            include: { company: { select: { name: true } }, role: { select: { name: true } } },
          },
          candidate: { select: { id: true, college: { select: { name: true } } } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(
      paged(
        rows.map((u) => ({
          id: u.id,
          email: u.email,
          fullName: u.fullName,
          role: u.role,
          isActive: u.isActive,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
          organisation:
            u.campusMember?.college.name ??
            u.companyMember?.company.name ??
            u.candidate?.college?.name ??
            null,
          orgRole: u.campusMember?.role.name ?? u.companyMember?.role.name ?? null,
        })),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/** PATCH /api/admin/users/:id — disable or re-enable an account. */
adminRouter.patch(
  '/users/:id',
  can('account:suspend'),
  asyncHandler(async (req, res) => {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);

    const user = await prisma.user.findFirst({
      where: { AND: [{ id: req.params.id }, inTenant.user(requireTenantId(req))] },
    });
    if (!user) throw notFound('No such user.');
    if (user.id === req.session.userId) throw conflict('You cannot disable your own account.');

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isActive },
      select: { id: true, email: true, isActive: true },
    });

    res.json({ user: updated });
  }),
);

/* -------------------------------------------------------------------------- */
/* Students                                                                    */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/students',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const p = listQuery
      .extend({ verified: z.enum(['true', 'false']).optional() })
      .parse(req.query);

    const where: Prisma.CandidateWhereInput = {
      AND: [
        inTenant.candidate(requireTenantId(req)),
        p.q
          ? {
              OR: [
                { user: { email: { contains: p.q } } },
                { user: { fullName: { contains: p.q } } },
              ],
            }
          : {},
        p.verified ? { batchMemberships: { some: { isFrozen: p.verified === 'true' } } } : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.candidate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(p),
        include: {
          user: { select: { fullName: true, email: true, isActive: true } },
          college: { select: { name: true } },
          batchMemberships: { include: { batch: { select: { name: true, course: true } } } },
          _count: { select: { applications: true } },
        },
      }),
      prisma.candidate.count({ where }),
    ]);

    res.json(
      paged(
        rows.map((c) => {
          const m = c.batchMemberships[0];
          return {
            id: c.id,
            name: c.user.fullName,
            email: c.user.email,
            college: c.college?.name ?? null,
            batch: m?.batch.name ?? null,
            course: m?.batch.course ?? null,
            rollNo: m?.rollNo ?? null,
            isFrozen: m?.isFrozen ?? false,
            cgpa: c.cgpa,
            applications: c._count.applications,
          };
        }),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Batches                                                                     */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/batches',
  can('batch:read'),
  asyncHandler(async (req, res) => {
    const p = listQuery.parse(req.query);
    const { scope, collegeId } = z
      .object({
        // "university" means the batches that belong to no college at all.
        scope: z.enum(['university']).optional(),
        collegeId: z.string().trim().optional(),
      })
      .parse(req.query);

    const tenantId = requireTenantId(req);
    const where: Prisma.BatchWhereInput = {
      tenantId,
      ...(p.q
        ? { OR: [{ name: { contains: p.q } }, { college: { name: { contains: p.q } } }] }
        : {}),
      ...(scope === 'university' ? { collegeId: null } : {}),
      ...(collegeId ? { collegeId } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.batch.findMany({
        where,
        orderBy: [{ graduationYear: 'desc' }, { name: 'asc' }],
        ...skipTake(p),
        include: {
          college: { select: { id: true, name: true, code: true } },
          _count: { select: { memberships: true, placements: true } },
        },
      }),
      prisma.batch.count({ where }),
    ]);

    const frozen = await prisma.batchMembership.groupBy({
      by: ['batchId'],
      where: { isFrozen: true, batch: { tenantId } },
      _count: { _all: true },
    });
    const frozenBy = new Map(frozen.map((f) => [f.batchId, f._count._all]));

    res.json(
      paged(
        rows.map((b) => ({
          id: b.id,
          name: b.name,
          // A batch with no college belongs to the university itself. Both the
          // name to read and the id a screen needs to follow it.
          collegeId: b.college?.id ?? null,
          college: b.college?.name ?? 'University-wide',
          collegeCode: b.college?.code ?? null,
          course: b.course,
          specialisation: b.specialisation,
          graduationYear: b.graduationYear,
          studyYear: b.studyYear,
          students: b._count.memberships,
          verified: frozenBy.get(b.id) ?? 0,
          drives: b._count.placements,
        })),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Drives                                                                      */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/drives',
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const p = listQuery.parse(req.query);
    const t = requireTenantId(req);
    const where: Prisma.PlacementWhereInput = {
      AND: [
        inTenant.placement(t),
        p.q ? { OR: [{ name: { contains: p.q } }, { college: { name: { contains: p.q } } }] } : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.placement.findMany({
        where,
        orderBy: [{ year: 'desc' }, { name: 'asc' }],
        ...skipTake(p),
        include: {
          college: { select: { name: true } },
          batches: { select: { _count: { select: { memberships: true } } } },
          _count: { select: { jobPostings: true, applications: true } },
        },
      }),
      prisma.placement.count({ where }),
    ]);

    const placedRows = await prisma.application.groupBy({
      by: ['placementId'],
      where: {
        status: { in: [ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] },
        ...inTenant.application(t),
      },
      _count: { _all: true },
    });
    const placedBy = new Map(placedRows.map((r) => [r.placementId, r._count._all]));

    res.json(
      paged(
        rows.map((d) => {
          const students = d.batches.reduce((n, b) => n + b._count.memberships, 0);
          const placed = placedBy.get(d.id) ?? 0;
          return {
            id: d.id,
            name: d.name,
            college: d.college.name,
            type: d.type,
            year: d.year,
            isOpen: d.isOpen,
            oneOfferRule: d.oneOfferRule,
            students,
            jobs: d._count.jobPostings,
            applications: d._count.applications,
            placed,
            placedPercent: students ? Math.round((placed / students) * 100) : 0,
          };
        }),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Jobs                                                                        */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/jobs',
  can('job:read'),
  asyncHandler(async (req, res) => {
    const p = listQuery.extend({ status: z.nativeEnum(JobStatus).optional() }).parse(req.query);

    const t = requireTenantId(req);
    const where: Prisma.JobWhereInput = {
      AND: [
        inTenant.job(t),
        p.status ? { status: p.status } : {},
        p.q ? { OR: [{ title: { contains: p.q } }, { company: { name: { contains: p.q } } }] } : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.job.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(p),
        include: {
          company: { select: { name: true, status: true } },
          // A role is shared across institutions; what this tenant sees of it
          // is its own colleges' decisions and its own students' applications.
          postings: {
            where: { placement: { college: { tenantId: t } } },
            select: { status: true },
          },
          _count: {
            select: { rounds: true, applications: { where: inTenant.application(t) } },
          },
        },
      }),
      prisma.job.count({ where }),
    ]);

    res.json(
      paged(
        rows.map((j) => ({
          id: j.id,
          title: j.title,
          company: j.company.name,
          companyVerified: canPublish(j.company.status),
          status: j.status,
          deadline: j.deadline,
          ctcMin: j.ctcMin,
          ctcMax: j.ctcMax,
          rounds: j._count.rounds,
          applications: j._count.applications,
          accepted: j.postings.filter((x) => x.status === 'ACCEPTED').length,
          pending: j.postings.filter((x) => x.status === 'PENDING').length,
          declined: j.postings.filter((x) => x.status === 'DECLINED').length,
        })),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Applications                                                                */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/applications',
  can('application:read'),
  asyncHandler(async (req, res) => {
    const p = listQuery
      .extend({ status: z.nativeEnum(ApplicationStatus).optional() })
      .parse(req.query);

    const where: Prisma.ApplicationWhereInput = {
      AND: [
        inTenant.application(requireTenantId(req)),
        p.status ? { status: p.status } : {},
        p.q
          ? {
              OR: [
                { candidate: { user: { fullName: { contains: p.q } } } },
                { candidate: { user: { email: { contains: p.q } } } },
                { job: { title: { contains: p.q } } },
              ],
            }
          : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.application.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        ...skipTake(p),
        include: {
          candidate: {
            select: { user: { select: { fullName: true, email: true } }, college: { select: { name: true } } },
          },
          job: { select: { title: true, company: { select: { name: true } } } },
          placement: { select: { name: true } },
          currentRound: { select: { order: true, name: true } },
        },
      }),
      prisma.application.count({ where }),
    ]);

    res.json(
      paged(
        rows.map((a) => ({
          id: a.id,
          student: a.candidate.user.fullName,
          email: a.candidate.user.email,
          college: a.candidate.college?.name ?? null,
          job: a.job.title,
          company: a.job.company.name,
          drive: a.placement.name,
          status: a.status,
          round: a.currentRound ? `${a.currentRound.order}. ${a.currentRound.name}` : null,
          appliedAt: a.appliedAt,
          updatedAt: a.updatedAt,
        })),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every status change on the platform, newest first. This is the append-only
 * trail the whole design is built around - being able to read it end to end is
 * the point of having written it.
 */
adminRouter.get(
  '/audit',
  can('audit:read'),
  asyncHandler(async (req, res) => {
    const p = listQuery.parse(req.query);

    const where: Prisma.StatusEventWhereInput = {
      AND: [
        { application: inTenant.application(requireTenantId(req)) },
        p.q
          ? {
              OR: [
                { application: { candidate: { user: { fullName: { contains: p.q } } } } },
                { application: { job: { title: { contains: p.q } } } },
                { reason: { contains: p.q } },
              ],
            }
          : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.statusEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(p),
        include: {
          actor: { select: { fullName: true, role: true } },
          application: {
            select: {
              id: true,
              candidate: { select: { user: { select: { fullName: true } } } },
              job: { select: { title: true, company: { select: { name: true } } } },
            },
          },
        },
      }),
      prisma.statusEvent.count({ where }),
    ]);

    res.json(
      paged(
        rows.map((e) => ({
          id: e.id,
          applicationId: e.application.id,
          student: e.application.candidate.user.fullName,
          job: e.application.job.title,
          company: e.application.job.company.name,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          reason: e.reason,
          note: e.note,
          actor: e.actor?.fullName ?? 'System',
          actorRole: e.actor?.role ?? null,
          createdAt: e.createdAt,
        })),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Invitations                                                                 */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/invites',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const p = listQuery
      .extend({ state: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'ALL']).default('PENDING') })
      .parse(req.query);

    const stateWhere =
      p.state === 'PENDING'
        ? { acceptedAt: null, revokedAt: null }
        : p.state === 'ACCEPTED'
          ? { acceptedAt: { not: null } }
          : p.state === 'REVOKED'
            ? { revokedAt: { not: null } }
            : {};

    const where: Prisma.InviteWhereInput = {
      AND: [
        inTenant.invite(requireTenantId(req)),
        stateWhere,
        p.q ? { email: { contains: p.q } } : {},
      ],
    };

    const [rows, total] = await Promise.all([
      prisma.invite.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(p),
        include: {
          college: { select: { name: true } },
          company: { select: { name: true } },
          batch: { select: { name: true, college: { select: { name: true } } } },
          tenant: { select: { name: true } },
          sentBy: { select: { fullName: true } },
        },
      }),
      prisma.invite.count({ where }),
    ]);

    res.json(
      paged(
        rows.map((i) => ({
          id: i.id,
          email: i.email,
          kind: i.kind,
          organisation:
            i.college?.name ?? i.company?.name ?? i.batch?.college?.name ?? i.tenant?.name ?? null,
          batch: i.batch?.name ?? null,
          sentBy: i.sentBy?.fullName ?? null,
          expiresAt: i.expiresAt,
          acceptedAt: i.acceptedAt,
          revokedAt: i.revokedAt,
          // Never the token, not even to operations - only its hash is stored.
        })),
        total,
        p.page,
        p.pageSize,
      ),
    );
  }),
);

/** DELETE /api/admin/invites/:id — cancel any pending invitation. */
adminRouter.delete(
  '/invites/:id',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const result = await prisma.invite.updateMany({
      where: {
        AND: [
          { id: req.params.id, acceptedAt: null, revokedAt: null },
          inTenant.invite(requireTenantId(req)),
        ],
      },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('No pending invitation to cancel.');
    res.status(204).end();
  }),
);
