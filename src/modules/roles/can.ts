import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { isPermission, type Permission } from './permissions.js';

/**
 * What the signed-in person may do, and the one way to ask.
 *
 * Handlers name a capability - `can('student:verify')` - never a role. Roles are
 * data now: operations can invent a "Verifier" role tomorrow, and a handler
 * that had checked `role === TPO` would refuse it for no reason anybody could
 * explain.
 *
 * This is the fourth layer, not a replacement for any of the others. Layer one
 * still demands a session, layer two still fences off each router by account
 * type, and layer three still narrows every query to the caller's own college
 * or company. A permission says what you may do; it never widens whose rows
 * you may touch.
 */

interface Grant {
  roleId: string;
  roleName: string;
  permissions: Permission[];
}

/**
 * Cached on the request. `undefined` means "not looked up yet"; `null` means
 * "looked up, and this caller has no usable role" - a distinction a plain
 * optional could not make.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      grant?: Grant | null;
    }
  }
}

/**
 * Read once per request, not per check.
 *
 * A handler may ask twice, and the answer cannot change inside one request.
 */
/**
 * The permissions on a role row, as a list this code trusts.
 *
 * Shared so that what the session tells a browser and what the middleware
 * enforces cannot drift: a screen that hid a button the server would have
 * allowed, or showed one it refuses, is the bug this prevents.
 */
export function readPermissions(
  role: { permissions: unknown; isActive: boolean } | null | undefined,
): Permission[] {
  // A retired role grants nothing. Deactivating one is how operations takes a
  // capability back from everybody holding it at once.
  if (!role || !role.isActive) return [];

  return Array.isArray(role.permissions)
    ? (role.permissions as unknown[]).filter(
        (p): p is Permission => typeof p === 'string' && isPermission(p),
      )
    : [];
}

async function loadGrant(req: Request): Promise<Grant | null> {
  if (req.grant !== undefined) return req.grant;

  const userId = req.session?.userId;
  if (!userId) {
    req.grant = null;
    return null;
  }

  const select = { role: { select: { id: true, name: true, permissions: true, isActive: true } } };

  const [campus, company, admin] = await Promise.all([
    prisma.campusMember.findUnique({ where: { userId }, select }),
    prisma.companyMember.findUnique({ where: { userId }, select }),
    prisma.adminMember.findUnique({ where: { userId }, select }),
  ]);

  const role = (admin ?? campus ?? company)?.role ?? null;

  if (!role || !role.isActive) {
    req.grant = null;
    return null;
  }

  req.grant = { roleId: role.id, roleName: role.name, permissions: readPermissions(role) };
  return req.grant;
}

export async function permissionsFor(req: Request): Promise<Permission[]> {
  return (await loadGrant(req))?.permissions ?? [];
}

export async function hasPermission(req: Request, permission: Permission): Promise<boolean> {
  return (await permissionsFor(req)).includes(permission);
}

/**
 * Middleware. Refuses with the capability named, because "Forbidden" tells
 * the person nothing about what to ask their administrator for.
 */
/** The middleware, with the capability readable from the outside. */
export interface CapabilityCheck {
  (req: Request, res: Response, next: NextFunction): Promise<void>;
  /** What this check demands. Lets a test walk the router and audit it. */
  permission: Permission;
}

export function can(permission: Permission): CapabilityCheck {
  const check = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const grant = await loadGrant(req);
      if (!grant) {
        next(req.session?.userId ? forbidden('Your account has no role.') : unauthorized());
        return;
      }

      if (!grant.permissions.includes(permission)) {
        next(
          forbidden(
            `Your role (${grant.roleName}) cannot do this. It needs the "${permission}" permission.`,
          ),
        );
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };

  /*
   * Stamped on the function so the router stack can be audited. Without it a
   * capability check is just another anonymous middleware, and a test cannot
   * tell an endpoint that is guarded from one somebody forgot.
   */
  return Object.assign(check, { permission });
}
