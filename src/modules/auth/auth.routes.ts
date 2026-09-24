import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { unauthorized } from '../../lib/errors.js';
import { isProduction } from '../../config/env.js';
import { z } from 'zod';
import { loginSchema } from './auth.schemas.js';
import { authenticate, getActiveUser, SCOPE_INCLUDE } from './auth.service.js';
import { describeSession, openSession } from '../tenants/tenant.session.js';
import { acceptInvite, previewInvite } from '../invites/invite.service.js';
import { joinBatchByCode, previewJoinCode } from '../campus/campus.service.js';
import { prisma } from '../../lib/prisma.js';
import { companyRegistrationSchema } from '../company/company.schemas.js';
import { registerCompany } from '../company/registration.service.js';

/**
 * Tighter than the global API limit. Login is the one endpoint where an
 * attacker gets unlimited free guesses, so it gets its own budget.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: {
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many sign-in attempts. Try again in a few minutes.',
    },
  },
});

/** express-session is callback-based; these keep the handlers linear. */
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export const authRouter = Router();

/**
 * POST /api/auth/login
 * Public. Sets the session cookie and returns the signed-in user.
 */
authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await authenticate(email, password);

    // A fresh session id after a successful login, so a session fixed before
    // sign-in cannot be reused afterwards.
    await regenerateSession(req);

    await openSession(req, user);
    await saveSession(req);

    res.json(await describeSession(req, user));
  }),
);

/**
 * GET /api/auth/me
 * Requires a session. Re-reads the user so a deactivated account is rejected
 * on the next request rather than when the cookie expires.
 */
authRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    if (!userId) throw unauthorized();

    const user = await getActiveUser(userId);
    res.json(await describeSession(req, user));
  }),
);

/**
 * POST /api/auth/logout
 * Idempotent - always succeeds, whether or not there was a session.
 */
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await destroySession(req);
    res.clearCookie('campus.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
    });
    res.status(204).end();
  }),
);

/* -------------------------------------------------------------------------- */
/* Invitations - this is what "sign up" means here. There is no open form.     */
/* -------------------------------------------------------------------------- */

const acceptSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  password: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200, 'That password is too long.'),
});

/** Slower than login: guessing invite tokens should not be cheap either. */
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again shortly.' },
  },
});

/**
 * GET /api/auth/invite/:token
 * Public. Shows who invited you and to what, before you commit to anything.
 */
authRouter.get(
  '/invite/:token',
  inviteLimiter,
  asyncHandler(async (req, res) => {
    const preview = await previewInvite(req.params.token!);
    res.json({ invite: preview });
  }),
);

/**
 * POST /api/auth/invite/:token/accept
 * Public. Creates the account and its membership, then signs them straight in -
 * asking someone to log in immediately after setting a password is friction
 * with no security benefit.
 */
authRouter.post(
  '/invite/:token/accept',
  inviteLimiter,
  asyncHandler(async (req, res) => {
    const body = acceptSchema.parse(req.body);
    const user = await acceptInvite(req.params.token!, body);

    await regenerateSession(req);

    await openSession(req, user);
    await saveSession(req);

    res.status(201).json(await describeSession(req, user));
  }),
);

/* -------------------------------------------------------------------------- */
/* Batch join links - the other way a student gets in, as described in the      */
/* reference manual: "either by copying and sharing the link or by providing    */
/* emails". One code per batch, shared openly, revocable at any time.           */
/* -------------------------------------------------------------------------- */

const joinSchema = acceptSchema.extend({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
});

/** GET /api/auth/join/:code — public preview of the batch being joined */
authRouter.get(
  '/join/:code',
  inviteLimiter,
  asyncHandler(async (req, res) => {
    const batch = await previewJoinCode(req.params.code!);
    res.json({ batch });
  }),
);

/** POST /api/auth/join/:code/accept — self-registration into that batch */
authRouter.post(
  '/join/:code/accept',
  inviteLimiter,
  asyncHandler(async (req, res) => {
    const body = joinSchema.parse(req.body);
    const user = await joinBatchByCode(req.params.code!, body);

    await regenerateSession(req);

    await openSession(req, user);
    await saveSession(req);

    res.status(201).json(await describeSession(req, user));
  }),
);

/* -------------------------------------------------------------------------- */
/* Company registration - the one open front door, and it opens onto a queue.  */
/* -------------------------------------------------------------------------- */

/**
 * Stricter than invites. This endpoint creates rows, so the budget is what a
 * genuine recruiter needs and no more.
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many registrations from here. Try again later.',
    },
  },
});

const registerSchema = z.object({
  company: companyRegistrationSchema,
  contact: z.object({
    fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid work email address.'),
    password: z
      .string()
      .min(10, 'Use at least 10 characters.')
      .max(200, 'That password is too long.'),
  }),
});

/**
 * GET /api/auth/register/options
 * Public, because the registration form needs the industry list to render and
 * the person filling it in does not have an account yet.
 */
authRouter.get(
  '/register/options',
  asyncHandler(async (_req, res) => {
    const industries = await prisma.industry.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    // Size bands are an enum in the schema; their wording is presentation and
    // lives on the client, so it cannot drift between two forms.
    res.json({ industries });
  }),
);

/**
 * POST /api/auth/register/company
 * Creates the company PENDING and stops there: the account exists but cannot
 * sign in until operations has verified the company.
 */
authRouter.post(
  '/register/company',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const { company } = await registerCompany(body);

    // Deliberately not signed in. The company is PENDING until operations has
    // checked it is real, and there is nothing for a recruiter to do until
    // then - being let straight in would say the opposite.
    res.status(201).json({
      company: { id: company.id, name: company.name, status: company.status },
    });
  }),
);
