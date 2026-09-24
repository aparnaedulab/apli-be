import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCollegeId, requireRole } from '../../middleware/auth.js';
import { asWorkbook } from '../../lib/upload.js';
import { can } from '../roles/can.js';
import { requireModule, requireTenantId } from '../tenants/tenant.context.js';
import { placementReport, type ReportFilter, type Scope } from './reports.service.js';
import { buildReportWorkbook } from './reports.workbook.js';

/**
 * Placement statistics and NAAC / NIRF / NBA exports (compliance.reports).
 *
 * Two scopes, one report: a placement cell sees its own college, an
 * institution admin sees every college of the institution with a row each.
 * Reading needs `report:read`; downloading the workbook needs
 * `report:export`, because data leaving the platform is its own decision.
 */
export const reportsRouter = Router();

const MODULE = 'compliance.reports';

const filterSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  placementId: z.string().trim().min(1).optional(),
});

function filterOf(req: Request): ReportFilter {
  return filterSchema.parse(req.query);
}

const collegeScope = (req: Request): Scope => ({ kind: 'college', collegeId: requireCollegeId(req) });
const tenantScope = (req: Request): Scope => ({ kind: 'tenant', tenantId: requireTenantId(req) });

/** A filename a person can recognise in their downloads folder. */
function fileName(prefix: string, filter: ReportFilter, year: number | null): string {
  const tag = filter.placementId ? 'drive' : String(year ?? 'latest');
  return `${prefix}-placement-report-${tag}.xlsx`;
}

/* --- a placement cell: its own college ---------------------------------- */

/** GET /api/reports/college?year=&placementId= */
reportsRouter.get(
  '/college',
  requireRole('CAMPUS'),
  can('report:read'),
  requireModule(MODULE),
  asyncHandler(async (req, res) => {
    res.json(await placementReport(collegeScope(req), filterOf(req)));
  }),
);

/** GET /api/reports/college.xlsx?year=&placementId= */
reportsRouter.get(
  '/college.xlsx',
  requireRole('CAMPUS'),
  can('report:export'),
  requireModule(MODULE),
  asyncHandler(async (req, res) => {
    const filter = filterOf(req);
    const report = await placementReport(collegeScope(req), filter);
    const buffer = await buildReportWorkbook(report);
    res.set(asWorkbook(fileName('college', filter, report.filter.year))).send(Buffer.from(buffer));
  }),
);

/* --- an institution admin: every college ---------------------------------- */

/** GET /api/reports/tenant?year=&placementId= */
reportsRouter.get(
  '/tenant',
  requireRole('ADMIN'),
  can('report:read'),
  requireModule(MODULE),
  asyncHandler(async (req, res) => {
    res.json(await placementReport(tenantScope(req), filterOf(req)));
  }),
);

/** GET /api/reports/tenant.xlsx?year=&placementId= */
reportsRouter.get(
  '/tenant.xlsx',
  requireRole('ADMIN'),
  can('report:export'),
  requireModule(MODULE),
  asyncHandler(async (req, res) => {
    const filter = filterOf(req);
    const report = await placementReport(tenantScope(req), filter);
    const buffer = await buildReportWorkbook(report);
    res.set(asWorkbook(fileName('institution', filter, report.filter.year))).send(Buffer.from(buffer));
  }),
);
