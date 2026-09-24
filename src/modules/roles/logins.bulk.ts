import { InviteKind, RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { mailIsConfigured } from '../../lib/mailer.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { PLATFORM_PORTAL, portalFor, sendInviteEmail } from '../invites/invite.mail.js';
import { scopeFromKind, wantsEmail, type LoginRow } from './logins.template.js';

/**
 * Handing out logins a file at a time.
 *
 * Every row is resolved and refused on its own. A university onboarding thirty
 * placement officers should not lose the file because row 14 misspelled a
 * college code - the twenty-nine good rows become invitations, and row 14 comes
 * back with the reason so it can be fixed and sent again.
 *
 * Re-uploading is therefore safe: an address that already has an account, or
 * already has an invitation waiting, is skipped rather than duplicated.
 */

const KIND_FOR: Record<RoleScope, InviteKind> = {
  CAMPUS: InviteKind.CAMPUS_MEMBER,
  COMPANY: InviteKind.COMPANY_MEMBER,
  ADMIN: InviteKind.ADMIN_MEMBER,
};

const PERMISSION_FOR: Record<RoleScope, 'account:suspend' | 'login:manage'> = {
  ADMIN: 'account:suspend',
  CAMPUS: 'login:manage',
  COMPANY: 'login:manage',
};

/** What became of the invitation email for one row. */
export type EmailOutcome =
  /** Asked for, and the mail server took it. */
  | { state: 'sent' }
  /** Asked for, and it did not go. The reason is shown against the row. */
  | { state: 'failed'; reason: string }
  /** Not asked for - the Send email column said No, or was left blank. */
  | { state: 'not asked' };

export interface CreatedLogin {
  row: number;
  fullName: string;
  email: string;
  role: string;
  where: string;
  link: string;
  emailed: EmailOutcome;
}

export interface SkippedLogin {
  row: number;
  fullName: string;
  email: string;
  reason: string;
}

export interface LoginIntakeResult {
  created: CreatedLogin[];
  skipped: SkippedLogin[];
  /** Whether this deployment can send at all, so the screen can explain. */
  mailConfigured: boolean;
}

/** Whether the person uploading may hand out a login of this kind. */
export type MayGrant = (permission: 'account:suspend' | 'login:manage') => Promise<boolean>;

const key = (s: string) => s.trim().toLowerCase();

function labelFor(scope: RoleScope): string {
  if (scope === RoleScope.ADMIN) return 'University';
  return scope === RoleScope.CAMPUS ? 'College' : 'Company';
}

export interface AddLoginsOptions {
  sentById: string;
  may: MayGrant;
  /** The institution every login in this file joins, or is fenced inside. */
  tenantId: string;
  /**
   * Whether company rows may be created at all. Companies belong to no
   * tenant, so only the platform team hands out their logins.
   */
  companies: boolean;
}

export async function addLogins(
  rows: LoginRow[],
  options: AddLoginsOptions,
): Promise<LoginIntakeResult> {
  const created: CreatedLogin[] = [];
  const skipped: SkippedLogin[] = [];
  const configured = mailIsConfigured();

  if (rows.length === 0) return { created, skipped, mailConfigured: configured };

  // Named in the email, so a recipient can tell a real invitation from the
  // phishing mail it unavoidably resembles.
  const sender = await prisma.user.findUnique({
    where: { id: options.sentById },
    select: { fullName: true },
  });

  /*
   * Everything a row might name, fetched once. A file of 200 rows would
   * otherwise be 600 lookups of the same handful of colleges.
   */
  // Only this institution's colleges can be named: a code from another tenant
  // reads as "no such college", the same as one that does not exist.
  const [roles, colleges, companies, tenant] = await Promise.all([
    prisma.platformRole.findMany({ select: { id: true, name: true, scope: true, isActive: true } }),
    prisma.college.findMany({
      where: { tenantId: options.tenantId },
      select: { id: true, name: true, code: true },
    }),
    options.companies
      ? prisma.company.findMany({ select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[]),
    prisma.tenant.findUnique({ where: { id: options.tenantId }, select: { name: true } }),
  ]);
  const acrossTenant = tenant?.name ?? 'Across the university';
  const portal = await portalFor(options.tenantId);

  const collegeBy = new Map<string, { id: string; label: string }>();
  for (const c of colleges) {
    const entry = { id: c.id, label: `${c.name} (${c.code})` };
    collegeBy.set(key(c.code), entry);
    collegeBy.set(key(c.name), entry);
  }

  const companyBy = new Map<string, { id: string; label: string }>();
  for (const c of companies) companyBy.set(key(c.name), { id: c.id, label: c.name });

  /*
   * Permission belongs to the uploader, not to the row, so it is settled once.
   * A file nobody may act on then says so on every row, instead of creating
   * the first few and stopping halfway.
   */
  const mayGrant: Record<RoleScope, boolean> = {
    ADMIN: await options.may(PERMISSION_FOR.ADMIN),
    CAMPUS: await options.may(PERMISSION_FOR.CAMPUS),
    COMPANY: options.companies && (await options.may(PERMISSION_FOR.COMPANY)),
  };

  const seen = new Set<string>();

  for (const [index, raw] of rows.entries()) {
    // Row 1 is the header, so the first data row is row 2 - the number the
    // person sees down the side of their own spreadsheet.
    const row = index + 2;
    const fullName = (raw.fullName ?? '').trim();
    const email = key(raw.email ?? '');

    const refuse = (reason: string) => skipped.push({ row, fullName, email, reason });

    if (fullName.length < 2) {
      refuse('No name. An account nobody can identify on a list is not worth creating.');
      continue;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      refuse(email ? `"${raw.email}" is not an email address.` : 'No email address.');
      continue;
    }

    if (seen.has(email)) {
      refuse('This address appears earlier in the file.');
      continue;
    }
    seen.add(email);

    const phone = (raw.phone ?? '').trim();
    if (phone && (phone.match(/\d/g) ?? []).length < 10) {
      refuse(`"${phone}" does not look like a mobile number.`);
      continue;
    }

    /* --- which role, and therefore which world --------------------------- */
    const roleName = (raw.role ?? '').trim();
    if (!roleName) {
      refuse('No role. Pick one from the "Valid values" sheet.');
      continue;
    }

    const kindGiven = (raw.kind ?? '').trim();
    const scope = kindGiven ? scopeFromKind(kindGiven) : null;
    if (kindGiven && !scope) {
      refuse(`"${kindGiven}" is not a kind of login. Use University, College or Company.`);
      continue;
    }

    const named = roles.filter((r) => key(r.name) === key(roleName));
    const matches = scope ? named.filter((r) => r.scope === scope) : named;

    if (matches.length === 0) {
      // Naming a real role but the wrong world is the common mistake, and it
      // is worth saying so rather than claiming the role does not exist.
      if (scope && named.length > 0) {
        const worlds = [...new Set(named.map((r) => r.scope))].map(labelFor).join(' or ');
        refuse(`"${roleName}" is a ${worlds} role, not a ${labelFor(scope)} one.`);
      } else {
        refuse(`There is no role called "${roleName}".`);
      }
      continue;
    }

    if (matches.length > 1) {
      refuse(`More than one role is called "${roleName}". Fill in the Kind column to say which.`);
      continue;
    }

    const role = matches[0]!;
    if (!role.isActive) {
      refuse(`${role.name} has been retired and cannot be given out.`);
      continue;
    }

    if (!mayGrant[role.scope]) {
      refuse(
        role.scope === RoleScope.ADMIN
          ? 'Only an account that can deactivate accounts may create a university login.'
          : `Your role cannot create a ${labelFor(role.scope).toLowerCase()} login.`,
      );
      continue;
    }

    /* --- which organisation ---------------------------------------------- */
    const orgName = (raw.organisation ?? '').trim();
    let collegeId: string | undefined;
    let companyId: string | undefined;
    let where = acrossTenant;

    if (role.scope === RoleScope.CAMPUS) {
      if (!orgName) {
        refuse(`${role.name} works inside one college. Put its code in the last column.`);
        continue;
      }
      const college = collegeBy.get(key(orgName));
      if (!college) {
        refuse(`No college called "${orgName}". The codes are on the last sheet.`);
        continue;
      }
      collegeId = college.id;
      where = college.label;
    } else if (role.scope === RoleScope.COMPANY) {
      if (!orgName) {
        refuse(`${role.name} works inside one company. Put its name in the last column.`);
        continue;
      }
      const company = companyBy.get(key(orgName));
      if (!company) {
        refuse(`No company called "${orgName}" is on the portal.`);
        continue;
      }
      companyId = company.id;
      where = company.label;
    } else if (orgName) {
      // A university role tied to one college is a contradiction, and quietly
      // dropping the column would hand out far more reach than the person
      // filling in the sheet thought they were giving.
      refuse(
        `${role.name} works across the whole university, so it cannot be tied to "${orgName}". Clear the last column, or pick a college role.`,
      );
      continue;
    }

    /* --- and whether they already have one -------------------------------- */
    if (await prisma.user.findUnique({ where: { email } })) {
      refuse('Someone with that email already has an account.');
      continue;
    }

    const waiting = await prisma.invite.findFirst({
      where: { email, acceptedAt: null, revokedAt: null, kind: { not: InviteKind.STUDENT } },
    });
    if (waiting) {
      refuse('An invitation is already waiting for that address.');
      continue;
    }

    const { invite, token } = await createInvite({
      kind: KIND_FOR[role.scope],
      email,
      invitedName: fullName,
      invitedPhone: phone || undefined,
      roleId: role.id,
      collegeId,
      companyId,
      tenantId: role.scope === RoleScope.ADMIN ? options.tenantId : undefined,
      sentById: options.sentById,
    });

    const link = inviteLinkFor(token);

    /*
     * The send happens after the invitation exists, and its failure is
     * recorded rather than thrown. An account that was created is created;
     * a mail server having a bad afternoon must not undo the other 199 rows.
     *
     * Sequential on purpose - a university relay throttles a burst, and the
     * link is in the response either way.
     */
    let emailed: EmailOutcome = { state: 'not asked' };

    if (wantsEmail(raw.sendEmail)) {
      const result = await sendInviteEmail({
        to: email,
        name: fullName,
        link,
        role: role.name,
        where,
        expiresAt: invite.expiresAt,
        invitedBy: sender?.fullName ?? 'A placement administrator',
        ...(companyId ? PLATFORM_PORTAL : portal),
      });

      emailed = result.sent ? { state: 'sent' } : { state: 'failed', reason: result.reason };
    }

    created.push({ row, fullName, email, role: role.name, where, link, emailed });
  }

  return { created, skipped, mailConfigured: configured };
}
