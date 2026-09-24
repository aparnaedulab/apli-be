import type { Request } from 'express';
import { TenantStatus, type Tenant } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden } from '../../lib/errors.js';
import { scopeOf, toPublicUser, type PublicUser } from '../auth/auth.service.js';
import { CORE_KEYS } from './catalogue.js';

type ScopedUser = Parameters<typeof scopeOf>[0];

/** What a screen needs to paint itself as a tenant's portal. */
export interface TenantSummary {
  id: string;
  name: string;
  shortName: string | null;
  slug: string;
  kind: Tenant['kind'];
  status: TenantStatus;
  brandColor: string;
  logoUrl: string | null;
  faviconUrl: string | null;
}

export interface SessionView {
  user: PublicUser;
  /** The institution the session is acting inside. Null for companies. */
  tenant: TenantSummary | null;
  /**
   * Module keys switched on for that tenant. A courtesy for menus, exactly
   * like permissions: the server checks again wherever it matters.
   */
  modules: string[];
}

const SUMMARY_SELECT = {
  id: true,
  name: true,
  shortName: true,
  slug: true,
  kind: true,
  status: true,
  brandColor: true,
  logoUrl: true,
  faviconUrl: true,
} as const;

/**
 * The tenant the platform team lands in after signing in.
 *
 * The most recently launched live one: on a single-institution install that is
 * the only one there is, so the existing admin screens work the moment they
 * sign in. With none live, they land in no tenant and the console asks them
 * to pick or create one.
 */
async function defaultActingTenant(): Promise<string | undefined> {
  const tenant = await prisma.tenant.findFirst({
    where: { status: TenantStatus.ACTIVE },
    orderBy: [{ launchedAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  return tenant?.id;
}

/**
 * Writes everything the server trusts about a caller onto their session.
 *
 * The one place a session is filled in, for every way of arriving - sign-in,
 * accepting an invitation, joining a batch, registering a company - so no path
 * can forget the tenant and leave a caller unfenced.
 *
 * A tenant that is suspended refuses its own people here, at the door, rather
 * than on every screen after.
 */
export async function openSession(req: Request, user: ScopedUser): Promise<void> {
  const scope = scopeOf(user);

  if (scope.tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { status: true },
    });
    if (tenant?.status === TenantStatus.SUSPENDED) {
      throw forbidden('This institution’s portal is suspended. Contact the platform team.');
    }
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  if (scope.collegeId) req.session.collegeId = scope.collegeId;
  if (scope.companyId) req.session.companyId = scope.companyId;
  if (scope.candidateId) req.session.candidateId = scope.candidateId;

  if (scope.isPlatform) {
    req.session.isPlatform = true;
    const acting = await defaultActingTenant();
    if (acting) req.session.tenantId = acting;
  } else if (scope.tenantId) {
    req.session.tenantId = scope.tenantId;
  }
}

/** Reads a tenant's switched-on modules, core included whatever the rows say. */
export async function enabledModules(tenantId: string): Promise<string[]> {
  const rows = await prisma.tenantModule.findMany({
    where: { tenantId, enabled: true },
    select: { moduleKey: true },
  });
  return [...new Set([...CORE_KEYS, ...rows.map((r) => r.moduleKey)])];
}

/**
 * What the browser is told about its session.
 *
 * The tenant comes from the session rather than the account, because for the
 * platform team they differ: the account belongs to no tenant, and the
 * session is standing in one.
 */
export async function describeSession(req: Request, user: ScopedUser): Promise<SessionView> {
  const base = toPublicUser(user);
  const tenantId = req.session.tenantId;

  const tenant = tenantId
    ? await prisma.tenant.findUnique({ where: { id: tenantId }, select: SUMMARY_SELECT })
    : null;

  return {
    user: { ...base, tenantId: tenant?.id, isPlatform: req.session.isPlatform === true },
    tenant,
    modules: tenant ? await enabledModules(tenant.id) : [],
  };
}
