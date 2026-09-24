import { Router } from 'express';
import { z } from 'zod';
import { CompanyStatus, InviteKind, RoleScope } from '@prisma/client';
import { usableRole } from '../roles/usableRole.js';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { platformWrites } from '../roles/platformWrites.js';
import { createInvite, inviteLinkFor } from '../invites/invite.service.js';
import {
  COMPANY_PUBLIC_SELECT,
  companyProfileSchema,
  toCompanyData,
} from '../company/company.schemas.js';
import { canPublish } from '../company/verification.js';
import { can } from '../roles/can.js';

export const companiesRouter = Router();

companiesRouter.use(requireRole('ADMIN'));

// Companies are verified once and hire at every institution, so the record,
// the decision to let it publish, and who may act for it are the platform's.
companiesRouter.use(platformWrites);

/**
 * Operations entering a company it already trusts. Same fields a company fills
 * in for itself, but the result is verified on the spot - there is nobody to
 * review when the reviewer is the one typing.
 */
const createSchema = companyProfileSchema;

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  invitedName: z.string().trim().max(120).optional().or(z.literal('')),
  /** Defaults to the owner: the first account a company gets. */
  roleId: z.string().trim().optional(),
});


/** A retired industry stays on the companies that have it, but cannot be chosen anew. */
async function assertIndustryUsable(id: string | undefined): Promise<void> {
  if (!id) return;
  const industry = await prisma.industry.findUnique({ where: { id } });
  if (!industry) throw notFound('That industry does not exist.');
  if (!industry.isActive) throw conflict(`${industry.name} has been retired and cannot be chosen.`);
}

/** What the company is told, in the words they should read it in. */
function decisionNotice(
  name: string,
  status: CompanyStatus,
  reason: string | undefined,
): { type: string; title: string; body: string } {
  switch (status) {
    case CompanyStatus.VERIFIED:
      return {
        type: 'company.verified',
        title: `${name} is verified`,
        body: 'You can publish roles now. Each one still goes to the colleges you choose for their approval.',
      };
    case CompanyStatus.REJECTED:
      return {
        type: 'company.rejected',
        title: 'Your registration was not approved',
        body: reason?.trim() || 'No reason was recorded.',
      };
    case CompanyStatus.SUSPENDED:
      return {
        type: 'company.suspended',
        title: `${name} has been suspended`,
        body: reason?.trim() || 'Published roles are hidden and no new ones can be posted.',
      };
    case CompanyStatus.PENDING:
      return {
        type: 'company.pending',
        title: 'Your company is under review again',
        body: 'Publishing is paused until the review finishes.',
      };
  }
}

async function notifyAll(
  userIds: string[],
  notice: { type: string; title: string; body: string },
): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: notice.type,
      title: notice.title,
      body: notice.body,
      link: '/company',
    })),
  });
}

/**
 * GET /api/admin/companies?status=PENDING
 *
 * The queue and the directory are the same list read two ways, so a company
 * cannot be verified from one screen and still sit pending on another.
 * Companies that applied sort first: they are the ones waiting on a person.
 */
companiesRouter.get(
  '/',
  can('company:read'),
  asyncHandler(async (req, res) => {
    const status = z.nativeEnum(CompanyStatus).optional().parse(req.query.status || undefined);

    const [companies, counts] = await Promise.all([
      prisma.company.findMany({
        where: status ? { status } : {},
        orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          _count: { select: { members: true, jobs: true } },
          industry: { select: { name: true } },
        },
      }),
      prisma.company.groupBy({ by: ['status'], _count: true }),
    ]);

    res.json({
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        website: c.website,
        status: c.status,
        isVerified: canPublish(c.status),
        industry: c.industry?.name ?? null,
        city: c.city,
        appliedAt: c.appliedAt,
        createdAt: c.createdAt,
        memberCount: c._count.members,
        jobCount: c._count.jobs,
      })),
      // Drives the tab badges. Absent statuses read as zero.
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    });
  }),
);

/** POST /api/admin/companies */
companiesRouter.post(
  '/',
  can('company:write'),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);

    const clash = await prisma.company.findUnique({ where: { name: data.name } });
    if (clash) throw conflict('That company is already on the platform.');

    const company = await prisma.company.create({
      data: {
        ...toCompanyData(data),
        name: data.name,
        // Entered by the reviewer, so it is already reviewed. appliedAt stays
        // null: this company never applied, which is worth being able to tell
        // apart later.
        status: CompanyStatus.VERIFIED,
        reviewedAt: new Date(),
        reviewedById: req.session.userId!,
      },
      select: COMPANY_PUBLIC_SELECT,
    });

    res.status(201).json({ company });
  }),
);

