import { Router } from 'express';
import { z } from 'zod';
import { InviteKind, RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../lib/errors.js';
import { asWorkbook, workbookUpload } from '../../lib/upload.js';
import { can, hasPermission } from './can.js';
import { inTenant, isPlatform, requireTenantId } from '../tenants/tenant.context.js';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import { PLATFORM_PORTAL, portalFor, sendInviteEmail } from '../invites/invite.mail.js';
import { mailIsConfigured, mailFrom } from '../../lib/mailer.js';
import { addLogins } from './logins.bulk.js';
import {
  buildLoginTemplate,
  parseLoginRows,
  parseLoginWorkbook,
  type LoginRow,
} from './logins.template.js';

export const accessRouter = Router();

accessRouter.use(requireRole('ADMIN'));

/**
 * Every login in the institution that holds a role, and how to make another.
 *
 * Colleges and companies build their own teams; this is the institution's view
 * across its colleges, and the only place an operations login can be created at
 * all - until now that took a command-line script and a developer.
 *
 * Fenced to the session's tenant throughout. An operations login made here
 * runs this institution, never the platform. Company logins are the exception:
 * a company belongs to no tenant and hires at all of them, so seeing and
 * handing out company logins is the platform team's work alone.
 *
 * Students are absent. They hold no role, they arrive on a college roster, and
 * a screen that offered to "create a student login" would be offering to
 * bypass the roster that makes a student record trustworthy.
 */

const KIND_FOR: Record<RoleScope, InviteKind> = {
  CAMPUS: InviteKind.CAMPUS_MEMBER,
  COMPANY: InviteKind.COMPANY_MEMBER,
  ADMIN: InviteKind.ADMIN_MEMBER,
};

/**
 * Who may hand out a login of each kind.
 *
 * Making an operations login is how somebody would grant themselves
 * everything, so it takes `account:suspend` - the permission that can also
 * take an account away, and one University admin does not hold. Creating a
 * college or company login is ordinary onboarding work.
 */
const PERMISSION_FOR: Record<RoleScope, 'account:suspend' | 'login:manage'> = {
  ADMIN: 'account:suspend',
  CAMPUS: 'login:manage',
  COMPANY: 'login:manage',
};

/** Whether this caller may see and manage company logins at all. */
const handlesCompanies = (req: Request) => isPlatform(req);

/**
 * The pending invitations this caller may see and cancel: the tenant's own,
 * and for the platform team also the company ones, which have no tenant.
 */
function visibleInvites(req: Request): Prisma.InviteWhereInput {
  const own = inTenant.invite(requireTenantId(req));
  return handlesCompanies(req) ? { OR: [own, { kind: InviteKind.COMPANY_MEMBER }] } : own;
}

const inviteSchema = z
  .object({
    /** Required: an account with no name is one nobody can identify on a list. */
    invitedName: z.string().trim().min(2, 'Enter their name.').max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.'),

    /*
     * Optional, because an invitation often starts from an email address and
     * nothing else - but worth asking for, since a mobile number is how
     * anybody gets chased when the link never arrives.
     *
     * Loose on purpose: numbers arrive as 9000000000, +91 90000 00000 and
     * 090000-00000. Ten digits somewhere in there is the only real check.
     */
    phone: z
      .string()
      .trim()
      .max(24)
      .optional()
      .or(z.literal(''))
      .refine((v) => !v || (v.match(/\d/g) ?? []).length >= 10, {
        message: 'That does not look like a mobile number.',
      }),

    roleId: z.string().trim().min(1, 'Choose a role.'),
    collegeId: z.string().trim().optional(),
    companyId: z.string().trim().optional(),

    /*
     * Whether to email them the link, or hand it over some other way.
     *
     * Defaulted off rather than on: sending is an outward-facing act, and the
     * form shows a ticked-by-default box only because one person is in front
     * of whoever ticks it. A caller that omits the field entirely - a script,
     * an older client - sends nothing.
     */
    sendEmail: z.boolean().default(false),
  })
  .strict();

/** GET /api/admin/access — everyone with a role, and every pending invitation. */
accessRouter.get(
  '/',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const { scope, q } = z
      .object({
        scope: z.nativeEnum(RoleScope).optional(),
        q: z.string().trim().max(120).optional(),
      })
      .parse(req.query);

    const tenantId = requireTenantId(req);
    const nameOrEmail = q
      ? { OR: [{ fullName: { contains: q } }, { email: { contains: q } }] }
      : {};

    const [admins, campus, company, invites] = await Promise.all([
      scope && scope !== RoleScope.ADMIN
        ? []
        : prisma.adminMember.findMany({
            where: { user: nameOrEmail, tenantId },
            include: {
              user: { select: { id: true, fullName: true, email: true, phone: true, isActive: true } },
              role: { select: { id: true, name: true } },
            },
          }),
      scope && scope !== RoleScope.CAMPUS
        ? []
        : prisma.campusMember.findMany({
            where: { user: nameOrEmail, college: { tenantId } },
            include: {
              user: { select: { id: true, fullName: true, email: true, phone: true, isActive: true } },
              role: { select: { id: true, name: true } },
              college: { select: { id: true, name: true, code: true } },
            },
          }),
      (scope && scope !== RoleScope.COMPANY) || !handlesCompanies(req)
        ? []
        : prisma.companyMember.findMany({
            where: { user: nameOrEmail },
            include: {
              user: { select: { id: true, fullName: true, email: true, phone: true, isActive: true } },
              role: { select: { id: true, name: true } },
              company: { select: { id: true, name: true } },
            },
          }),
      prisma.invite.findMany({
        where: {
          AND: [
            visibleInvites(req),
            { acceptedAt: null, revokedAt: null, kind: { not: InviteKind.STUDENT } },
            q ? { email: { contains: q } } : {},
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          role: { select: { id: true, name: true, scope: true } },
          college: { select: { name: true } },
          company: { select: { name: true } },
        },
      }),
    ]);

    const people = [
      ...admins.map((m) => ({
        membershipId: m.id,
        scope: RoleScope.ADMIN,
        user: m.user,
        role: m.role,
        org: null as { id: string; name: string } | null,
        joinedAt: m.createdAt,
      })),
      ...campus.map((m) => ({
        membershipId: m.id,
        scope: RoleScope.CAMPUS,
        user: m.user,
        role: m.role,
        org: { id: m.college.id, name: `${m.college.name} (${m.college.code})` },
        joinedAt: m.createdAt,
      })),
      ...company.map((m) => ({
        membershipId: m.id,
        scope: RoleScope.COMPANY,
        user: m.user,
        role: m.role,
        org: { id: m.company.id, name: m.company.name },
        joinedAt: m.createdAt,
      })),
    ].sort((a, z) => a.user.fullName.localeCompare(z.user.fullName));

    res.json({
      people,
      invites: invites
        .filter((i) => !scope || i.role?.scope === scope)
        .map((i) => ({
          id: i.id,
          email: i.email,
          invitedName: i.invitedName,
          phone: i.invitedPhone,
          role: i.role,
          org: i.college?.name ?? i.company?.name ?? null,
          expiresAt: i.expiresAt,
        })),
      // What this admin may hand out, so the screen offers only those.
      canCreate: {
        ADMIN: await hasPermission(req, 'account:suspend'),
        CAMPUS: await hasPermission(req, 'login:manage'),
        COMPANY: handlesCompanies(req) && (await hasPermission(req, 'login:manage')),
      },

      // So the screen can offer to send, or explain why it cannot, rather
      // than showing a tickbox that quietly does nothing.
      mail: { configured: mailIsConfigured(), from: mailFrom() },
    });
  }),
);

