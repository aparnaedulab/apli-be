import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Which institution a request is acting inside, and the one way to ask.
 *
 * Two kinds of operations account exist now:
 *
 *   A tenant admin runs one institution. Their tenant is fixed at sign-in and
 *   can never change for the life of the session.
 *
 *   The platform team onboards institutions. They belong to no tenant, and
 *   step into one at a time - the tenant they are "in" is held on the session
 *   and switched explicitly, so every screen they already know keeps working
 *   and simply shows that institution's rows.
 *
 * Either way `req.session.tenantId` is the answer to "whose data is this", and
 * every query over tenant-owned rows narrows by it. Guessing another tenant's
 * id gets an empty result, the same promise layer three already makes for
 * colleges and companies.
 */

declare module 'express-session' {
  interface SessionData {
    /**
     * The institution this session is acting inside. Fixed for tenant admins,
     * campus staff and students; switchable for the platform team.
     */
    tenantId?: string;
    /** True for the platform team - operations accounts with no tenant. */
    isPlatform?: boolean;
  }
}

/** The tenant this request acts inside, or a refusal that says why not. */
export function requireTenantId(req: Request): string {
  const id = req.session.tenantId;
  if (id) return id;
  if (req.session.isPlatform) {
    throw forbidden('Choose an institution to work in first.');
  }
  throw forbidden('This account is not linked to an institution.');
}

/** Whether the caller is on the platform team. */
export function isPlatform(req: Request): boolean {
  return req.session.isPlatform === true;
}

/**
 * Router guard for the platform console. Mounted after requireRole('ADMIN'):
 * a tenant admin is an ADMIN too, and must not get in here.
 */
export function requirePlatform(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    next(unauthorized());
    return;
  }
  if (!isPlatform(req)) {
    next(forbidden('This area is for the platform team.'));
    return;
  }
  next();
}

/**
 * Where-clauses that fence a query into the current tenant.
 *
 * Kept as small builders rather than a generic helper, because each model
 * reaches its tenant along a different path and naming the path is the point:
 * a reviewer should be able to read `inTenant.candidate(t)` and know exactly
 * which join keeps the rows apart.
 */
export const inTenant = {
  college: (tenantId: string): Prisma.CollegeWhereInput => ({ tenantId }),
  batch: (tenantId: string): Prisma.BatchWhereInput => ({ tenantId }),
  candidate: (tenantId: string): Prisma.CandidateWhereInput => ({
    OR: [
      { college: { tenantId } },
      // A student on a university-wide batch may have no college of their own.
      { collegeId: null, batchMemberships: { some: { batch: { tenantId } } } },
    ],
  }),
  placement: (tenantId: string): Prisma.PlacementWhereInput => ({ college: { tenantId } }),
  application: (tenantId: string): Prisma.ApplicationWhereInput => ({
    placement: { college: { tenantId } },
  }),
  /** A role is seen by a tenant once it has been posted to one of its drives. */
  job: (tenantId: string): Prisma.JobWhereInput => ({
    postings: { some: { placement: { college: { tenantId } } } },
  }),
  user: (tenantId: string): Prisma.UserWhereInput => ({
    OR: [
      { adminMember: { tenantId } },
      { campusMember: { college: { tenantId } } },
      { candidate: { college: { tenantId } } },
      {
        candidate: {
          collegeId: null,
          batchMemberships: { some: { batch: { tenantId } } },
        },
      },
    ],
  }),
  invite: (tenantId: string): Prisma.InviteWhereInput => ({
    OR: [
      { tenantId },
      { college: { tenantId } },
      { batch: { tenantId } },
    ],
  }),
};

/**
 * Router guard for a module a tenant may or may not have bought.
 *
 *   router.use(requireModule('compliance.reports'));
 *
 * Mounted on every router a non-core module adds, so a tenant that switched a
 * module off gets a clear refusal rather than a half-working screen. Core
 * modules need no guard: every tenant has them. Companies act across tenants
 * and are not fenced by it; a company-facing module checks the tenant of the
 * college it is acting on instead.
 */
export function requireModule(moduleKey: string) {
  return async function moduleGuard(req: Request, _res: Response, next: NextFunction) {
    try {
      const tenantId = req.session.tenantId;
      if (!tenantId) {
        next(forbidden('This feature belongs to an institution, and none is selected.'));
        return;
      }
      const row = await prisma.tenantModule.findUnique({
        where: { tenantId_moduleKey: { tenantId, moduleKey } },
        select: { enabled: true },
      });
      if (!row?.enabled) {
        next(forbidden('Your institution does not have this feature switched on.'));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Whether a tenant has a module on - for a handler that behaves differently
 * rather than refusing outright (the apply button that asks for consent only
 * where the consent centre is switched on).
 */
export async function tenantHasModule(tenantId: string | undefined, moduleKey: string): Promise<boolean> {
  if (!tenantId) return false;
  const row = await prisma.tenantModule.findUnique({
    where: { tenantId_moduleKey: { tenantId, moduleKey } },
    select: { enabled: true },
  });
  return row?.enabled === true;
}
