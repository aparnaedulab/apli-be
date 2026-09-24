import { CompanyStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { readPermissions } from '../roles/can.js';

/**
 * Per-institution company approval.
 *
 * The platform verifies that a company is real; that is the same answer for
 * every institution. Some institutions also want to say "not at our colleges"
 * or "only after we have looked" - that is this module. It is opt-in: a tenant
 * with companyApprovalRequired off never consults these rows, and every
 * college's approval of each posting stays the gate as before.
 */

export const ACCESS_STATUSES = ['PENDING', 'APPROVED', 'BLOCKED'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/**
 * Whether a company may reach a tenant's colleges.
 *
 * Setting off: yes. Setting on: only with an APPROVED row. A BLOCKED row is
 * never a yes - but a block only means something while the setting is on,
 * so switching it off is the institution's way of opening the doors again.
 */
export async function companyMayReach(companyId: string, tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return true;
  const unreachable = await unreachableTenants(companyId, [tenantId]);
  return unreachable.length === 0;
}

/**
 * Of these tenants, the ones this company may not reach yet, with names so a
 * refusal can say where to ask. One query per table, whatever the count.
 */
export async function unreachableTenants(
  companyId: string,
  tenantIds: (string | null | undefined)[],
): Promise<{ id: string; name: string }[]> {
  const ids = [...new Set(tenantIds.filter((t): t is string => Boolean(t)))];
  if (ids.length === 0) return [];

  const gated = await prisma.tenant.findMany({
    where: { id: { in: ids }, companyApprovalRequired: true },
    select: { id: true, name: true, shortName: true },
  });
  if (gated.length === 0) return [];

  const approved = await prisma.tenantCompany.findMany({
    where: { companyId, tenantId: { in: gated.map((t) => t.id) }, status: 'APPROVED' },
    select: { tenantId: true },
  });
  const ok = new Set(approved.map((a) => a.tenantId));
  return gated.filter((t) => !ok.has(t.id)).map((t) => ({ id: t.id, name: t.shortName || t.name }));
}

/** The set form, for filtering lists of drives or students in memory. */
export async function unreachableTenantIds(companyId: string, tenantIds: (string | null | undefined)[]) {
  return new Set((await unreachableTenants(companyId, tenantIds)).map((t) => t.id));
}

/**
 * For the targeting page: which of these drives' institutions the company
 * cannot reach, keyed by tenant. Drives come in as whatever the caller already
 * loaded - they only need `college.tenantId`.
 */
export async function annotateForCompany<T extends { college: { tenantId: string | null } }>(
  companyId: string,
  drives: T[],
): Promise<(T & { needsApproval: boolean })[]> {
  const blocked = await unreachableTenantIds(
    companyId,
    drives.map((d) => d.college.tenantId),
  );
  return drives.map((d) => ({ ...d, needsApproval: d.college.tenantId ? blocked.has(d.college.tenantId) : false }));
}

/** The sentence every refusal uses, so the company always hears the same thing. */
export function needsApprovalMessage(names: string[]): string {
  const list = names.join(', ');
  return names.length === 1
    ? `${list} approves companies before they reach its colleges. Request access from Institutions first.`
    : `${list} approve companies before they reach their colleges. Request access from Institutions first.`;
}

/* -------------------------------------------------------------------------- */
/* The company's side                                                          */
/* -------------------------------------------------------------------------- */

/** Every live institution that asks for approval, and where this company stands with each. */
export async function institutionsForCompany(companyId: string) {
  const [tenants, rows] = await Promise.all([
    prisma.tenant.findMany({
      where: { companyApprovalRequired: true, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, shortName: true, city: true, state: true, _count: { select: { colleges: true } } },
    }),
    prisma.tenantCompany.findMany({ where: { companyId } }),
  ]);
  const byTenant = new Map(rows.map((r) => [r.tenantId, r]));
  return tenants.map((t) => {
    const row = byTenant.get(t.id);
    return {
      tenantId: t.id,
      name: t.name,
      shortName: t.shortName,
      city: t.city,
      state: t.state,
      colleges: t._count.colleges,
      status: (row?.status ?? 'NONE') as AccessStatus | 'NONE',
      note: row?.note ?? null,
      requestedAt: row?.requestedAt ?? null,
      decidedAt: row?.decidedAt ?? null,
    };
  });
}

/**
 * A company asking to be let in. Asking again while pending just refreshes the
 * note; a block is final until the institution lifts it - asking again would
 * only be a way to nag.
 */
export async function requestAccess(companyId: string, tenantId: string, note: string | undefined, userName: string) {
  const [company, tenant] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, status: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true, companyApprovalRequired: true } }),
  ]);
  if (!company) throw notFound('No such company.');
  if (company.status !== CompanyStatus.VERIFIED) {
    throw forbidden('Your company must be verified by the platform before it can ask an institution.');
  }
  if (!tenant || tenant.status !== 'ACTIVE') throw notFound('No such institution.');
  if (!tenant.companyApprovalRequired) {
    throw badRequest(`${tenant.name} does not ask for approval - you can send roles to its colleges already.`);
  }

  const existing = await prisma.tenantCompany.findUnique({ where: { tenantId_companyId: { tenantId, companyId } } });
  if (existing?.status === 'APPROVED') return { status: 'APPROVED' as const, notified: 0 };
  if (existing?.status === 'BLOCKED') {
    throw forbidden(`${tenant.name} has declined access for now. They can change that from their side.`);
  }

  await prisma.tenantCompany.upsert({
    where: { tenantId_companyId: { tenantId, companyId } },
    create: { tenantId, companyId, note: note ?? null },
    update: { note: note ?? existing?.note ?? null, requestedAt: new Date() },
  });

  // The institution's own admins with company:verify hear about it - never the
  // platform team, who did their part when they verified the company.
  const admins = await prisma.adminMember.findMany({
    where: { tenantId, user: { isActive: true } },
    select: { userId: true, role: { select: { permissions: true, isActive: true } } },
  });
  const recipients = admins.filter((a) => readPermissions(a.role).includes('company:verify')).map((a) => a.userId);
  if (recipients.length > 0) {
    await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: 'COMPANY_ACCESS_REQUESTED',
        title: `${company.name} asks to reach your colleges`,
        body: note ? `${userName}: "${note}"` : `${userName} asked on behalf of ${company.name}.`,
        link: '/admin/company-access',
        payload: { companyId, tenantId },
      })),
    });
  }
  return { status: 'PENDING' as const, notified: recipients.length };
}

