import { Router } from 'express';
import { EmployerStage } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import { addEmployer, board, ownRelation, suggestions } from './crm.js';
import {
  attendanceCsv,
  checkIn,
  driveBoard,
  driveStudents,
  ownDrive,
  shortCode,
  signPass,
} from './driveDay.js';
import { atRiskStudents, nudgeMessage, RULES } from './atRisk.js';

/**
 * Placement-cell tools: the employer CRM, drive day, and students who have
 * stalled.
 *
 * Every campus endpoint reads the college from the session and narrows every
 * query by it; ids in the path are always checked to belong to that college
 * before anything is read or written. Each tool sits behind its own module.
 */
export const opsRouter = Router();

const campus = [requireRole('CAMPUS')];

/* -------------------------------------------------------------------------- */
/* Employer CRM                                                                */
/* -------------------------------------------------------------------------- */

const crm = [...campus, requireModule('ops.employerCrm')];
const blank = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/** GET /api/ops/crm - the board, follow-ups due, and companies worth adding. */
opsRouter.get(
  '/crm',
  ...crm,
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const [b, suggested] = await Promise.all([board(collegeId), suggestions(collegeId)]);
    res.json({ ...b, suggestions: suggested });
  }),
);

/** POST /api/ops/crm/employers */
opsRouter.post(
  '/crm/employers',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        companyName: blank(200),
        companyId: z.string().trim().optional(),
        stage: z.nativeEnum(EmployerStage).optional(),
        priority: z.number().int().min(1).max(3).optional(),
        notes: blank(2000),
      })
      .parse(req.body);
    res.status(201).json({ employer: await addEmployer(requireCollegeId(req), input) });
  }),
);

/** PATCH /api/ops/crm/employers/:id - move stage, change priority or notes. */
opsRouter.patch(
  '/crm/employers/:id',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const r = await ownRelation(collegeId, req.params.id!);
    const input = z
      .object({
        stage: z.nativeEnum(EmployerStage).optional(),
        priority: z.number().int().min(1).max(3).optional(),
        notes: z.string().trim().max(2000).optional(),
      })
      .parse(req.body);
    res.json({
      employer: await prisma.employerRelation.update({
        where: { id: r.id },
        data: { ...input, ...(input.notes !== undefined ? { notes: input.notes || null } : {}) },
      }),
    });
  }),
);

/** DELETE /api/ops/crm/employers/:id */
opsRouter.delete(
  '/crm/employers/:id',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const r = await ownRelation(requireCollegeId(req), req.params.id!);
    await prisma.employerRelation.delete({ where: { id: r.id } });
    res.status(204).end();
  }),
);

/** POST /api/ops/crm/employers/:id/contacts */
opsRouter.post(
  '/crm/employers/:id/contacts',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const r = await ownRelation(requireCollegeId(req), req.params.id!);
    const input = z
      .object({
        name: z.string().trim().min(2, 'Enter their name.').max(120),
        designation: blank(120),
        email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional().or(z.literal('')),
        phone: blank(24),
      })
      .parse(req.body);
    res.status(201).json({
      contact: await prisma.employerContact.create({
        data: {
          relationId: r.id,
          name: input.name,
          designation: input.designation || null,
          email: input.email || null,
          phone: input.phone || null,
        },
      }),
    });
  }),
);

/** DELETE /api/ops/crm/contacts/:id */
opsRouter.delete(
  '/crm/contacts/:id',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const contact = await prisma.employerContact.findFirst({
      where: { id: req.params.id, relation: { collegeId: requireCollegeId(req) } },
    });
    if (!contact) throw notFound('That contact is not on your board.');
    await prisma.employerContact.delete({ where: { id: contact.id } });
    res.status(204).end();
  }),
);

/** POST /api/ops/crm/employers/:id/interactions - log a call, email or visit. */
opsRouter.post(
  '/crm/employers/:id/interactions',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const r = await ownRelation(requireCollegeId(req), req.params.id!);
    const input = z
      .object({
        kind: z.enum(['CALL', 'EMAIL', 'MEETING', 'VISIT', 'NOTE']),
        summary: z.string().trim().min(2, 'Say what happened.').max(2000),
        happenedAt: z.coerce.date().optional(),
        followUpAt: z.coerce.date().optional().nullable(),
      })
      .parse(req.body);
    res.status(201).json({
      interaction: await prisma.employerInteraction.create({
        data: {
          relationId: r.id,
          kind: input.kind,
          summary: input.summary,
          happenedAt: input.happenedAt ?? new Date(),
          followUpAt: input.followUpAt ?? null,
          createdById: req.session.userId ?? null,
        },
      }),
    });
  }),
);

