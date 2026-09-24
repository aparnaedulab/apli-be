import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { CompanyStatus, TenantStatus } from '@prisma/client';
import type { Role, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { unauthorized } from '../../lib/errors.js';
import { readPermissions } from '../roles/can.js';
import type { Permission } from '../roles/permissions.js';

/**
 * Argon2id with deliberately non-default cost. These are the OWASP baseline
 * settings; raising memoryCost is the cheapest way to harden this later.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

/**
 * A throwaway hash, verified against when no account matches the email. Without
 * it, a wrong email returns noticeably faster than a wrong password, which is
 * enough to enumerate who has an account.
 */
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
}

/** What the session needs to know beyond the user id and role. */
export interface SessionScope {
  collegeId?: string;
  companyId?: string;
  candidateId?: string;
  /** The institution the account belongs to. Absent for companies and the platform team. */
  tenantId?: string;
  /** Operations with no tenant: the people who onboard institutions. */
  isPlatform?: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  collegeId?: string;
  companyId?: string;
  candidateId?: string;
  tenantId?: string;
  isPlatform?: boolean;

  /**
   * What this person may do, by name.
   *
   * Sent so a screen can stop offering what the server will refuse. It is a
   * courtesy to the user, never a control: every one of these is checked
   * again on the way in, and a browser that edits this list gains nothing.
   *
   * Empty for a student, who holds no role at all.
   */
  permissions: Permission[];
  /** The role's own name, so a refusal can say which role lacked the power. */
  roleName: string | null;
}

/** What a session payload needs: the scope relations and the role on each. */
const MEMBER_ROLE = {
  select: { name: true, permissions: true, isActive: true },
} as const;

type MemberRole = { name: string; permissions: unknown; isActive: boolean } | null;

type UserWithScope = User & {
  campusMember: { collegeId: string; role: MemberRole; college?: { tenantId: string } } | null;
  companyMember: {
    companyId: string;
    role: MemberRole;
    company?: { status: CompanyStatus; name: string; rejectionReason: string | null };
  } | null;
  adminMember: { role: MemberRole; tenantId?: string | null } | null;
  candidate: {
    id: string;
    college?: { tenantId: string } | null;
    batchMemberships?: { batch: { tenantId: string } }[];
  } | null;
};

/**
 * Everything a session payload needs, in one place.
 *
 * Exported because the invitation flow signs somebody in the moment they
 * accept, and a second hand-written include there is how the two drift: one
 * path would return permissions and the other would quietly return none.
 */
export const SCOPE_INCLUDE = {
  campusMember: {
    select: { collegeId: true, role: MEMBER_ROLE, college: { select: { tenantId: true } } },
  },
  companyMember: {
    select: {
      companyId: true,
      role: MEMBER_ROLE,
      // Read on every sign-in: a company waiting to be reviewed has no portal
      // to be let into yet.
      company: { select: { status: true, name: true, rejectionReason: true } },
    },
  },
  adminMember: { select: { role: MEMBER_ROLE, tenantId: true } },
  candidate: {
    select: {
      id: true,
      college: { select: { tenantId: true } },
      // A student on a university-wide batch has no college; their tenant is
      // the batch's. One row is enough - every batch they sit in is the same
      // institution's.
      batchMemberships: { select: { batch: { select: { tenantId: true } } }, take: 1 },
    },
  },
} as const;

export function scopeOf(user: UserWithScope): SessionScope {
  const scope: SessionScope = {};
  if (user.campusMember) {
    scope.collegeId = user.campusMember.collegeId;
    scope.tenantId = user.campusMember.college?.tenantId;
  }
  if (user.companyMember) scope.companyId = user.companyMember.companyId;
  if (user.candidate) {
    scope.candidateId = user.candidate.id;
    scope.tenantId =
      user.candidate.college?.tenantId ?? user.candidate.batchMemberships?.[0]?.batch.tenantId;
  }
  if (user.adminMember) {
    // Operations with no tenant is the platform team. Undefined (a membership
    // read without the column) is treated as a tenant admin, never as the
    // platform - the wider power has to be positively established.
    if (user.adminMember.tenantId === null) scope.isPlatform = true;
    else if (user.adminMember.tenantId) scope.tenantId = user.adminMember.tenantId;
  }
  return scope;
}

export function toPublicUser(user: UserWithScope): PublicUser {
  // The same precedence the capability middleware uses, for the same reason:
  // an account belongs to one world, and operations outranks the rest.
  const role = (user.adminMember ?? user.campusMember ?? user.companyMember)?.role ?? null;

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    permissions: readPermissions(role),
    roleName: role && role.isActive ? role.name : null,
    ...scopeOf(user),
  };
}

/**
 * Verifies credentials. Every failure returns the same message and takes
 * roughly the same time, so a caller cannot tell a wrong email from a wrong
 * password from a disabled account.
 */
export async function authenticate(email: string, password: string): Promise<UserWithScope> {
  const user = await prisma.user.findUnique({
    where: { email },
    include: SCOPE_INCLUDE,
  });

  const hash = user?.passwordHash ?? (await getDummyHash());
  const passwordMatches = await argon2.verify(hash, password).catch(() => false);

  if (!user || !passwordMatches || !user.isActive) {
    throw unauthorized('Email or password is incorrect.');
  }

  await assertCompanyMayEnter(user);

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return user;
}

/**
 * A company's people wait for the review.
 *
 * Registering says who you are; it does not make you a recruiter on the
 * platform. Only a verified company has a portal to be let into: one waiting
 * to be reviewed has nothing to do inside, and one rejected or suspended has
 * had that decided. Colleges keep everything already in flight either way -
 * what stops is the company's own access, not their records.
 */
async function assertCompanyMayEnter(user: UserWithScope): Promise<void> {
  const company = user.companyMember?.company;
  if (!company) return;

  if (company.status === CompanyStatus.PENDING) {
    // Institutions decide this during onboarding. One account serves every
    // institution, so one of them saying "let them in while we check" is
    // enough for the door - and the door is all it opens: an unverified
    // company can draft, and reaches nobody until it is verified.
    const openDoor = await prisma.tenant.findFirst({
      where: { status: TenantStatus.ACTIVE, unverifiedCompanyAccess: true },
      select: { id: true },
    });
    if (openDoor) return;

    throw unauthorized(
      `${company.name} is still being reviewed. We will email you as soon as it is done, and you can sign in then.`,
    );
  }
  if (company.status === CompanyStatus.REJECTED) {
    throw unauthorized(
      company.rejectionReason
        ? `${company.name} was not accepted: ${company.rejectionReason}`
        : `${company.name} was not accepted on the platform.`,
    );
  }
  if (company.status === CompanyStatus.SUSPENDED) {
    throw unauthorized(
      company.rejectionReason
        ? `${company.name} is suspended: ${company.rejectionReason}`
        : `${company.name} is suspended. Write to us if you think that is a mistake.`,
    );
  }
}

/**
 * Re-reads the signed-in user. Called on every /me so that deactivating an
 * account takes effect immediately rather than when their cookie expires.
 */
export async function getActiveUser(userId: string): Promise<UserWithScope> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: SCOPE_INCLUDE,
  });

  if (!user || !user.isActive) throw unauthorized('Your session is no longer valid.');
  // Rejected mid-session ends the session on the next request, the same way
  // a deactivated account does.
  await assertCompanyMayEnter(user);
  return user;
}
