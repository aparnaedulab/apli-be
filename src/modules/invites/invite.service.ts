import { createHash, randomBytes } from 'node:crypto';
import { CampusRole, CompanyRole, InviteKind, Role, type Invite } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword, SCOPE_INCLUDE } from '../auth/auth.service.js';
import { env } from '../../config/env.js';

const INVITE_TTL_DAYS = 7;

/** Which account role each kind of invite creates. */
const ROLE_FOR: Record<InviteKind, Role> = {
  STUDENT: Role.CANDIDATE,
  CAMPUS_MEMBER: Role.CAMPUS,
  COMPANY_MEMBER: Role.COMPANY,
  ADMIN_MEMBER: Role.ADMIN,
};

/**
 * The token is a bearer credential - whoever holds the link becomes the
 * account. We store only its hash, so a leaked database does not hand anyone
 * working invite links, exactly as with passwords.
 */
function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** The URL an invitee opens. One definition, so every caller agrees. */
export function inviteLinkFor(token: string): string {
  return `${env.CLIENT_ORIGIN}/invite/${token}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateInviteInput {
  kind: InviteKind;
  email: string;
  invitedName?: string;
  collegeId?: string;
  companyId?: string;
  batchId?: string;
  /** For an operations invitation: the institution the new admin will run. */
  tenantId?: string;
  roleId?: string;
  /** Carried onto the account when the invitation is accepted. */
  invitedPhone?: string;
  campusRole?: CampusRole;
  companyRole?: CompanyRole;
  /** Set when the account already exists and this invite only activates it. */
  userId?: string;
  sentById: string;
}

/**
 * Creates an invite and returns the raw token exactly once. It is never
 * readable again - if it is lost, the invite is revoked and reissued.
 */
export async function createInvite(
  input: CreateInviteInput,
): Promise<{ invite: Invite; token: string }> {
  const email = input.email.trim().toLowerCase();

  // An invitation that activates a pre-created account is expected to find a
  // user; one that creates an account must not.
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser && existingUser.id !== input.userId) {
    throw conflict('Someone with that email address already has an account.');
  }

  // One live invite per email. Reissuing supersedes the old link rather than
  // leaving two working ones in circulation.
  await prisma.invite.updateMany({
    where: { email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const { token, tokenHash } = mintToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const invite = await prisma.invite.create({
    data: {
      kind: input.kind,
      email,
      invitedName: input.invitedName ?? null,
      invitedPhone: input.invitedPhone ?? null,
      tokenHash,
      collegeId: input.collegeId ?? null,
      companyId: input.companyId ?? null,
      batchId: input.batchId ?? null,
      tenantId: input.tenantId ?? null,
      roleId: input.roleId ?? null,
      campusRole: input.campusRole ?? null,
      companyRole: input.companyRole ?? null,
      userId: input.userId ?? null,
      sentById: input.sentById,
      expiresAt,
    },
  });

  return { invite, token };
}

export interface InvitePreview {
  kind: InviteKind;
  email: string;
  invitedName: string | null;
  organisation: string | null;
  role: Role;
  expiresAt: Date;
}

type InviteWithOrgs = Invite & {
  tenant: { name: string } | null;
  college: { name: string } | null;
  company: { name: string } | null;
  batch: { name: string; college: { name: string } | null } | null;
};

/** Loads a live invite, or explains why it is not usable. */
async function loadUsableInvite(token: string): Promise<InviteWithOrgs> {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      tenant: { select: { name: true } },
      college: { select: { name: true } },
      company: { select: { name: true } },
      batch: { select: { name: true, college: { select: { name: true } } } },
    },
  });

  if (!invite) throw notFound('This invitation link is not valid.');
  if (invite.acceptedAt) throw badRequest('This invitation has already been used.');
  if (invite.revokedAt) throw badRequest('This invitation was cancelled. Ask for a new one.');
  if (invite.expiresAt.getTime() < Date.now()) {
    throw badRequest('This invitation has expired. Ask for a new one.');
  }

  return invite;
}

function organisationOf(invite: InviteWithOrgs): string | null {
  return (
    invite.college?.name ??
    invite.batch?.college?.name ??
    invite.company?.name ??
    invite.tenant?.name ??
    null
  );
}

/** What the accept page shows before anyone types a password. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const invite = await loadUsableInvite(token);
  return {
    kind: invite.kind,
    email: invite.email,
    invitedName: invite.invitedName,
    organisation: organisationOf(invite),
    role: ROLE_FOR[invite.kind],
    expiresAt: invite.expiresAt,
  };
}

export interface AcceptInviteInput {
  fullName: string;
  password: string;
}

/**
 * Redeems an invite. The user and their membership row are created together,
 * and the invite is closed in the same transaction - so a crash halfway cannot
 * leave an account with no organisation, or a spent invite with no account.
 */
export async function acceptInvite(token: string, input: AcceptInviteInput) {
  const invite = await loadUsableInvite(token);
  const role = ROLE_FOR[invite.kind];
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    // Two shapes of invitation. One activates an account somebody already
    // entered on a roster; the other creates the account from scratch.
    if (invite.userId) {
      const user = await tx.user.update({
        where: { id: invite.userId },
        data: {
          fullName: input.fullName.trim(),
          passwordHash,
          isActive: true,
          // Only fills a gap; a number the person already has is theirs.
          ...(invite.invitedPhone ? { phone: invite.invitedPhone } : {}),
        },
      });

      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });

      return tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: SCOPE_INCLUDE,
      });
    }

    const taken = await tx.user.findUnique({ where: { email: invite.email } });
    if (taken) throw conflict('Someone with that email address already has an account.');

    const user = await tx.user.create({
      data: {
        email: invite.email,
        fullName: input.fullName.trim(),
        phone: invite.invitedPhone,
        passwordHash,
        role,
      },
    });

    if (invite.kind === InviteKind.CAMPUS_MEMBER) {
      if (!invite.collegeId) throw badRequest('This invitation is missing its college.');
      await tx.campusMember.create({
        data: {
          userId: user.id,
          collegeId: invite.collegeId,
          roleId: invite.roleId!,
        },
      });
    }

    if (invite.kind === InviteKind.COMPANY_MEMBER) {
      if (!invite.companyId) throw badRequest('This invitation is missing its company.');
      await tx.companyMember.create({
        data: {
          userId: user.id,
          companyId: invite.companyId,
          roleId: invite.roleId!,
        },
      });
    }

    if (invite.kind === InviteKind.ADMIN_MEMBER) {
      // Operations belongs to no college or company. With a tenant on the
      // invitation it runs that institution; without one it is the platform
      // team, whose reach is every institution.
      await tx.adminMember.create({
        data: { userId: user.id, roleId: invite.roleId!, tenantId: invite.tenantId },
      });
    }

    if (invite.kind === InviteKind.STUDENT) {
      if (!invite.batchId) throw badRequest('This invitation is missing its batch.');
      const batch = await tx.batch.findUnique({
        where: { id: invite.batchId },
        select: { collegeId: true, graduationYear: true },
      });
      if (!batch) throw notFound('The batch for this invitation no longer exists.');

      const candidate = await tx.candidate.create({
        data: {
          userId: user.id,
          collegeId: batch.collegeId,
          graduationYear: batch.graduationYear,
        },
      });
      await tx.batchMembership.create({
        data: { batchId: invite.batchId, candidateId: candidate.id },
      });
    }

    await tx.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    // Re-read with the scope relations the session needs.
    return tx.user.findUniqueOrThrow({
      where: { id: user.id },
      include: SCOPE_INCLUDE,
    });
  });
}