/* -------------------------------------------------------------------------- */
/* The institution's side                                                      */
/* -------------------------------------------------------------------------- */

/** Requests for this tenant, waiting ones first, with what an admin needs to judge. */
export async function requestsForTenant(tenantId: string) {
  const [tenant, rows] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { companyApprovalRequired: true } }),
    prisma.tenantCompany.findMany({ where: { tenantId }, orderBy: { requestedAt: 'desc' } }),
  ]);
  if (!tenant) throw notFound('No such institution.');

  const companies = await prisma.company.findMany({
    where: { id: { in: rows.map((r) => r.companyId) } },
    select: {
      id: true,
      name: true,
      website: true,
      city: true,
      state: true,
      status: true,
      industry: { select: { name: true } },
    },
  });
  const byId = new Map(companies.map((c) => [c.id, c]));
  const order: Record<string, number> = { PENDING: 0, APPROVED: 1, BLOCKED: 2 };

  const requests = rows
    .filter((r) => byId.has(r.companyId))
    .map((r) => {
      const c = byId.get(r.companyId)!;
      return {
        companyId: c.id,
        name: c.name,
        industry: c.industry?.name ?? null,
        website: c.website,
        city: c.city,
        state: c.state,
        platformStatus: c.status,
        status: r.status as AccessStatus,
        note: r.note,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt,
      };
    })
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  return { approvalRequired: tenant.companyApprovalRequired, requests };
}

/**
 * An institution's answer. PENDING undoes an approval without blocking, so a
 * company that must re-explain itself is not shut out for good. A decision on
 * a company that never asked is allowed - blocking one ahead of time is a
 * legitimate thing for an institution to want.
 */
export async function decide(
  tenantId: string,
  companyId: string,
  status: AccessStatus,
  note: string | undefined,
  decidedById: string,
) {
  const [tenant, company] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, shortName: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } }),
  ]);
  if (!tenant) throw notFound('No such institution.');
  if (!company) throw notFound('No such company.');

  const now = new Date();
  const row = await prisma.tenantCompany.upsert({
    where: { tenantId_companyId: { tenantId, companyId } },
    create: { tenantId, companyId, status, note: note ?? null, decidedAt: now, decidedById },
    update: { status, decidedAt: now, decidedById, ...(note !== undefined ? { note } : {}) },
  });

  const members = await prisma.companyMember.findMany({
    where: { companyId, user: { isActive: true } },
    select: { userId: true },
  });
  const name = tenant.shortName || tenant.name;
  const words: Record<AccessStatus, { title: string; body: string }> = {
    APPROVED: { title: `${name} approved your company`, body: `You can now send roles to ${name}'s colleges.` },
    BLOCKED: { title: `${name} declined access`, body: note ? `Their note: "${note}"` : `Roles cannot go to ${name}'s colleges for now.` },
    PENDING: { title: `${name} is reviewing your access again`, body: 'New roles cannot go to its colleges until they decide.' },
  };
  if (members.length > 0) {
    await prisma.notification.createMany({
      data: members.map((m) => ({
        userId: m.userId,
        type: 'COMPANY_ACCESS_DECIDED',
        title: words[status].title,
        body: words[status].body,
        link: '/company/institutions',
        payload: { tenantId, status },
      })),
    });
  }
  return { companyId, status: row.status as AccessStatus, decidedAt: row.decidedAt };
}