/** GET /api/admin/companies/:id */
companiesRouter.get(
  '/:id',
  can('company:read'),
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        members: {
          include: {
            user: { select: { id: true, fullName: true, email: true, isActive: true } },
            role: { select: { key: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        invites: {
          where: { acceptedAt: null, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            invitedName: true,
            expiresAt: true,
            role: { select: { id: true, name: true } },
          },
        },
        _count: { select: { jobs: true } },
        industry: { select: { id: true, name: true } },
      },
    });

    if (!company) throw notFound('No such company.');
    res.json({
      company: {
        ...company,
        // Flattened: the role is a row now, and a screen only needs its name
        // (to show) and its key (to find the owner).
        members: company.members.map(({ role, ...m }) => ({ ...m, roleName: role.name, roleKey: role.key })),
        isVerified: canPublish(company.status),
      },
    });
  }),
);

/**
 * PATCH /api/admin/companies/:id
 * Editing the profile. Deciding whether a company may publish is a separate
 * endpoint on purpose - a verification should never be something that happens
 * as a side effect of fixing a typo in an address.
 */
companiesRouter.patch(
  '/:id',
  can('company:write'),
  asyncHandler(async (req, res) => {
    const data = companyProfileSchema.partial().parse(req.body);

    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) throw notFound('No such company.');

    if (data.name && data.name !== company.name) {
      const clash = await prisma.company.findUnique({ where: { name: data.name } });
      if (clash) throw conflict('Another company already has that name.');
    }
    if (data.industryId) await assertIndustryUsable(data.industryId);

    const updated = await prisma.company.update({
      where: { id: company.id },
      // One question, one answer: see the note on the company's own profile.
      data: {
        ...toCompanyData(data),
        ...(data.industryId ? { industryOther: null } : {}),
        ...(data.industryOther ? { industryId: null } : {}),
      },
      select: COMPANY_PUBLIC_SELECT,
    });

    res.json({ company: updated });
  }),
);

/**
 * POST /api/admin/companies/:id/decision
 *
 * The review itself. One endpoint for all four outcomes so that every change
 * of status records who decided and when, and so a rejection cannot be entered
 * without a reason - the company is going to be shown it.
 */
const decisionSchema = z
  .object({
    status: z.nativeEnum(CompanyStatus),
    reason: z.string().trim().max(1000).optional().or(z.literal('')),
  })
  .refine((d) => d.status !== CompanyStatus.REJECTED || Boolean(d.reason?.trim()), {
    path: ['reason'],
    message: 'Say why. The company is shown this.',
  });

companiesRouter.post(
  '/:id/decision',
  can('company:verify'),
  asyncHandler(async (req, res) => {
    const { status, reason } = decisionSchema.parse(req.body);

    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) throw notFound('No such company.');
    if (company.status === status) {
      throw conflict(`That company is already ${status.toLowerCase()}.`);
    }

    const updated = await prisma.company.update({
      where: { id: company.id },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedById: req.session.userId!,
        // A reason belongs to the rejection that carried it. Verifying a
        // company later must not leave the old refusal on its record.
        rejectionReason: status === CompanyStatus.REJECTED ? reason!.trim() : null,
      },
      select: COMPANY_PUBLIC_SELECT,
    });

    // Everyone at the company hears about it, not just whoever signed up.
    const members = await prisma.companyMember.findMany({
      where: { companyId: company.id },
      select: { userId: true },
    });
    await notifyAll(
      members.map((m) => m.userId),
      decisionNotice(company.name, status, reason),
    );

    res.json({ company: updated });
  }),
);

/** POST /api/admin/companies/:id/invites — invite the first recruiter */
companiesRouter.post(
  '/:id/invites',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const companyId = req.params.id!;
    const data = inviteSchema.parse(req.body);
    const role = await usableRole(data.roleId, RoleScope.COMPANY);

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw notFound('No such company.');

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

/** DELETE /api/admin/companies/:id/invites/:inviteId */
companiesRouter.delete(
  '/:id/invites/:inviteId',
  can('login:manage'),
  asyncHandler(async (req, res) => {
    const { id: companyId, inviteId } = req.params;

    const result = await prisma.invite.updateMany({
      where: { id: inviteId, companyId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) throw notFound('No pending invitation to cancel.');
    res.status(204).end();
  }),
);
