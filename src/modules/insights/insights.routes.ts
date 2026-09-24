import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { can } from '../roles/can.js';
import { requireModule, requireTenantId } from '../tenants/tenant.context.js';
import { skillHeatmap } from './heatmap.service.js';
import { currentProvider } from '../whatsapp/provider.js';
import { ALLOWED_TYPES } from '../whatsapp/templates.js';

/**
 * The skill-demand heatmap and the WhatsApp message log.
 *
 * Both are read-only views for the people who run placements: a placement
 * cell sees its own college, an institution admin the whole institution. Only
 * totals, percentages and masked numbers ever leave this router.
 */
export const insightsRouter = Router();

const yearSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

/* --- skill demand --------------------------------------------------------- */

/** GET /api/insights/skills/college?year= */
insightsRouter.get(
  '/skills/college',
  requireRole('CAMPUS'),
  can('report:read'),
  requireModule('ops.skillHeatmap'),
  asyncHandler(async (req, res) => {
    const { year } = yearSchema.parse(req.query);
    res.json(await skillHeatmap({ kind: 'college', collegeId: requireCollegeId(req) }, year));
  }),
);

/** GET /api/insights/skills/tenant?year= */
insightsRouter.get(
  '/skills/tenant',
  requireRole('ADMIN'),
  can('report:read'),
  requireModule('ops.skillHeatmap'),
  asyncHandler(async (req, res) => {
    const { year } = yearSchema.parse(req.query);
    res.json(await skillHeatmap({ kind: 'tenant', tenantId: requireTenantId(req) }, year));
  }),
);

/* --- WhatsApp delivery log ------------------------------------------------ */

const LOG_LIMIT = 200;

/**
 * GET /api/insights/whatsapp/college
 *
 * What WhatsApp did for this college's students: counts by outcome and the
 * most recent messages. The number is only ever the masked one stored in the
 * log, and whether the portal can send at all is said up front - a log full
 * of "not set up" is a setup question, not a student problem.
 */
insightsRouter.get(
  '/whatsapp/college',
  requireRole('CAMPUS'),
  can('report:read'),
  requireModule('channel.whatsapp'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);

    const students = await prisma.candidate.findMany({
      where: {
        OR: [{ collegeId }, { batchMemberships: { some: { batch: { collegeId } } } }],
      },
      select: { id: true, user: { select: { fullName: true } } },
    });
    const names = new Map(students.map((s) => [s.id, s.user.fullName]));
    const ids = [...names.keys()];

    const [messages, grouped] = await Promise.all([
      prisma.whatsAppMessage.findMany({
        where: { candidateId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        take: LOG_LIMIT,
        select: { id: true, candidateId: true, template: true, toMasked: true, status: true, error: true, createdAt: true },
      }),
      prisma.whatsAppMessage.groupBy({
        by: ['status'],
        where: { candidateId: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = { SENT: 0, FAILED: 0, SKIPPED: 0, QUEUED: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;

    res.json({
      configured: currentProvider().configured,
      types: ALLOWED_TYPES,
      counts,
      messages: messages.map(({ candidateId, ...m }) => ({ ...m, student: names.get(candidateId) ?? 'Student' })),
    });
  }),
);
