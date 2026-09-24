import { Router } from 'express';
import { z } from 'zod';
import { InviteKind, RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { COMPANY_PUBLIC_SELECT, companyProfileSchema, photosOf, toCompanyData } from './company.schemas.js';
import { saveTenantAsset } from '../tenants/assets.js';
import { imageUpload } from '../../lib/upload.js';
import { canPublish, statusExplanation } from './verification.js';
import { can, permissionsFor } from '../roles/can.js';

export const companyRouter = Router();

companyRouter.use(requireRole('COMPANY'));

/**
 * Only an owner may change the company or its team. Recruiters and
 * interviewers can do the hiring work but not restructure the account.
 */
async function companyOf(userId: string): Promise<string> {
  const member = await prisma.companyMember.findUnique({ where: { userId } });
  if (!member) throw forbidden('This account is not linked to a company.');
  return member.companyId;
}

/**
 * The role being handed out has to be a company role, and still in use. Without
 * this a company could invite somebody into an operations role by posting its
 * id.
 */
async function usableCompanyRole(roleId: string) {
  const role = await prisma.platformRole.findUnique({ where: { id: roleId } });
  if (!role || role.scope !== RoleScope.COMPANY) throw notFound('No such company role.');
  if (!role.isActive) throw conflict(`${role.name} has been retired and cannot be given out.`);
  return role;
}

/** Does this role carry the run-the-account capability? */
const managesTeam = (permissions: unknown) =>
  Array.isArray(permissions) && (permissions as unknown[]).includes('team:manage');

/**
 * How many other people here could still manage the team.
 *
 * Counted from permissions rather than from a role name: a company may have
 * been given more than one role that can manage its team, or have had one
 * renamed. What matters is that somebody is left who can, or the company is
 * locked out of its own account list for good.
 */
async function otherAdminsAt(companyId: string, exceptId: string): Promise<number> {
  const members = await prisma.companyMember.findMany({
    where: { companyId, id: { not: exceptId } },
    select: { role: { select: { permissions: true, isActive: true } } },
  });

  return members.filter((m) => m.role.isActive && managesTeam(m.role.permissions)).length;
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  invitedName: z.string().trim().max(120).optional().or(z.literal('')),
  roleId: z.string().trim().min(1, 'Choose a role.'),
});

/** GET /api/company/overview */
companyRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);

    const [company, jobs, published, applications, pendingInvites] = await Promise.all([
      prisma.company.findUnique({
        where: { id: companyId },
        select: COMPANY_PUBLIC_SELECT,
      }),
      prisma.job.count({ where: { companyId } }),
      prisma.job.count({ where: { companyId, status: 'PUBLISHED' } }),
      prisma.application.count({ where: { job: { companyId } } }),
      prisma.invite.count({ where: { companyId, acceptedAt: null, revokedAt: null } }),
    ]);

    const [me, funnel] = await Promise.all([
      prisma.companyMember.findUnique({
        where: { userId: req.session.userId! },
        select: { role: true },
      }),
      prisma.application.groupBy({
        by: ['status'],
        where: { job: { companyId } },
        _count: { _all: true },
      }),
    ]);

    res.json({
      company: company && {
        ...company,
        photos: photosOf(company.photos),
        isVerified: canPublish(company.status),
        // Said plainly, in the place they will look for it.
        statusNote: statusExplanation(company.status),
      },
      myRole: me?.role ?? null,
      stats: { jobs, published, drafts: jobs - published, applications, pendingInvites },
      funnel: Object.fromEntries(funnel.map((f) => [f.status, f._count._all])),
    });
  }),
);

/**
 * PATCH /api/company/profile - owners only
 *
 * Everything except the name. The name is what a student sees and what
 * operations verified; letting a company rename itself after approval would
 * make the whole review meaningless. Renaming goes through operations.
 */
companyRouter.patch(
  '/profile',
  can('company:profile'),
  asyncHandler(async (req, res) => {
    const companyId = await companyOf(req.session.userId!);
    const data = companyProfileSchema.omit({ name: true }).partial().parse(req.body);

    if (data.industryId) {
      const industry = await prisma.industry.findUnique({ where: { id: data.industryId } });
      if (!industry?.isActive) throw badRequest('Choose an industry from the list.');
    }

    const company = await prisma.company.update({
      where: { id: companyId },
      // An industry off the list and one typed in are two answers to one
      // question, so the newer one replaces the other rather than sitting
      // beside it.
      data: {
        ...toCompanyData(data),
        ...(data.industryId ? { industryOther: null } : {}),
        ...(data.industryOther ? { industryId: null } : {}),
      },
      select: COMPANY_PUBLIC_SELECT,
    });

    res.json({
      company: { ...company, photos: photosOf(company.photos), isVerified: canPublish(company.status) },
    });
  }),
);

