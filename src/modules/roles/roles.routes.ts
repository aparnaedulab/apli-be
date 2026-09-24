import { Router } from 'express';
import { z } from 'zod';
import { RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { can } from './can.js';
import { platformWrites } from './platformWrites.js';
import {
  scopeForRole,
  FULL_POWER_KEYS,
  PERMISSIONS,
  SCOPE_PERMISSIONS,
  withinScope,
  type Permission,
} from './permissions.js';

export const rolesRouter = Router();

// Roles are shared by every institution: "Placement officer" means the same
// thing at each. Reading them is ordinary; changing one changes it everywhere,
// so that is the platform's call.
rolesRouter.use(platformWrites);

/*
 * No blanket account-type gate here on purpose.
 *
 * Managing roles is fenced off by `can('role:manage')`, which only an
 * operations role holds - stricter than checking the account type. But the
 * assignable list below has to be readable by a placement officer picking a
 * role for a colleague, and a router-wide ADMIN check would have made the
 * team screens fail with no way to see why.
 */

const roleSchema = z.object({
  name: z.string().trim().min(2, 'Give the role a name.').max(60),
  description: z.string().trim().max(400).optional().or(z.literal('')),
  scope: z.nativeEnum(RoleScope),
  permissions: z.array(z.string()).default([]),
});

const shape = (r: {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  scope: RoleScope;
  permissions: unknown;
  isSystem: boolean;
  isActive: boolean;
  _count?: { campusMembers: number; companyMembers: number; adminMembers: number };
}) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  scope: r.scope,
  permissions: Array.isArray(r.permissions) ? (r.permissions as string[]) : [],
  isSystem: r.isSystem,
  isActive: r.isActive,
  /** Full-power roles cannot have permissions taken away - see below. */
  isLocked: r.key !== null && FULL_POWER_KEYS.has(r.key),
  memberCount: r._count
    ? r._count.campusMembers + r._count.companyMembers + r._count.adminMembers
    : 0,
});

const COUNTS = {
  _count: { select: { campusMembers: true, companyMembers: true, adminMembers: true } },
} as const;

/**
 * GET /api/admin/roles
 *
 * The roles, and the catalogue they are built from. Both in one response
 * because the screen needs the catalogue to render a role at all, and a second
 * request for a constant is a second thing to get out of step.
 */
rolesRouter.get(
  '/',
  can('role:manage'),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.platformRole.findMany({
      orderBy: [{ scope: 'asc' }, { isSystem: 'desc' }, { name: 'asc' }],
      include: COUNTS,
    });

    res.json({
      roles: roles.map(shape),
      catalogue: Object.entries(PERMISSIONS).map(([key, label]) => ({
        key: key as Permission,
        label,
        scopes: (Object.keys(SCOPE_PERMISSIONS) as (keyof typeof SCOPE_PERMISSIONS)[]).filter((s) =>
          SCOPE_PERMISSIONS[s].includes(key as Permission),
        ),
      })),
    });
  }),
);

/** POST /api/admin/roles */
rolesRouter.post(
  '/',
  can('role:manage'),
  asyncHandler(async (req, res) => {
    const data = roleSchema.parse(req.body);

    const clash = await prisma.platformRole.findFirst({
      where: { scope: data.scope, name: data.name },
    });
    if (clash) throw conflict(`There is already a ${data.scope.toLowerCase()} role called ${data.name}.`);

    const role = await prisma.platformRole.create({
      data: {
        name: data.name,
        description: data.description || null,
        scope: data.scope,
        // Silently dropped rather than refused: a permission outside this
        // scope is a mistake in the request, not a decision to honour.
        permissions: withinScope(data.scope, data.permissions),
      },
      include: COUNTS,
    });

    res.status(201).json({ role: shape(role) });
  }),
);