/**
 * POST /api/admin/access/invites
 *
 * One endpoint for every kind of login, because they differ only in which
 * organisation the person is attached to. The role decides the rest.
 */
accessRouter.post(
  '/invites',
  asyncHandler(async (req, res) => {
    const data = inviteSchema.parse(req.body);

    const role = await prisma.platformRole.findUnique({ where: { id: data.roleId } });
    if (!role) throw notFound('No such role.');
    if (!role.isActive) throw conflict(`${role.name} has been retired and cannot be given out.`);

    if (!(await hasPermission(req, PERMISSION_FOR[role.scope]))) {
      throw forbidden(
        role.scope === RoleScope.ADMIN
          ? 'Only an account that can deactivate accounts may create an operations login.'
          : `Your role cannot create a ${role.scope.toLowerCase()} login.`,
      );
    }

    // A role belongs to a world, and that world decides what else is needed:
    // a college role without a college would be a login attached to nothing.
    let collegeId: string | undefined;
    let companyId: string | undefined;

    const tenantId = requireTenantId(req);
    let tenantName: string | undefined;

    if (role.scope === RoleScope.CAMPUS) {
      if (!data.collegeId) throw conflict('Choose which college this login is for.');
      if (!(await prisma.college.findFirst({ where: { id: data.collegeId, tenantId } }))) {
        throw notFound('No such college.');
      }
      collegeId = data.collegeId;
    }

    if (role.scope === RoleScope.ADMIN) {
      tenantName = (await prisma.tenant.findUnique({ where: { id: tenantId } }))?.name;
    }

    if (role.scope === RoleScope.COMPANY) {
      if (!handlesCompanies(req)) {
        throw forbidden('Company logins are managed by the platform team.');
      }
      if (!data.companyId) throw conflict('Choose which company this login is for.');
      if (!(await prisma.company.findUnique({ where: { id: data.companyId } }))) {
        throw notFound('No such company.');
      }
      companyId = data.companyId;
    }

    if (await prisma.user.findUnique({ where: { email: data.email } })) {
      throw conflict('Someone with that email already has an account.');
    }

    const { invite, token } = await createInvite({
      kind: KIND_FOR[role.scope],
      email: data.email,
      invitedName: data.invitedName,
      invitedPhone: data.phone ? data.phone : undefined,
      roleId: role.id,
      collegeId,
      companyId,
      // An operations login made here runs this institution. The platform
      // team itself is never created through a tenant's screen.
      tenantId: role.scope === RoleScope.ADMIN ? tenantId : undefined,
      sentById: req.session.userId!,
    });

    const link = inviteLinkFor(token);

    /*
     * Sent after the invitation exists, and a failure is reported rather than
     * thrown. The invitation is real either way, and the response carries the
     * link regardless - so a mail server that is down costs a copy-and-paste,
     * not an account.
     */
    let emailed: { state: 'sent' } | { state: 'failed'; reason: string } | { state: 'not asked' } =
      { state: 'not asked' };

    if (data.sendEmail) {
      const sender = await prisma.user.findUnique({
        where: { id: req.session.userId! },
        select: { fullName: true },
      });

      const result = await sendInviteEmail({
        to: invite.email,
        name: data.invitedName,
        link,
        role: role.name,
        where:
          (collegeId
            ? (await prisma.college.findUnique({ where: { id: collegeId } }))?.name
            : companyId
              ? (await prisma.company.findUnique({ where: { id: companyId } }))?.name
              : (tenantName ?? 'Across the university')) ?? 'Across the university',
        expiresAt: invite.expiresAt,
        invitedBy: sender?.fullName ?? 'A placement administrator',
        // A company belongs to the platform, not this institution.
        ...(companyId ? PLATFORM_PORTAL : await portalFor(tenantId)),
      });

      emailed = result.sent ? { state: 'sent' } : { state: 'failed', reason: result.reason };
    }

    res.status(201).json({
      invite: {
        id: invite.id,
        email: invite.email,
        invitedName: invite.invitedName,
        phone: invite.invitedPhone,
        role: { id: role.id, name: role.name, scope: role.scope },
        expiresAt: invite.expiresAt,
      },
      link,
      emailed,
    });
  }),
);