/** POST /api/ops/crm/interactions/:id/done - the follow-up is dealt with. */
opsRouter.post(
  '/crm/interactions/:id/done',
  ...crm,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const i = await prisma.employerInteraction.findFirst({
      where: { id: req.params.id, relation: { collegeId: requireCollegeId(req) } },
    });
    if (!i) throw notFound('That follow-up is not on your board.');
    res.json({
      interaction: await prisma.employerInteraction.update({
        where: { id: i.id },
        data: { followUpDoneAt: new Date() },
      }),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Drive day                                                                   */
/* -------------------------------------------------------------------------- */

const day = [...campus, requireModule('ops.driveDay'), can('drive:write')];

/** GET /api/ops/drive-day - the college's open drives to pick from. */
opsRouter.get(
  '/drive-day',
  ...day,
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const drives = await prisma.placement.findMany({
      where: { collegeId, isOpen: true },
      orderBy: [{ year: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        year: true,
        type: true,
        _count: { select: { jobPostings: { where: { status: 'ACCEPTED' } }, applications: true } },
      },
    });
    const checkIns = await prisma.driveCheckIn.groupBy({
      by: ['placementId'],
      where: { placementId: { in: drives.map((d) => d.id) } },
      _count: { _all: true },
    });
    const byDrive = new Map(checkIns.map((c) => [c.placementId, c._count._all]));
    res.json({
      drives: drives.map((d) => ({
        id: d.id,
        name: d.name,
        year: d.year,
        type: d.type,
        roles: d._count.jobPostings,
        applications: d._count.applications,
        checkedIn: byDrive.get(d.id) ?? 0,
      })),
    });
  }),
);

/** GET /api/ops/drive-day/:placementId - the live board. */
opsRouter.get(
  '/drive-day/:placementId',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    res.json({ drive: { id: drive.id, name: drive.name, year: drive.year }, ...(await driveBoard(drive.id)) });
  }),
);

/** GET /api/ops/drive-day/:placementId/students - everyone who may walk in. */
opsRouter.get(
  '/drive-day/:placementId/students',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    const [students, checkIns] = await Promise.all([
      driveStudents(drive.id),
      prisma.driveCheckIn.findMany({ where: { placementId: drive.id } }),
    ]);
    const checked = new Map(checkIns.map((c) => [c.candidateId, c]));
    res.json({
      students: students
        .map((s) => ({
          candidateId: s.candidate.id,
          name: s.candidate.user.fullName,
          rollNo: s.rollNo,
          batch: s.batch.name,
          checkedInAt: checked.get(s.candidate.id)?.checkedInAt ?? null,
          method: checked.get(s.candidate.id)?.method ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }),
);

/** POST /api/ops/drive-day/:placementId/rooms */
opsRouter.post(
  '/drive-day/:placementId/rooms',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    const input = z
      .object({
        name: z.string().trim().min(1, 'Name the room.').max(80),
        panel: blank(200),
        jobId: z.string().trim().optional().or(z.literal('')),
      })
      .parse(req.body);
    if (input.jobId) {
      const posted = await prisma.jobPosting.findFirst({
        where: { placementId: drive.id, jobId: input.jobId, status: 'ACCEPTED' },
      });
      if (!posted) throw notFound('That role is not in this drive.');
    }
    res.status(201).json({
      room: await prisma.driveRoom.create({
        data: { placementId: drive.id, name: input.name, panel: input.panel || null, jobId: input.jobId || null },
      }),
    });
  }),
);

/** DELETE /api/ops/drive-day/:placementId/rooms/:roomId */
opsRouter.delete(
  '/drive-day/:placementId/rooms/:roomId',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    const room = await prisma.driveRoom.findFirst({ where: { id: req.params.roomId, placementId: drive.id } });
    if (!room) throw notFound('That room is not in this drive.');
    await prisma.driveRoom.delete({ where: { id: room.id } });
    res.status(204).end();
  }),
);

/** POST /api/ops/drive-day/:placementId/check-in - by scanned pass, typed code or name. */
opsRouter.post(
  '/drive-day/:placementId/check-in',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    const input = z
      .object({
        token: z.string().trim().max(200).optional(),
        code: z.string().trim().max(20).optional(),
        candidateId: z.string().trim().optional(),
        roomId: z.string().trim().optional().nullable(),
      })
      .parse(req.body);
    res.json(await checkIn(drive.id, input));
  }),
);

/** DELETE /api/ops/drive-day/:placementId/check-in/:candidateId - undo a mistaken tick. */
opsRouter.delete(
  '/drive-day/:placementId/check-in/:candidateId',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    await prisma.driveCheckIn.deleteMany({ where: { placementId: drive.id, candidateId: req.params.candidateId } });
    res.status(204).end();
  }),
);

