import { Router } from 'express';
import { z } from 'zod';
import { InviteKind, RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { can, permissionsFor } from '../roles/can.js';

export const campusTeamRouter = Router();

campusTeamRouter.use(requireRole('CAMPUS'));

/**
 * Only a placement officer may change the team.
 *
 * This mirrors the company side: operations creates one account for the
 * college, and that person builds the rest of their own team. A coordinator
 * does the placement work but cannot create further logins - otherwise the
 * college's account list could grow without the officer knowing.
 */
async function collegeOf(userId: string): Promise<string> {
  const member = await prisma.campusMember.findUnique({ where: { userId } });
  if (!member) throw forbidden('This account is not linked to a college.');
  return member.collegeId;
}

/**
 * The role being handed out has to be a college role, and one that is still in
 * use. Without this check a college could invite somebody straight into an
 * operations role by posting its id.
 */
async function usableCampusRole(roleId: string) {
  const role = await prisma.platformRole.findUnique({ where: { id: roleId } });
  if (!role || role.scope !== RoleScope.CAMPUS) throw notFound('No such college role.');
  if (!role.isActive) throw conflict(`${role.name} has been retired and cannot be given out.`);
  return role;
}

/**
 * How many people at this college could still manage the team if `exceptId`
 * were changed or removed.
 *
 * The rule used to be "keep one TPO", which stopped meaning anything the
 * moment roles became data - a college might have three roles that can manage
 * a team, or have renamed the officer. What actually matters is that somebody
 * is left who can, so that is what gets counted.
 */
async function otherManagersAt(collegeId: string, exceptId: string): Promise<number> {
  const members = await prisma.campusMember.findMany({
    where: { collegeId, id: { not: exceptId } },
    select: { role: { select: { permissions: true, isActive: true } } },
  });

  return members.filter(
    (m) =>
      m.role.isActive &&
      Array.isArray(m.role.permissions) &&
      (m.role.permissions as unknown[]).includes('team:manage'),
  ).length;
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  invitedName: z.string().trim().max(120).optional().or(z.literal('')),
  roleId: z.string().trim().min(1, 'Choose a role.'),
});

/** GET /api/campus/team */
campusTeamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    const [members, invites, me] = await Promise.all([
      prisma.campusMember.findMany({
        where: { collegeId },
        orderBy: [{ createdAt: 'asc' }],
        include: {
          user: { select: { id: true, fullName: true, email: true, isActive: true } },
          role: { select: { id: true, name: true } },
        },
      }),
      prisma.invite.findMany({
        where: { collegeId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          invitedName: true,
          expiresAt: true,
          role: { select: { id: true, name: true } },
        },
      }),
      prisma.campusMember.findUnique({
        where: { userId: req.session.userId! },
        select: { role: { select: { id: true, name: true } } },
      }),
    ]);

    res.json({
      myRole: me?.role ?? null,
      // What this person may do, so the screen can hide what they cannot.
      myPermissions: await permissionsFor(req),
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        isMe: m.userId === req.session.userId,
        joinedAt: m.createdAt,
        user: m.user,
      })),
      invites,
    });
  }),
);

/** POST /api/campus/team/invites — placement officer only */
campusTeamRouter.post(
  '/invites',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const collegeId = await collegeOf(req.session.userId!);
    const data = inviteSchema.parse(req.body);

    const role = await usableCampusRole(data.roleId);

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

/** DELETE /api/campus/team/invites/:id */
campusTeamRouter.delete(
  '/invites/:id',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const collegeId = await collegeOf(req.session.userId!);

    const result = await prisma.invite.updateMany({
      where: { id: req.params.id, collegeId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('No pending invitation to cancel.');

    res.status(204).end();
  }),
);

/** PATCH /api/campus/team/:memberId — promote or demote */
campusTeamRouter.patch(
  '/:memberId',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const collegeId = await collegeOf(req.session.userId!);
    const { roleId } = z.object({ roleId: z.string().trim().min(1) }).parse(req.body);

    const member = await prisma.campusMember.findFirst({
      where: { id: req.params.memberId, collegeId },
      include: { role: { select: { permissions: true } } },
    });
    if (!member) throw notFound('No such team member.');

    const role = await usableCampusRole(roleId);

    const wasManager =
      Array.isArray(member.role.permissions) &&
      (member.role.permissions as unknown[]).includes('team:manage');
    const willManage = (role.permissions as unknown[]).includes('team:manage');

    // Somebody has to be left who can manage the team, or the college is
    // locked out of its own account list for good.
    if (wasManager && !willManage && (await otherManagersAt(collegeId, member.id)) === 0) {
      throw conflict(
        'This is the only person who can manage the team. Give somebody else a role that can, first.',
      );
    }

    const updated = await prisma.campusMember.update({
      where: { id: member.id },
      data: { roleId: role.id },
      include: { role: { select: { id: true, name: true } } },
    });

    res.json({ member: updated });
  }),
);

/** DELETE /api/campus/team/:memberId — never yourself, never the last officer */
campusTeamRouter.delete(
  '/:memberId',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const collegeId = await collegeOf(req.session.userId!);

    const member = await prisma.campusMember.findFirst({
      where: { id: req.params.memberId, collegeId },
      include: { role: { select: { permissions: true } } },
    });
    if (!member) throw notFound('No such team member.');
    if (member.userId === req.session.userId) {
      throw forbidden('You cannot remove yourself from the team.');
    }

    const wasManager =
      Array.isArray(member.role.permissions) &&
      (member.role.permissions as unknown[]).includes('team:manage');

    if (wasManager && (await otherManagersAt(collegeId, member.id)) === 0) {
      throw conflict('This is the only person who can manage the team.');
    }

    await prisma.campusMember.delete({ where: { id: member.id } });
    res.status(204).end();
  }),
);
