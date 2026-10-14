import { Router } from 'express';
import { z } from 'zod';
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireRole } from '../../middleware/auth.js';
import { badRequest } from '../../lib/errors.js';
import { documentUpload } from '../../lib/upload.js';
import { ASSET_ROUTE, saveTenantAsset, sniffDocument, sniffImage } from '../tenants/assets.js';
import { requirePlatform } from '../tenants/tenant.context.js';
import { activeInterests } from '../students/lists.js';
import { answersSchema } from '../companyApp/pages.js';
import { myOffers, respondSchema, respondToOffer } from '../companyApp/offers.js';
import {
  answerCheck,
  dashboard,
  dismiss,
  explainWork,
  listSimulations,
  profile,
  revealCheck,
  review,
  reviewQueue,
  saveProfile,
  saveReview,
  sendCheck,
  simulationReviews,
  setShares,
  shareOptions,
  simulationDetail,
  startSimulation,
  submitTask,
} from './studentApp.service.js';

/**
 * The student app's API: /api/student-app/...
 *
 * Built for the rebuilt student screens and used by nothing else. Every
 * route is the signed-in student's own.
 */
export const studentAppRouter = Router();

studentAppRouter.use(requireRole('CANDIDATE'));

const id = z.string().trim().min(1).max(40);

/** GET /api/student-app/dashboard */
studentAppRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    res.json(await dashboard(requireCandidateId(req)));
  }),
);

/** GET /api/student-app/simulations?field=Data&q=excel */
studentAppRouter.get(
  '/simulations',
  asyncHandler(async (req, res) => {
    const { field, q } = z
      .object({ field: z.string().trim().max(80).optional(), q: z.string().trim().max(80).optional() })
      .parse(req.query);
    res.json(await listSimulations(requireCandidateId(req), { field: field || undefined, q: q || undefined }));
  }),
);

/** GET /api/student-app/simulations/:slug */
studentAppRouter.get(
  '/simulations/:slug',
  asyncHandler(async (req, res) => {
    res.json(await simulationDetail(requireCandidateId(req), req.params.slug!));
  }),
);

/** GET /api/student-app/simulations/:slug/reviews */
studentAppRouter.get(
  '/simulations/:slug/reviews',
  asyncHandler(async (req, res) => {
    res.json({ reviews: await simulationReviews(requireCandidateId(req), req.params.slug!) });
  }),
);

/** PUT /api/student-app/simulations/:slug/review  { stars, comment? } - once finished. */
studentAppRouter.put(
  '/simulations/:slug/review',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        stars: z.coerce.number().int().min(1, 'Pick from one to five stars.').max(5, 'Pick from one to five stars.'),
        comment: z.string().trim().max(1000, 'Keep it under 1,000 characters.').optional(),
      })
      .parse(req.body);
    res.json(await saveReview(requireCandidateId(req), req.params.slug!, body));
  }),
);

/**
 * POST /api/student-app/uploads - a file for a hand-in: a PDF, or a picture.
 *
 * What it is is read from its bytes, not its name. Only PDF, PNG, JPG and
 * WebP: no SVG, which can carry scripts, and no office files, which look
 * different in every reader.
 */
studentAppRouter.post(
  '/uploads',
  documentUpload.single('file'),
  asyncHandler(async (req, res) => {
    requireCandidateId(req);
    if (!req.file) throw badRequest('Choose a file to upload.');
    const buf = req.file.buffer;
    const image = sniffImage(buf);
    const url = sniffDocument(buf)
      ? await saveTenantAsset('resume', buf)
      : image && ['png', 'jpg', 'webp'].includes(image.ext)
        ? await saveTenantAsset('photo', buf)
        : null;
    if (!url) throw badRequest('Upload a PDF, or a PNG, JPG or WebP picture.');
    const name = (req.file.originalname || 'file').replace(/[\u0000-\u001f]/g, '').slice(0, 200);
    res.status(201).json({ url, name });
  }),
);

/** POST /api/student-app/simulations/:slug/start */
studentAppRouter.post(
  '/simulations/:slug/start',
  asyncHandler(async (req, res) => {
    res.json(await startSimulation(requireCandidateId(req), req.params.slug!));
  }),
);

/** A file a student hands in: one they uploaded here, never an address from elsewhere. */
const OWN_FILE = (v: string) => {
  const name = v.startsWith(`${ASSET_ROUTE}/`) ? v.slice(ASSET_ROUTE.length + 1) : '';
  return /^[\w-]+\.(pdf|png|jpg|webp)$/.test(name);
};

const handInSchema = z.object({
  answer: z.string().max(10000, 'Keep it under 10,000 characters.').optional(),
  fileUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || OWN_FILE(v), 'Upload the file again.')
    .optional()
    .nullable(),
  fileName: z.string().trim().max(200).optional().nullable(),
  link: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'A link starts with https://')
    .optional(),
});

/** PUT /api/student-app/simulations/:slug/tasks/:taskId  { answer?, link? } */
studentAppRouter.put(
  '/simulations/:slug/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const body = handInSchema.parse(req.body);
    res.json(await submitTask(requireCandidateId(req), req.params.slug!, req.params.taskId!, body));
  }),
);

const explainSchema = z.object({
  how: z.string().trim().min(40, 'Tell us a little more - a few sentences.').max(3000),
  change: z.string().trim().min(20, 'A sentence or two is enough.').max(3000),
});

/** POST /api/student-app/simulations/:slug/tasks/:taskId/checks/:pageId  { answers } - marked here. */
studentAppRouter.post(
  '/simulations/:slug/tasks/:taskId/checks/:pageId',
  asyncHandler(async (req, res) => {
    const { answers } = z.object({ answers: answersSchema }).parse(req.body);
    res.json(await answerCheck(requireCandidateId(req), req.params.slug!, req.params.taskId!, req.params.pageId!, answers));
  }),
);

