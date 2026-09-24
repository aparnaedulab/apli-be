import { Router, type Request } from 'express';
import { TenantKind } from '@prisma/client';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { asWorkbook, workbookUpload } from '../../lib/upload.js';
import { can } from '../roles/can.js';
import { requirePlatform } from './tenant.context.js';
import { addBranchesInBulk, addCoursesInBulk, loadTenant, onboardingState } from './onboarding.service.js';
import { createCollege } from './onboarding.structure.js';
import {
  branchNamesToAdd,
  buildTemplate,
  courseRowsFrom,
  previewBranches,
  previewColleges,
  readSheet,
  type BulkKind,
} from './bulk.workbook.js';

/**
 * Excel templates and uploads for onboarding: branches, courses, colleges.
 *
 * Bulk add is always from Excel. Every upload is read twice: once with
 * `?preview=true` (the default), which writes nothing and says what each row
 * would do, and once with `?preview=false`, which does exactly that.
 */
export const platformBulkRouter = Router();
platformBulkRouter.use(requireRole('ADMIN'), requirePlatform);

const flag = (v: unknown, fallback: boolean) =>
  v === undefined ? fallback : !['false', '0', 'no'].includes(String(v).toLowerCase());

function uploaded(req: Request): Buffer {
  if (!req.file) throw badRequest('Choose the filled-in .xlsx template to upload.');
  if (!/\.xlsx$/i.test(req.file.originalname) && !req.file.mimetype.includes('spreadsheetml')) {
    throw badRequest('Upload the .xlsx template. Save the file as an Excel workbook (.xlsx) first.');
  }
  return req.file.buffer;
}

const FILE: Record<BulkKind, string> = {
  branches: 'apli-branches-template.xlsx',
  courses: 'apli-courses-template.xlsx',
  colleges: 'apli-colleges-template.xlsx',
};

for (const kind of ['branches', 'courses', 'colleges'] as const) {
  /** GET /api/platform/bulk/<kind>/template - with today's dropdown lists. */
  platformBulkRouter.get(
    `/${kind}/template`,
    can('college:write'),
    asyncHandler(async (_req, res) => {
      res.set(asWorkbook(FILE[kind])).send(Buffer.from(await buildTemplate(kind)));
    }),
  );
}

/** POST /api/platform/bulk/branches/upload - the filled template; look-alikes are held back. */
platformBulkRouter.post(
  '/branches/upload',
  can('college:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const preview = await previewBranches(await readSheet('branches', uploaded(req)));
    if (flag(req.query.preview, true)) {
      res.json({ preview: true, ...preview });
      return;
    }
    const names = branchNamesToAdd(preview);
    const result = names.length > 0 ? await addBranchesInBulk(names) : { results: [], added: 0, held: 0 };
    const branches = await prisma.branch.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.json({ preview: false, ...preview, added: result.results, branches });
  }),
);

/**
 * POST /api/platform/bulk/courses/upload - one row per course and branch.
 * `addMissing=true` adds branch names that match nothing; otherwise they are
 * skipped, and the preview says so on their row.
 */
platformBulkRouter.post(
  '/courses/upload',
  can('college:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const { lines, invalid, grouped } = courseRowsFrom(await readSheet('courses', uploaded(req)));
    const preview = flag(req.query.preview, true);
    const addMissingBranches = flag(req.query.addMissing, false);

    const result =
      grouped.length > 0
        ? await addCoursesInBulk({ rows: grouped, addMissingBranches, preview })
        : { preview, plan: [], summary: { courses: 0, newCourses: 0, newBranches: 0, mapped: 0, missing: 0 } };

    // The plan is per course; the screen shows it per spreadsheet row.
    const rows = [
      ...lines.map((l) => {
        const p = result.plan.find((x) => x.course.toLowerCase() === l.course.toLowerCase());
        const b = l.branch ? p?.branches.find((x) => x.input.toLowerCase() === l.branch.toLowerCase()) : undefined;
        return {
          row: l.row,
          course: p?.course ?? l.course,
          newCourse: !p?.courseId,
          branch: l.branch,
          status: l.branch ? (b?.status ?? 'matched') : ('none' as const),
          ...(b && 'branch' in b ? { readAs: b.branch.name } : {}),
        };
      }),
      ...invalid.map((i) => ({ row: i.row, course: '', newCourse: false, branch: '', status: 'invalid' as const, reason: i.reason })),
    ].sort((a, b) => a.row - b.row);

    res.json({ ...result, rows, skipped: invalid.length });
  }),
);

/**
 * POST /api/platform/bulk/tenants/:id/colleges - the filled colleges template.
 * Each valid row is added exactly as the form would add it; a row with a
 * problem is skipped and reported with its row number.
 */
platformBulkRouter.post(
  '/tenants/:id/colleges',
  can('college:write'),
  workbookUpload.single('file'),
  asyncHandler(async (req, res) => {
    const tenantId = req.params.id!;
    const tenant = await loadTenant(tenantId);
    const preview = await previewColleges(await readSheet('colleges', uploaded(req)));

    // A single-college institution has room for one college in total.
    if (tenant.kind === TenantKind.COLLEGE) {
      let room = (await prisma.college.count({ where: { tenantId } })) > 0 ? 0 : 1;
      preview.rows = preview.rows.map((r) => {
        if (r.status !== 'valid') return r;
        if (room > 0) {
          room -= 1;
          return r;
        }
        return {
          row: r.row,
          name: r.name,
          code: r.code,
          status: 'invalid' as const,
          problems: ['A single-college institution has exactly one college.'],
        };
      });
      preview.summary.valid = preview.rows.filter((r) => r.status === 'valid').length;
      preview.summary.invalid = preview.rows.length - preview.summary.valid;
    }

    // The preview never carries the parsed input back to the browser.
    const shown = preview.rows.map((r) => {
      if (r.status !== 'valid') return r;
      return {
        row: r.row,
        name: r.name,
        code: r.code,
        status: r.status,
        city: r.input.city,
        state: r.input.state,
        officerEmail: r.input.officerEmail || null,
      };
    });

    if (flag(req.query.preview, true)) {
      res.json({ preview: true, rows: shown, summary: preview.summary });
      return;
    }

    const added: { row: number; id: string; name: string; officer: unknown }[] = [];
    const failed: { row: number; name: string; code: string; problems: string[] }[] = [];
    for (const r of preview.rows) {
      if (r.status !== 'valid') continue;
      try {
        const out = await createCollege(tenantId, r.input, req.session.userId!);
        added.push({ row: r.row, id: out.college.id, name: out.college.name, officer: out.officer });
      } catch (err) {
        // Something changed since the preview - a code taken meanwhile.
        if (!(err instanceof AppError)) throw err;
        failed.push({ row: r.row, name: r.name, code: r.code, problems: [err.message] });
      }
    }
    const skipped = preview.rows
      .filter((r) => r.status === 'invalid')
      .map((r) => ({ row: r.row, name: r.name, code: r.code, problems: r.status === 'invalid' ? r.problems : [] }));

    res.json({
      preview: false,
      rows: shown,
      summary: preview.summary,
      added,
      skipped: [...skipped, ...failed].sort((a, b) => a.row - b.row),
      state: await onboardingState(tenantId),
    });
  }),
);