/** DELETE /api/admin/access/invites/:id */
accessRouter.delete(
  '/invites/:id',
  asyncHandler(async (req, res) => {
    const result = await prisma.invite.updateMany({
      where: {
        AND: [{ id: req.params.id, acceptedAt: null, revokedAt: null }, visibleInvites(req)],
      },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('No pending invitation to cancel.');
    res.status(204).end();
  }),
);

/**
 * GET /api/admin/access/bulk/template
 *
 * Generated per request, so the Role dropdown holds the roles that exist right
 * now and the last sheet lists the colleges and companies actually on the
 * portal. A static file would go stale the first time somebody invents a role.
 */
accessRouter.get(
  '/bulk/template',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const buffer = await buildLoginTemplate({
      tenantId: requireTenantId(req),
      includeCompanies: handlesCompanies(req),
    });
    res.set(asWorkbook('apli-logins.xlsx')).send(Buffer.from(buffer));
  }),
);

/**
 * POST /api/admin/access/bulk
 *
 * A filled-in workbook, a pasted block, or rows typed straight in - all three
 * become the same list and go through the same importer, so no two doors can
 * disagree about what is acceptable.
 *
 * The response carries a one-time link per login created. Each one is a
 * credential: whoever holds it becomes that person.
 */
accessRouter.post(
  '/bulk',
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    let rows: LoginRow[] = [];

    if (req.file) {
      rows = /\.csv$/i.test(req.file.originalname)
        ? parseLoginRows(req.file.buffer.toString('utf8'))
        : await parseLoginWorkbook(req.file.buffer);
    } else if (typeof req.body?.paste === 'string' && req.body.paste.trim()) {
      rows = parseLoginRows(req.body.paste);
    } else if (Array.isArray(req.body?.rows)) {
      rows = z
        .array(
          z
            .object({
              fullName: z.string().trim().max(120).default(''),
              email: z.string().trim().max(200).default(''),
              phone: z.string().trim().max(24).optional(),
              kind: z.string().trim().max(40).optional(),
              role: z.string().trim().max(120).optional(),
              organisation: z.string().trim().max(200).optional(),
            })
            .strip(),
        )
        .max(500)
        .parse(req.body.rows);
    } else {
      throw badRequest('Attach a filled-in file, or paste the rows.');
    }

    if (rows.length === 0) {
      throw badRequest(
        'No people found in that file. Check the first row names the columns - the template shows the shape.',
      );
    }

    if (rows.length > 500) {
      throw badRequest(
        `That file holds ${rows.length} rows. Send at most 500 at a time, so a mistake stays small.`,
      );
    }

    const result = await addLogins(rows, {
      sentById: req.session.userId!,
      may: (permission) => hasPermission(req, permission),
      tenantId: requireTenantId(req),
      companies: handlesCompanies(req),
    });

    res.status(201).json({
      ...result,
      fileName: req.file?.originalname ?? null,
      rowsRead: rows.length,
    });
  }),
);