/** PATCH /api/admin/roles/:id */
rolesRouter.patch(
  '/:id',
  can('role:manage'),
  asyncHandler(async (req, res) => {
    const data = roleSchema
      .partial()
      .omit({ scope: true })
      .extend({ isActive: z.boolean().optional() })
      .parse(req.body);

    const role = await prisma.platformRole.findUnique({ where: { id: req.params.id } });
    if (!role) throw notFound('No such role.');

    const locked = role.key !== null && FULL_POWER_KEYS.has(role.key);

    /*
     * The full-power role of each world keeps every permission, always.
     *
     * Take `team:manage` off "Placement officer" and every college is locked
     * out of its own account list at once, with nobody able to put it back.
     * It can be renamed and described freely; what it may do is fixed.
     */
    if (locked && data.permissions) {
      throw forbidden(
        `${role.name} is the role that can do everything for its organisations. Its permissions cannot be reduced — make a new role instead.`,
      );
    }
    if (locked && data.isActive === false) {
      throw forbidden(`${role.name} cannot be retired.`);
    }

    if (data.name && data.name !== role.name) {
      const clash = await prisma.platformRole.findFirst({
        where: { scope: role.scope, name: data.name, id: { not: role.id } },
      });
      if (clash) throw conflict(`There is already a role called ${data.name}.`);
    }

    const updated = await prisma.platformRole.update({
      where: { id: role.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description || null } : {}),
        ...(data.permissions ? { permissions: withinScope(role.scope, data.permissions) } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
      include: COUNTS,
    });

    res.json({ role: shape(updated) });
  }),
);

/**
 * DELETE /api/admin/roles/:id
 *
 * Only while nobody holds it, and never for a role the platform ships. A role
 * in use is retired instead, which keeps it off new invitations without
 * stripping the people who already have it.
 */
rolesRouter.delete(
  '/:id',
  can('role:manage'),
  asyncHandler(async (req, res) => {
    const role = await prisma.platformRole.findUnique({
      where: { id: req.params.id },
      include: COUNTS,
    });
    if (!role) throw notFound('No such role.');

    if (role.isSystem) {
      throw forbidden(`${role.name} ships with the platform and cannot be deleted. Retire it instead.`);
    }

    const held = shape(role).memberCount;
    if (held > 0) {
      throw conflict(
        `${held} ${held === 1 ? 'person holds' : 'people hold'} this role. Retire it instead — they keep it, and it stops appearing on new invitations.`,
      );
    }

    await prisma.platformRole.delete({ where: { id: role.id } });
    res.status(204).end();
  }),
);

/**
 * GET /api/admin/roles/assignable?scope=CAMPUS
 *
 * What a team screen offers. Separate from the list above because inviting a
 * colleague needs no permission to manage roles - only to manage a team.
 *
 * The catalogue for that scope comes with it, so a team screen can say what a
 * role actually lets somebody do. Without it the only honest thing a screen
 * could show was the role's name and a sentence, and "Recruiter" tells you
 * nothing about whether they can publish a role or make an offer - which is
 * the question somebody is asking at the moment they pick one.
 */
rolesRouter.get(
  '/assignable',
  asyncHandler(async (req, res) => {
    const asked = z.object({ scope: z.nativeEnum(RoleScope).optional() }).parse(req.query);

    // A caller may only see roles from their own world. Operations sees any,
    // because it is the one that assigns them everywhere.
    const own = scopeForRole(req.session.role!);
    const scope = own === 'ADMIN' ? (asked.scope ?? RoleScope.ADMIN) : own;
    if (!scope) throw forbidden('This account has no roles to choose from.');
    if (own !== 'ADMIN' && asked.scope && asked.scope !== own) {
      throw forbidden('You can only see roles for your own organisation.');
    }

    const roles = await prisma.platformRole.findMany({
      where: { scope, isActive: true },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, description: true, permissions: true },
    });

    res.json({
      roles,
      // Every capability this kind of account can hold, in the order the
      // catalogue lists them, each with the words a person reads. A role is
      // then simply which of these it has and which it has not.
      catalogue: SCOPE_PERMISSIONS[scope].map((key) => ({ key, label: PERMISSIONS[key] })),
    });
  }),
);