/**
 * POST /api/company/uploads/:kind - a logo, a cover or a photograph.
 *
 * The file is stored and its address returned; nothing is written to the
 * company until the profile is saved with that address, so an abandoned
 * upload changes nothing about how the company appears.
 */
companyRouter.post(
  '/uploads/:kind',
  can('company:profile'),
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'logo' && kind !== 'cover' && kind !== 'photo') {
      throw badRequest('Upload a logo, a cover or a photograph.');
    }
    if (!req.file) throw badRequest('Choose an image to upload.');
    res.status(201).json({ url: await saveTenantAsset(kind, req.file.buffer) });
  }),
);

/** GET /api/company/team */
companyRouter.get(
  '/team',
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);

    const [members, invites] = await Promise.all([
      prisma.companyMember.findMany({
        where: { companyId },
        orderBy: { createdAt: 'asc' },
        include: {
        user: { select: { id: true, fullName: true, email: true, isActive: true } },
        // Permissions travel with the role so the screen can say which of
        // these people can manage the team, rather than the reader having to
        // know what each role name happens to carry.
        role: { select: { id: true, name: true, permissions: true } },
      },
      }),
      prisma.invite.findMany({
        where: { companyId, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          invitedName: true,
          expiresAt: true,
          role: { select: { id: true, name: true } },
        },
      }),
    ]);

    res.json({
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        isMe: m.userId === req.session.userId,
        user: m.user,
      })),
      // What this person may do, so the screen can hide what they cannot.
      myPermissions: await permissionsFor(req),
      invites,
    });
  }),
);

/** POST /api/company/team/invites — owners only */
companyRouter.post(
  '/team/invites',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const companyId = await companyOf(req.session.userId!);
    const data = inviteSchema.parse(req.body);
    const role = await usableCompanyRole(data.roleId);

    const { invite, token } = await createInvite({
      kind: InviteKind.COMPANY_MEMBER,
      email: data.email,
      invitedName: data.invitedName ? data.invitedName : undefined,
      companyId,
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

/** DELETE /api/company/team/invites/:id — owners only */
companyRouter.delete(
  '/team/invites/:id',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const companyId = await companyOf(req.session.userId!);

    const result = await prisma.invite.updateMany({
      where: { id: req.params.id, companyId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('No pending invitation to cancel.');

    res.status(204).end();
  }),
);

/**
 * PATCH /api/company/team/:memberId - change what a colleague may do.
 *
 * The company side could only ever set a role at the moment of inviting, so
 * promoting somebody already on the team meant removing them and sending a
 * fresh invitation. Which role they hold is the whole of what they may do,
 * including whether they can manage the team themselves.
 */
companyRouter.patch(
  '/team/:memberId',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const companyId = await companyOf(req.session.userId!);
    const { roleId } = z.object({ roleId: z.string().trim().min(1, 'Choose a role.') }).parse(req.body);

    const member = await prisma.companyMember.findFirst({
      where: { id: req.params.memberId, companyId },
      include: { role: { select: { permissions: true } } },
    });
    if (!member) throw notFound('No such team member.');

    const role = await usableCompanyRole(roleId);

    if (
      managesTeam(member.role.permissions) &&
      !managesTeam(role.permissions) &&
      (await otherAdminsAt(companyId, member.id)) === 0
    ) {
      throw conflict(
        'This is the only person who can manage the team. Give somebody else a role that can, first.',
      );
    }

    const updated = await prisma.companyMember.update({
      where: { id: member.id },
      data: { roleId: role.id },
      include: { role: { select: { id: true, name: true, permissions: true } } },
    });

    res.json({ member: { id: updated.id, role: updated.role } });
  }),
);

/** DELETE /api/company/team/:memberId — never yourself, never the last admin */
companyRouter.delete(
  '/team/:memberId',
  can('team:manage'),
  asyncHandler(async (req, res) => {
    const companyId = await companyOf(req.session.userId!);

    const member = await prisma.companyMember.findFirst({
      where: { id: req.params.memberId, companyId },
      include: { role: { select: { permissions: true } } },
    });
    if (!member) throw notFound('No such team member.');
    if (member.userId === req.session.userId) {
      throw forbidden('You cannot remove yourself from the team.');
    }
    if (managesTeam(member.role.permissions) && (await otherAdminsAt(companyId, member.id)) === 0) {
      throw conflict('This is the only person who can manage the team.');
    }

    await prisma.companyMember.delete({ where: { id: member.id } });
    res.status(204).end();
  }),
);
