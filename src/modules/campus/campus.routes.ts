import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { inviteLinkFor } from '../invites/invite.service.js';
import { inviteStudents, ownedBatch, setJoinCode } from './campus.service.js';
import { addStudents } from './students.service.js';
import { buildStudentTemplate } from './students.template.js';
import { rowsFromRequest } from './students.intake.js';
import { asWorkbook, workbookUpload } from '../../lib/upload.js';
import { loadProfile, serialiseProfile } from '../candidates/candidate.service.js';
import {
  batchSchema,
  deriveBatchName,
  toBatchData,
  uniqueBatchName,
} from './batch.schemas.js';
import { can } from '../roles/can.js';

export const campusRouter = Router();

// Layer 2. Every handler below then narrows by the caller's college (layer 3).
campusRouter.use(requireRole('CAMPUS'));

const joinLink = (code: string) => `${env.CLIENT_ORIGIN}/join/${code}`;


const emailsSchema = z.object({
  emails: z
    .array(z.string().trim().toLowerCase())
    .min(1, 'Add at least one email address.')
    .max(500, 'Invite at most 500 students at a time.'),
});

/** GET /api/campus/overview */
campusRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    const [
      college,
      batches,
      students,
      frozen,
      pendingInvites,
      drives,
      pendingPostings,
      teamMembers,
      teamInvites,
      drivesEver,
      acceptedPostings,
    ] = await Promise.all([
      prisma.college.findUnique({ where: { id: collegeId }, select: { name: true, city: true } }),
      prisma.batch.count({ where: { collegeId } }),
      prisma.batchMembership.count({ where: { batch: { collegeId } } }),
      prisma.batchMembership.count({ where: { batch: { collegeId }, isFrozen: true } }),
      prisma.invite.count({ where: { collegeId: null, batch: { collegeId }, acceptedAt: null, revokedAt: null } }),
      prisma.placement.count({ where: { collegeId, isOpen: true } }),
      prisma.jobPosting.count({
        where: {
          placement: { collegeId },
          status: 'PENDING',
          job: { status: { not: 'DRAFT' } },
        },
      }),
      // What the getting-started checklist reads. Each is a plain fact about
      // the college, so an item ticks itself the moment the work is done,
      // whoever did it and from whichever screen.
      prisma.campusMember.count({ where: { collegeId } }),
      prisma.invite.count({
        where: { collegeId, kind: 'CAMPUS_MEMBER', acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      prisma.placement.count({ where: { collegeId } }),
      prisma.jobPosting.count({ where: { placement: { collegeId }, status: 'ACCEPTED' } }),
    ]);

    res.json({
      college,
      stats: {
        batches,
        students,
        frozen,
        unverified: students - frozen,
        pendingInvites,
        drives,
        pendingPostings,
        teamMembers,
        teamInvites,
        drivesEver,
        acceptedPostings,
      },
    });
  }),
);

/** GET /api/campus/batches */
campusRouter.get(
  '/batches',
  can('batch:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    const batches = await prisma.batch.findMany({
      where: { collegeId },
      // Nulls sort last in MySQL on DESC, so batches with no year fall below
      // the dated ones rather than above them.
      orderBy: [{ graduationYear: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { memberships: true } } },
    });

    // One extra query beats N: count frozen members per batch in a single pass.
    const frozenCounts = await prisma.batchMembership.groupBy({
      by: ['batchId'],
      where: { batch: { collegeId }, isFrozen: true },
      _count: { _all: true },
    });
    const frozenBy = new Map(frozenCounts.map((f) => [f.batchId, f._count._all]));

    res.json({
      batches: batches.map((b) => ({
        id: b.id,
        name: b.name,
        course: b.course,
        specialisation: b.specialisation,
        graduationYear: b.graduationYear,
        studyYear: b.studyYear,
        headOfDept: b.headOfDept,
        joinCodeEnabled: b.joinCodeEnabled,
        studentCount: b._count.memberships,
        frozenCount: frozenBy.get(b.id) ?? 0,
      })),
    });
  }),
);