/**
 * PATCH /api/admin/access/:scope/:membershipId — change somebody's role.
 *
 * Only within the same world: moving a placement officer to an operations role
 * would leave a membership row pointing at a role that means nothing for it.
 */
accessRouter.patch(
  '/:scope/:membershipId',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const { scope } = z.object({ scope: z.nativeEnum(RoleScope) }).parse(req.params);
    const { roleId } = z.object({ roleId: z.string().trim().min(1) }).parse(req.body);

    const role = await prisma.platformRole.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== scope) throw notFound('No such role for this kind of account.');
    if (!role.isActive) throw conflict(`${role.name} has been retired.`);

    const id = req.params.membershipId!;

    /*
     * Handing out a university role is gated the same way whether it is done
     * by creating a login or by re-roling one that exists. Without this, an
     * account that may not create a university login could promote one that
     * already exists to Super admin and reach everything through it.
     */
    if (!(await hasPermission(req, PERMISSION_FOR[scope]))) {
      throw forbidden(
        scope === RoleScope.ADMIN
          ? 'Only an account that can deactivate accounts may change a university role.'
          : `Your role cannot change a ${scope.toLowerCase()} role.`,
      );
    }

    const tenantId = requireTenantId(req);

    if (scope === RoleScope.ADMIN) {
      const member = await prisma.adminMember.findFirst({ where: { id, tenantId } });
      if (!member) throw notFound('No such account.');

      // The platform must keep somebody who can manage accounts and roles.
      if (member.userId === req.session.userId) {
        throw forbidden('You cannot change your own role.');
      }

      await prisma.adminMember.update({ where: { id }, data: { roleId: role.id } });
    } else if (scope === RoleScope.CAMPUS) {
      const member = await prisma.campusMember.findFirst({
        where: { id, college: { tenantId } },
      });
      if (!member) throw notFound('No such account.');
      await prisma.campusMember.update({ where: { id }, data: { roleId: role.id } });
    } else {
      if (!handlesCompanies(req)) {
        throw forbidden('Company logins are managed by the platform team.');
      }
      const member = await prisma.companyMember.findUnique({ where: { id } });
      if (!member) throw notFound('No such account.');
      await prisma.companyMember.update({ where: { id }, data: { roleId: role.id } });
    }

    res.json({ ok: true });
  }),
);
