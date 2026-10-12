import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { badRequest } from '../../lib/errors.js';
import { imageUpload } from '../../lib/upload.js';
import { saveTenantAsset } from '../tenants/assets.js';
import { handInKindsSchema, pagesSchema } from './pages.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import { requirePlatform } from '../tenants/tenant.context.js';
import {
  checkSimulation,
  companyReview,
  companyReviewQueue,
  createSimulation,
  deleteSimulation,
  getSimulation,
  listSimulations,
  overview,
  retireSimulation,
  sharedWithCompany,
  simulationsToCheck,
  submitSimulation,
  updateSimulation,
  withdrawSimulation,
} from './companyApp.service.js';

/**
 * The company app's API: /api/company-app/...
 *
 * Built for the rebuilt company screens. Every route is the signed-in
 * company's own; a company sees and changes only its own simulations and
 * the work handed in on them.
 */
export const companyAppRouter = Router();

companyAppRouter.use(requireRole('COMPANY'));

const id = z.string().trim().min(1).max(40);

const simulationSchema = z.object({
  title: z.string().trim().min(5, 'Give it a title of a few words.').max(120),
  summary: z
    .string()
    .trim()
    .min(40, 'Say in two or three sentences what the student will do.')
    .max(1500, 'Keep it under 1,500 characters.'),
  about: z.string().trim().max(4000, 'Keep it under 4,000 characters.').optional().nullable(),
  // A picture uploaded here, or any https image.
  coverUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^(https:\/\/|\/)\S+$/i.test(v), 'Upload a cover picture.')
    .optional()
    .nullable(),
  videoUrl: z
    .string()
    .trim()
    .max(500)
    .refine(
      (v) => v === '' || /^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|vimeo\.com\/)\S+$/i.test(v),
      'Paste a YouTube or Vimeo link.',
    )
    .optional()
    .nullable(),
  field: z.string().trim().min(1, 'Pick the field it belongs to.').max(80),
  level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
  hours: z.coerce.number().int().min(1, 'At least an hour.').max(20, 'At most 20 hours - keep it short.'),
  skills: z
    .array(z.string().trim().min(1).max(40))
    .max(6, 'Up to six skills.')
    .transform((l) => [...new Set(l)]),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(3, 'Give the task a title.').max(120),
        brief: z.string().trim().min(20, 'Say what the student has to do.').max(4000),
        handIn: z.string().trim().max(300).optional().nullable(),
        learn: z
          .array(z.string().trim().min(1).max(160))
          .max(6, 'Up to six points.')
          .optional()
          .default([]),
        steps: z
          .array(z.string().trim().min(1).max(200))
          .max(8, 'Up to eight steps.')
          .optional()
          .default([]),
        pages: pagesSchema,
        handInKinds: handInKindsSchema,
        minutes: z.coerce.number().int().min(10, 'At least 10 minutes.').max(480, 'At most 8 hours a task.'),
      }),
    )
    .max(8, 'Up to eight tasks.'),
});

/** GET /api/company-app/overview */
companyAppRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json(await overview(requireCompanyId(req)));
  }),
);

/** GET /api/company-app/simulations */
companyAppRouter.get(
  '/simulations',
  asyncHandler(async (req, res) => {
    res.json({ simulations: await listSimulations(requireCompanyId(req)) });
  }),
);

/** POST /api/company-app/simulations */
companyAppRouter.post(
  '/simulations',
  asyncHandler(async (req, res) => {
    const body = simulationSchema.parse(req.body);
    res.status(201).json(await createSimulation(requireCompanyId(req), req.session.userId!, body));
  }),
);

/** POST /api/company-app/uploads/cover - a simulation's cover picture; returns its address. */
companyAppRouter.post(
  '/uploads/cover',
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    requireCompanyId(req);
    if (!req.file) throw badRequest('Choose a picture to upload.');
    res.status(201).json({ url: await saveTenantAsset('cover', req.file.buffer) });
  }),
);

/** GET /api/company-app/simulations/:id */
companyAppRouter.get(
  '/simulations/:id',
  asyncHandler(async (req, res) => {
    res.json(await getSimulation(requireCompanyId(req), id.parse(req.params.id)));
  }),
);

/** PUT /api/company-app/simulations/:id */
companyAppRouter.put(
  '/simulations/:id',
  asyncHandler(async (req, res) => {
    const body = simulationSchema.parse(req.body);
    res.json(await updateSimulation(requireCompanyId(req), id.parse(req.params.id), body));
  }),
);

/** DELETE /api/company-app/simulations/:id - a draft only. */
companyAppRouter.delete(
  '/simulations/:id',
  asyncHandler(async (req, res) => {
    await deleteSimulation(requireCompanyId(req), id.parse(req.params.id));
    res.json({ ok: true });
  }),
);

/** POST /api/company-app/simulations/:id/submit | withdraw | retire */
for (const [action, fn] of [
  ['submit', submitSimulation],
  ['withdraw', withdrawSimulation],
  ['retire', retireSimulation],
] as const) {
  companyAppRouter.post(
    `/simulations/:id/${action}`,
    asyncHandler(async (req, res) => {
      res.json(await fn(requireCompanyId(req), id.parse(req.params.id)));
    }),
  );
}

const decisionSchema = z.object({
  decision: z.enum(['approve', 'changes']),
  note: z.string().trim().max(2000).optional(),
});

/** GET /api/company-app/reviews - work handed in on this company's simulations. */
companyAppRouter.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    res.json({ reviews: await companyReviewQueue(requireCompanyId(req)) });
  }),
);

/** POST /api/company-app/reviews/:runId  { decision, note? } */
companyAppRouter.post(
  '/reviews/:runId',
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await companyReview(companyId, req.session.userId!, id.parse(req.params.runId), decisionSchema.parse(req.body));
    res.json({ reviews: await companyReviewQueue(companyId) });
  }),
);

/** GET /api/company-app/shared - verified work students chose to show this company. */
companyAppRouter.get(
  '/shared',
  asyncHandler(async (req, res) => {
    res.json({ shared: await sharedWithCompany(requireCompanyId(req)) });
  }),
);

/**
 * Apli.ai's check of a company's simulation before students see it:
 * /api/platform/simulations.
 */
export const simulationCheckRouter = Router();

simulationCheckRouter.use(requireRole('ADMIN'), requirePlatform);

/** GET /api/platform/simulations */
simulationCheckRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ simulations: await simulationsToCheck() });
  }),
);

/** POST /api/platform/simulations/:id  { decision, note? } */
simulationCheckRouter.post(
  '/:id',
  asyncHandler(async (req, res) => {
    await checkSimulation(id.parse(req.params.id), decisionSchema.parse(req.body));
    res.json({ simulations: await simulationsToCheck() });
  }),
);