/** POST /api/student-app/simulations/:slug/tasks/:taskId/checks/:pageId/reveal - shows the answers; no more tries. */
studentAppRouter.post(
  '/simulations/:slug/tasks/:taskId/checks/:pageId/reveal',
  asyncHandler(async (req, res) => {
    res.json(await revealCheck(requireCandidateId(req), req.params.slug!, req.params.taskId!, req.params.pageId!));
  }),
);

/** POST /api/student-app/simulations/:slug/tasks/:taskId/checks/:pageId/send  { attempt } - to the simulation's company. */
studentAppRouter.post(
  '/simulations/:slug/tasks/:taskId/checks/:pageId/send',
  asyncHandler(async (req, res) => {
    const { attempt } = z.object({ attempt: z.number().int().min(1).max(10000) }).parse(req.body);
    res.json(await sendCheck(requireCandidateId(req), req.params.slug!, req.params.taskId!, req.params.pageId!, attempt));
  }),
);

/** POST /api/student-app/simulations/:slug/explain  { how, change } */
studentAppRouter.post(
  '/simulations/:slug/explain',
  asyncHandler(async (req, res) => {
    res.json(await explainWork(requireCandidateId(req), req.params.slug!, explainSchema.parse(req.body)));
  }),
);

/** GET /api/student-app/runs/:runId/shares */
studentAppRouter.get(
  '/runs/:runId/shares',
  asyncHandler(async (req, res) => {
    res.json(await shareOptions(requireCandidateId(req), id.parse(req.params.runId)));
  }),
);

/** PUT /api/student-app/runs/:runId/shares  { companyIds } */
studentAppRouter.put(
  '/runs/:runId/shares',
  asyncHandler(async (req, res) => {
    const { companyIds } = z.object({ companyIds: z.array(id).max(100) }).parse(req.body);
    res.json(await setShares(requireCandidateId(req), id.parse(req.params.runId), companyIds));
  }),
);

/** GET /api/student-app/offers - internship offers made to the student. */
studentAppRouter.get(
  '/offers',
  asyncHandler(async (req, res) => {
    res.json({ offers: await myOffers(requireCandidateId(req)) });
  }),
);

/** POST /api/student-app/offers/:offerId/respond  { decision, note? } */
studentAppRouter.post(
  '/offers/:offerId/respond',
  asyncHandler(async (req, res) => {
    const body = respondSchema.parse(req.body);
    res.json({ offers: await respondToOffer(requireCandidateId(req), id.parse(req.params.offerId), body) });
  }),
);

/** GET /api/student-app/profile */
studentAppRouter.get(
  '/profile',
  asyncHandler(async (req, res) => {
    res.json(await profile(requireCandidateId(req)));
  }),
);

const profileSchema = z.object({
  interests: z
    .array(z.string().trim().min(1).max(80))
    .max(3, 'Pick up to three.')
    .transform((l) => [...new Set(l)]),
  city: z.string().trim().min(2, 'Enter the city you live in.').max(120),
  phoneCountry: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => isSupportedCountry(v), 'Pick a country code from the list.')
    .default('IN'),
  phone: z.string().trim().max(24).optional(),
  specialisation: z.string().trim().max(120).optional(),
  cgpa: z
    .union([z.literal(''), z.coerce.number().min(0, 'A CGPA is between 0 and 10.').max(10, 'A CGPA is between 0 and 10.')])
    .optional(),
})
  // The number is checked against its country, and kept as "+91 90000 00000".
  .superRefine((b, ctx) => {
    if (b.phone && !parsePhoneNumberFromString(b.phone, b.phoneCountry as CountryCode)?.isValid()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Enter a valid mobile number for that country.' });
    }
  });

/** PUT /api/student-app/profile */
studentAppRouter.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body);
    const offered = new Set(await activeInterests());
    if (body.interests.some((i) => !offered.has(i))) throw badRequest('Pick your fields from the list.');

    const phone = body.phone
      ? parsePhoneNumberFromString(body.phone, body.phoneCountry as CountryCode)!.formatInternational()
      : null;
    res.json(
      await saveProfile(requireCandidateId(req), {
        interests: body.interests,
        city: body.city,
        phone,
        specialisation: body.specialisation || null,
        cgpa: body.cgpa === '' || body.cgpa === undefined ? null : Math.round(body.cgpa * 100) / 100,
      }),
    );
  }),
);

/** POST /api/student-app/dismiss  { kind: 'suggestion' | 'run', id } */
studentAppRouter.post(
  '/dismiss',
  asyncHandler(async (req, res) => {
    const body = z.object({ kind: z.enum(['suggestion', 'run']), id }).parse(req.body);
    await dismiss(requireCandidateId(req), body.kind, body.id);
    res.json({ ok: true });
  }),
);

/**
 * The platform team's review of handed-in simulations: /api/platform/reviews.
 * Approving issues the certificate; asking for changes sends it back.
 */
export const simulationReviewRouter = Router();

simulationReviewRouter.use(requireRole('ADMIN'), requirePlatform);

/** GET /api/platform/reviews */
simulationReviewRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ reviews: await reviewQueue() });
  }),
);

/** POST /api/platform/reviews/:runId  { decision, note? } */
simulationReviewRouter.post(
  '/:runId',
  asyncHandler(async (req, res) => {
    const body = z
      .object({ decision: z.enum(['approve', 'changes']), note: z.string().trim().max(2000).optional() })
      .parse(req.body);
    await review(req.session.userId!, id.parse(req.params.runId), body);
    res.json({ reviews: await reviewQueue() });
  }),
);