/** GET /api/ops/drive-day/:placementId/attendance.csv */
opsRouter.get(
  '/drive-day/:placementId/attendance.csv',
  ...day,
  asyncHandler(async (req, res) => {
    const drive = await ownDrive(requireCollegeId(req), req.params.placementId!);
    const safe = drive.name.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    res
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance-${safe || 'drive'}.csv"`,
      })
      .send(await attendanceCsv(drive.id));
  }),
);

/**
 * GET /api/ops/drive-pass - the student's passes: one per open drive they sit
 * in, with the signed QR payload and the short code to read out.
 */
opsRouter.get(
  '/drive-pass',
  requireRole('CANDIDATE'),
  requireModule('ops.driveDay'),
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const memberships = await prisma.batchMembership.findMany({
      where: { candidateId },
      select: {
        batch: {
          select: {
            placements: {
              where: { isOpen: true },
              select: { id: true, name: true, year: true, college: { select: { name: true } } },
            },
          },
        },
      },
    });
    const drives = new Map<string, { id: string; name: string; year: number; college: string }>();
    for (const m of memberships) {
      for (const p of m.batch.placements) drives.set(p.id, { id: p.id, name: p.name, year: p.year, college: p.college.name });
    }
    const ids = [...drives.keys()];
    const [checkIns, applications] = await Promise.all([
      prisma.driveCheckIn.findMany({ where: { candidateId, placementId: { in: ids } } }),
      prisma.application.findMany({
        where: { candidateId, placementId: { in: ids } },
        select: {
          placementId: true,
          status: true,
          job: { select: { title: true, company: { select: { name: true } } } },
          currentRound: { select: { name: true, scheduledAt: true, venue: true } },
        },
      }),
    ]);
    res.json({
      passes: [...drives.values()].map((d) => ({
        ...d,
        token: signPass(d.id, candidateId),
        code: shortCode(d.id, candidateId),
        checkedInAt: checkIns.find((c) => c.placementId === d.id)?.checkedInAt ?? null,
        roles: applications
          .filter((a) => a.placementId === d.id)
          .map((a) => ({
            title: a.job.title,
            company: a.job.company.name,
            status: a.status,
            round: a.currentRound?.name ?? null,
            scheduledAt: a.currentRound?.scheduledAt ?? null,
            venue: a.currentRound?.venue ?? null,
          })),
      })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Students who have stalled                                                   */
/* -------------------------------------------------------------------------- */

const risk = [...campus, requireModule('ops.atRisk')];

/** GET /api/ops/at-risk?batchId= */
opsRouter.get(
  '/at-risk',
  ...risk,
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const { batchId } = z.object({ batchId: z.string().trim().optional() }).parse(req.query);
    const [students, batches] = await Promise.all([
      atRiskStudents(collegeId, { batchId: batchId || undefined }),
      prisma.batch.findMany({ where: { collegeId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    res.json({ students, batches, rules: RULES });
  }),
);

/** How long before the same student can be nudged again. */
const NUDGE_GAP_MS = 3 * 24 * 60 * 60 * 1000;
const NUDGE_TYPE = 'placement_cell.check_in';

/** POST /api/ops/at-risk/:candidateId/nudge - a kind note from the placement cell. */
opsRouter.post(
  '/at-risk/:candidateId/nudge',
  ...risk,
  can('student:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const candidate = await prisma.candidate.findFirst({
      where: { id: req.params.candidateId, batchMemberships: { some: { batch: { collegeId } } } },
      select: { id: true, userId: true },
    });
    if (!candidate) throw notFound('That student is not at your college.');

    const recent = await prisma.notification.findFirst({
      where: { userId: candidate.userId, type: NUDGE_TYPE, createdAt: { gt: new Date(Date.now() - NUDGE_GAP_MS) } },
    });
    if (recent) throw conflict('They were sent a note in the last three days. Give it a little time.');

    // The message follows their weightiest flag; the flag itself stays here.
    const [row] = await atRiskStudents(collegeId).then((all) => all.filter((s) => s.candidateId === candidate.id));
    const primary = row?.flags.slice().sort((a, b) => b.weight - a.weight)[0]?.key;
    const college = await prisma.college.findUniqueOrThrow({ where: { id: collegeId }, select: { name: true } });
    const msg = nudgeMessage(primary, college.name);

    const notification = await prisma.notification.create({
      data: {
        userId: candidate.userId,
        type: NUDGE_TYPE,
        title: msg.title,
        body: msg.body,
        link: msg.link,
        payload: { from: 'placement_cell' },
      },
    });
    res.status(201).json({ sent: true, notificationId: notification.id, title: msg.title });
  }),
);