/** POST /api/campus/batches */
campusRouter.post(
  '/batches',
  can('batch:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const data = batchSchema.parse(req.body);

    const taken = async (n: string) =>
      (await prisma.batch.findFirst({ where: { collegeId, name: n }, select: { id: true } })) !==
      null;

    let name: string;
    if (data.name?.trim()) {
      name = data.name.trim();
      if (await taken(name)) throw conflict(`You already have a batch called ${name}.`);
    } else {
      const count = await prisma.batch.count({ where: { collegeId } });
      name = await uniqueBatchName(taken, deriveBatchName(data, count + 1));
    }

    // A batch carries its tenant as well as its college, so a university-wide
    // batch and a college's own are fenced by the same column.
    const { tenantId } = await prisma.college.findUniqueOrThrow({
      where: { id: collegeId },
      select: { tenantId: true },
    });
    const batch = await prisma.batch.create({
      data: { collegeId, tenantId, ...toBatchData(data), name },
    });

    res.status(201).json({ batch });
  }),
);

/** GET /api/campus/batches/:id — the roster */
campusRouter.get(
  '/batches/:id',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);

    const [memberships, invites] = await Promise.all([
      prisma.batchMembership.findMany({
        where: { batchId: batch.id },
        orderBy: [{ rollNo: 'asc' }, { joinedAt: 'asc' }],
        include: {
          candidate: {
            select: {
              id: true,
              phone: true,
              prn: true,
              cgpa: true,
              resumeUrl: true,
              user: { select: { fullName: true, email: true, isActive: true } },
            },
          },
        },
      }),
      prisma.invite.findMany({
        where: { batchId: batch.id, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, expiresAt: true },
      }),
    ]);

    res.json({
      batch: {
        ...batch,
        joinLink: batch.joinCodeEnabled && batch.joinCode ? joinLink(batch.joinCode) : null,
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
        isFrozen: m.isFrozen,
        verifiedAt: m.verifiedAt,
        joinedAt: m.joinedAt,
        hasResume: Boolean(m.candidate.resumeUrl),
        // On the roster is not the same as signed up: a student the college
        // entered has a record here before they have ever logged in.
        hasClaimed: m.candidate.user.isActive,
      })),
      invites,
    });
  }),
);

/** POST /api/campus/batches/:id/invites — bulk, partial success is normal */
campusRouter.post(
  '/batches/:id/invites',
  can('student:invite'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);
    const { emails } = emailsSchema.parse(req.body);

    const result = await inviteStudents(batch, emails, req.session.userId!, inviteLinkFor);
    res.status(201).json(result);
  }),
);

/**
 * POST /api/campus/students
 * Adds students without picking a batch first - each row carries its own, and
 * any batch that does not exist yet is created. This is the usual way in: a
 * class list already has a class column.
 */
campusRouter.post(
  '/students',
  can('student:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const rows = await rowsFromRequest(req);

    res.status(201).json(await addStudents(collegeId, rows, req.session.userId!));
  }),
);

/** GET /api/campus/students/template — the class-list workbook. */
campusRouter.get(
  '/students/template',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const [college, batches] = await Promise.all([
      prisma.college.findUnique({ where: { id: collegeId }, select: { name: true } }),
      prisma.batch.findMany({
        where: { collegeId },
        orderBy: { name: 'asc' },
        select: { name: true },
      }),
    ]);

    const buffer = await buildStudentTemplate({
      batchNames: batches.map((b) => b.name),
      collegeName: college?.name,
    });

    res.set(asWorkbook('apli-students.xlsx')).send(Buffer.from(buffer));
  }),
);

/**
 * POST /api/campus/batches/:id/students
 * Enters a class list. Accepts either structured rows or pasted text, so a
 * spreadsheet copy works without anyone reformatting it.
 */
campusRouter.post(
  '/batches/:id/students',
  can('student:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);
    const rows = await rowsFromRequest(req);

    res.status(201).json(await addStudents(collegeId, rows, req.session.userId!, { batch }));
  }),
);

/** GET /api/campus/batches/:id/students/template — no Batch column: it is chosen. */
campusRouter.get(
  '/batches/:id/students/template',
  can('student:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);

    const buffer = await buildStudentTemplate({ fixedBatchName: batch.name });
    res.set(asWorkbook(`${batch.name.replace(/[^\w -]/g, '')} students.xlsx`)).send(
      Buffer.from(buffer),
    );
  }),
);

