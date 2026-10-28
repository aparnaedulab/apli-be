import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCompanyId, requireRole } from '../../middleware/auth.js';
import {
  createProcess,
  duplicateProcess,
  getProcess,
  listProcesses,
  questionPacks,
  removeProcess,
  setProcessRounds,
  simulationChoices,
  updateProcess,
} from './interviewProcess.service.js';

/**
 * Company-owned interview processes: /api/company/interview-processes
 *
 * A company defines reusable hiring pipelines here — each has a name,
 * a type (hiring / internship), a status, and an ordered list of rounds.
 * The rounds follow the same shape as job rounds so everything the placement
 * system already understands about rounds applies here too.
 */
export const interviewProcessRouter = Router();

interviewProcessRouter.use(requireRole('COMPANY'));

const optional = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(''));

const processSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Give this process a name of at least three characters.')
    .max(120),
  description: optional(600),
  processType: z.enum(['HIRING', 'INTERNSHIP']).default('HIRING'),
});

const patchSchema = processSchema
  .partial()
  .extend({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional() });

const roundsSchema = z.object({
  rounds: z
    .array(
      z.object({
        order: z.coerce.number().int().min(1).optional(),
        name: z.string().trim().min(1, 'Name the round.').max(120),
        type: z.string().trim().min(1).max(60).default('RESUME_SCREEN'),
        isElimination: z.boolean().default(false),
        description: optional(2000),
        isOnline: z.boolean().default(false),
        meetingLink: optional(500),
        addressLine: optional(400),
        shortlistCount: z.coerce.number().int().min(1).max(100_000).optional(),
        durationMin: z.coerce.number().int().min(5).max(1440).optional(),
        mode: optional(60),
        /** Recorded interview: seconds to think, then to answer, per question. */
        questionTimeSec: z.coerce.number().int().min(30, 'Give at least 30 seconds to answer.').max(600).optional(),
        prepTimeSec: z.coerce.number().int().min(0).max(300).optional(),
        /** Work-simulation round: which simulation. */
        simulationId: z.string().trim().max(40).optional().or(z.literal('')),
        questions: z
          .array(
            z.object({
              text: z.string().trim().min(5, 'Write the question.').max(600),
              hint: optional(400),
              type: z.enum(['intro', 'behavioural', 'situational', 'technical', 'motivation']).default('behavioural'),
            }),
          )
          .max(10, 'Up to ten questions in a round.')
          .default([]),
      }),
    )
    .max(12, 'Twelve rounds is more than enough.'),
});

/** GET /api/company/interview-processes */
interviewProcessRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const processes = await listProcesses(requireCompanyId(req));
    res.json({ processes });
  }),
);

/** POST /api/company/interview-processes */
interviewProcessRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = processSchema.parse(req.body);
    const process = await createProcess(requireCompanyId(req), req.session.userId!, {
      title: data.title,
      description: data.description || null,
      processType: data.processType,
    });
    res.status(201).json({ process });
  }),
);

/** GET /api/company/interview-processes/packs - question packs for a recorded interview. */
interviewProcessRouter.get(
  '/packs',
  asyncHandler(async (_req, res) => {
    res.json({ packs: await questionPacks() });
  }),
);

/** GET /api/company/interview-processes/simulations - the company's live simulations, for a round. */
interviewProcessRouter.get(
  '/simulations',
  asyncHandler(async (req, res) => {
    res.json({ simulations: await simulationChoices(requireCompanyId(req)) });
  }),
);

/** GET /api/company/interview-processes/:id */
interviewProcessRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const process = await getProcess(requireCompanyId(req), req.params.id!);
    res.json({ process });
  }),
);

/** PATCH /api/company/interview-processes/:id */
interviewProcessRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = patchSchema.parse(req.body);
    const process = await updateProcess(requireCompanyId(req), req.params.id!, {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description || null }),
      ...(data.processType !== undefined && { processType: data.processType }),
      ...(data.status !== undefined && { status: data.status }),
    });
    res.json({ process });
  }),
);

/** PUT /api/company/interview-processes/:id/rounds */
interviewProcessRouter.put(
  '/:id/rounds',
  asyncHandler(async (req, res) => {
    const { rounds } = roundsSchema.parse(req.body);
    const process = await setProcessRounds(
      requireCompanyId(req),
      req.params.id!,
      rounds.map((r, i) => ({
        order: i + 1,
        name: r.name,
        type: r.type,
        isElimination: r.isElimination,
        description: r.description || null,
        isOnline: r.isOnline,
        meetingLink: r.meetingLink || null,
        addressLine: r.addressLine || null,
        shortlistCount: r.shortlistCount ?? null,
        durationMin: r.durationMin ?? null,
        mode: r.mode || null,
        questionTimeSec: r.questionTimeSec ?? null,
        prepTimeSec: r.prepTimeSec ?? null,
        simulationId: r.simulationId || null,
        questions: r.questions.map((q) => ({ text: q.text, hint: q.hint || null, type: q.type })),
      })),
    );
    res.json({ process });
  }),
);

/** POST /api/company/interview-processes/:id/duplicate - a fresh draft copy, to change one in use. */
interviewProcessRouter.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const process = await duplicateProcess(requireCompanyId(req), req.session.userId!, req.params.id!);
    res.status(201).json({ process });
  }),
);

/** DELETE /api/company/interview-processes/:id */
interviewProcessRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await removeProcess(requireCompanyId(req), req.params.id!);
    res.json({ ok: true });
  }),
);
