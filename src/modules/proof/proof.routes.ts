import { Router } from 'express';
import { EnrolmentStatus, SimulationStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import type { NextFunction, Request, Response } from 'express';
import { requireCandidateId, requireCompanyId, requireRole } from '../../middleware/auth.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { can } from '../roles/can.js';
import { requireModule, tenantHasModule } from '../tenants/tenant.context.js';
import {
  checkCertificate,
  createSimulation,
  decide,
  enrol,
  getCompanySimulation,
  getEnrolmentForReview,
  getForStudent,
  hasRoundAccess,
  listCompanySimulations,
  listForStudent,
  reviewQueue,
  roundSimulationsForCompany,
  roundSimulationsForStudent,
  saveAnswer,
  setSimulationStatus,
  startRoundSimulation,
  submit,
  updateSimulation,
} from './simulations.service.js';
import { passportFor, passportForCompany } from './passport.js';

/**
 * Proof of work: work simulations and the verified skills passport.
 *
 * Three audiences, fenced per route rather than per router:
 *   companies build and review simulations - not tenant-gated, a company
 *   hires across institutions;
 *   students do them and read their passport - only where their institution
 *   has the module switched on;
 *   anyone may check a certificate code, which is public by design.
 */
export const proofRouter = Router();

const company = requireRole('COMPANY');
const student = requireRole('CANDIDATE');

/* -------------------------------------------------------------------------- */
/* Public                                                                      */
/* -------------------------------------------------------------------------- */

/** GET /api/proof/certificates/:code - is this certificate real? */
proofRouter.get(
  '/certificates/:code',
  asyncHandler(async (req, res) => {
    const cert = await checkCertificate(req.params.code ?? '');
    if (!cert) throw notFound('This is not a valid certificate.');
    res.json({ certificate: cert });
  }),
);

/* -------------------------------------------------------------------------- */
/* Company                                                                     */
/* -------------------------------------------------------------------------- */

const resourceSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url('Resource links must be full addresses, starting with https://').max(500),
});

const simulationSchema = z.object({
  title: z.string().trim().min(3, 'Give it a title.').max(160),
  role: z.string().trim().min(2, 'Which role is this like?').max(120),
  summary: z.string().trim().min(10, 'Say in a sentence or two what the student will do.').max(3000),
  estimatedHours: z.number().int().min(1).max(40),
  skills: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(2, 'Every task needs a title.').max(160),
        brief: z.string().trim().min(10, 'Explain what to do in each task.').max(6000),
        resources: z.array(resourceSchema).max(10).default([]),
      }),
    )
    .max(12),
});

proofRouter.get(
  '/company/simulations',
  company,
  can('job:read'),
  asyncHandler(async (req, res) => {
    res.json({ simulations: await listCompanySimulations(requireCompanyId(req)) });
  }),
);

proofRouter.post(
  '/company/simulations',
  company,
  can('job:write'),
  asyncHandler(async (req, res) => {
    const sim = await createSimulation(requireCompanyId(req), simulationSchema.parse(req.body));
    res.status(201).json({ simulation: await getCompanySimulation(requireCompanyId(req), sim.id) });
  }),
);

proofRouter.get(
  '/company/simulations/:id',
  company,
  can('job:read'),
  asyncHandler(async (req, res) => {
    res.json({ simulation: await getCompanySimulation(requireCompanyId(req), req.params.id!) });
  }),
);

proofRouter.put(
  '/company/simulations/:id',
  company,
  can('job:write'),
  asyncHandler(async (req, res) => {
    await updateSimulation(requireCompanyId(req), req.params.id!, simulationSchema.parse(req.body));
    res.json({ simulation: await getCompanySimulation(requireCompanyId(req), req.params.id!) });
  }),
);

proofRouter.post(
  '/company/simulations/:id/status',
  company,
  can('job:write'),
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.nativeEnum(SimulationStatus) }).parse(req.body);
    await setSimulationStatus(requireCompanyId(req), req.params.id!, status);
    res.json({ simulation: await getCompanySimulation(requireCompanyId(req), req.params.id!) });
  }),
);

proofRouter.get(
  '/company/enrolments',
  company,
  can('application:read'),
  asyncHandler(async (req, res) => {
    const status = z.nativeEnum(EnrolmentStatus).optional().parse(req.query.status || undefined);
    res.json({ enrolments: await reviewQueue(requireCompanyId(req), status) });
  }),
);

proofRouter.get(
  '/company/enrolments/:id',
  company,
  can('application:read'),
  asyncHandler(async (req, res) => {
    res.json({ enrolment: await getEnrolmentForReview(requireCompanyId(req), req.params.id!) });
  }),
);

const decisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('NEEDS_WORK'), note: z.string().trim().min(3, 'Say what needs work - the student is shown this.').max(2000) }),
  z.object({
    action: z.literal('BOOK_EXPLAIN'),
    explainAt: z.coerce.date(),
    note: z.string().trim().min(3, 'Add the meeting link and anything the student should prepare.').max(2000),
  }),
  z.object({ action: z.literal('COMPLETE'), note: z.string().trim().max(2000).optional() }),
]);

proofRouter.post(
  '/company/enrolments/:id/decision',
  company,
  can('application:advance'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await decide(companyId, req.params.id!, req.session.userId!, decisionSchema.parse(req.body));
    res.json({ enrolment: await getEnrolmentForReview(companyId, req.params.id!) });
  }),
);

/**
 * GET /api/proof/company/applications/:id/simulations - how far one applicant
 * has got in the job's work-simulation rounds. Only the company's own applicants.
 */
proofRouter.get(
  '/company/applications/:id/simulations',
  company,
  can('application:read'),
  asyncHandler(async (req, res) => {
    res.json({ rounds: await roundSimulationsForCompany(requireCompanyId(req), req.params.id!) });
  }),
);

/** GET /api/proof/company/passport/:candidateId - only for the company's own applicants. */
proofRouter.get(
  '/company/passport/:candidateId',
  company,
  can('application:read'),
  asyncHandler(async (req, res) => {
    res.json({ passport: await passportForCompany(requireCompanyId(req), req.params.candidateId!) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Student                                                                     */
/* -------------------------------------------------------------------------- */

const simulations = requireModule('proof.simulations');

/**
 * The module, or a job that put this simulation in the student's way. A
 * company using a simulation as a hiring round decides that on its own; the
 * student must be able to do it even where their institution has not switched
 * the catalogue of simulations on.
 */
async function simulationsOrRound(req: Request, _res: Response, next: NextFunction) {
  try {
    if (await tenantHasModule(req.session.tenantId, 'proof.simulations')) return next();
    if (await hasRoundAccess(requireCandidateId(req), req.params.id!)) return next();
    next(forbidden('Your institution does not have this feature switched on.'));
  } catch (err) {
    next(err);
  }
}

/** GET /api/proof/rounds/mine - applications waiting at a work-simulation round. */
proofRouter.get(
  '/rounds/mine',
  student,
  asyncHandler(async (req, res) => {
    res.json({ rounds: await roundSimulationsForStudent(requireCandidateId(req)) });
  }),
);

/** POST /api/proof/rounds/:applicationId/start - begin (or return to) the round's simulation. */
proofRouter.post(
  '/rounds/:applicationId/start',
  student,
  asyncHandler(async (req, res) => {
    res.json(await startRoundSimulation(requireCandidateId(req), req.params.applicationId!));
  }),
);

proofRouter.get(
  '/simulations',
  student,
  simulations,
  asyncHandler(async (req, res) => {
    res.json({ simulations: await listForStudent(requireCandidateId(req)) });
  }),
);

proofRouter.get(
  '/simulations/:id',
  student,
  simulationsOrRound,
  asyncHandler(async (req, res) => {
    res.json({ simulation: await getForStudent(requireCandidateId(req), req.params.id!) });
  }),
);

proofRouter.post(
  '/simulations/:id/enrol',
  student,
  simulations,
  asyncHandler(async (req, res) => {
    await enrol(requireCandidateId(req), req.params.id!);
    res.status(201).json({ simulation: await getForStudent(requireCandidateId(req), req.params.id!) });
  }),
);

const answerSchema = z
  .object({
    text: z.string().max(20000).optional(),
    link: z.string().trim().url('A link must be a full address, starting with https://').max(500).optional().or(z.literal('')),
  })
  .refine((a) => Boolean(a.text?.trim() || a.link), { message: 'Write an answer or add a link.', path: ['text'] });

proofRouter.put(
  '/simulations/:id/tasks/:taskId',
  student,
  simulationsOrRound,
  asyncHandler(async (req, res) => {
    await saveAnswer(requireCandidateId(req), req.params.id!, req.params.taskId!, answerSchema.parse(req.body));
    res.json({ simulation: await getForStudent(requireCandidateId(req), req.params.id!) });
  }),
);

proofRouter.post(
  '/simulations/:id/submit',
  student,
  simulationsOrRound,
  asyncHandler(async (req, res) => {
    await submit(requireCandidateId(req), req.params.id!);
    res.json({ simulation: await getForStudent(requireCandidateId(req), req.params.id!) });
  }),
);

/** GET /api/proof/passport - the student's own passport. */
proofRouter.get(
  '/passport',
  student,
  requireModule('proof.passport'),
  asyncHandler(async (req, res) => {
    res.json({ passport: await passportFor(requireCandidateId(req)) });
  }),
);