/** POST /api/campus/batches/:id/join-code — enable or rotate */
campusRouter.post(
  '/batches/:id/join-code',
  can('student:invite'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);
    const updated = await setJoinCode(batch.id, true);

    res.json({ joinLink: joinLink(updated.joinCode!), joinCode: updated.joinCode });
  }),
);

/** DELETE /api/campus/batches/:id/join-code — turn it off */
campusRouter.delete(
  '/batches/:id/join-code',
  can('student:invite'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);
    await setJoinCode(batch.id, false);
    res.status(204).end();
  }),
);

/** DELETE /api/campus/batches/:id/members/:membershipId — remove a student */
campusRouter.delete(
  '/batches/:id/members/:membershipId',
  can('student:remove'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);

    const removed = await prisma.batchMembership.deleteMany({
      where: { id: req.params.membershipId, batchId: batch.id },
    });
    if (removed.count === 0) throw notFound('That student is not in this batch.');

    res.status(204).end();
  }),
);

/** DELETE /api/campus/invites/:inviteId — cancel a pending student invite */
campusRouter.delete(
  '/invites/:inviteId',
  can('student:invite'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    const result = await prisma.invite.updateMany({
      where: {
        id: req.params.inviteId,
        batch: { collegeId },
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
/* Verify and freeze - the first of the two gates in this product.             */
/*                                                                            */
/* Freezing does two things at once: it locks the record against further       */
/* student edits, and it is what makes the student eligible to apply. That is  */
/* deliberate - it turns verification from a chore into the key to the door.   */
/* -------------------------------------------------------------------------- */

const freezeSchema = z.object({
  membershipIds: z.array(z.string()).min(1, 'Select at least one student.').max(500),
  rollNos: z.record(z.string(), z.string().trim().max(40)).optional(),
});

/** GET /api/campus/students/:candidateId — the record a TPO reviews */
campusRouter.get(
  '/students/:candidateId',
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    // Layer 3: only students who sit in one of this college's batches.
    const membership = await prisma.batchMembership.findFirst({
      where: { candidateId: req.params.candidateId, batch: { collegeId } },
      include: { batch: { select: { id: true, name: true } } },
    });
    if (!membership) throw notFound('No such student in your college.');

    const candidate = await loadProfile(req.params.candidateId!);

    res.json({
      profile: serialiseProfile(candidate),
      membership: {
        id: membership.id,
        batchId: membership.batch.id,
        batchName: membership.batch.name,
        rollNo: membership.rollNo,
        isFrozen: membership.isFrozen,
        verifiedAt: membership.verifiedAt,
      },
    });
  }),
);

/** POST /api/campus/batches/:id/freeze — verify and lock, in bulk */
campusRouter.post(
  '/batches/:id/freeze',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);
    const { membershipIds, rollNos } = freezeSchema.parse(req.body);

    // Roll numbers are often set at the same moment as verification, so they
    // are accepted here rather than forcing a second round-trip.
    if (rollNos) {
      for (const [membershipId, rollNo] of Object.entries(rollNos)) {
        if (!rollNo) continue;
        await prisma.batchMembership.updateMany({
          where: { id: membershipId, batchId: batch.id },
          data: { rollNo },
        });
      }
    }

    const result = await prisma.batchMembership.updateMany({
      where: { id: { in: membershipIds }, batchId: batch.id },
      data: { isFrozen: true, verifiedAt: new Date() },
    });

    res.json({ frozen: result.count });
  }),
);

/** POST /api/campus/batches/:id/unfreeze — hand editing back to the student */
campusRouter.post(
  '/batches/:id/unfreeze',
  can('student:verify'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const batch = await ownedBatch(collegeId, req.params.id!);
    const { membershipIds } = freezeSchema.parse(req.body);

    const result = await prisma.batchMembership.updateMany({
      where: { id: { in: membershipIds }, batchId: batch.id },
      data: { isFrozen: false, verifiedAt: null },
    });

    res.json({ unfrozen: result.count });
  }),
);
