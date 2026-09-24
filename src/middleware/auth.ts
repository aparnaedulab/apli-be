import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * Session shape. Set at login, cleared at logout, and the only thing the
 * server trusts about who is calling.
 */
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    role?: Role;
    /** Set for CAMPUS users - the college they administer. */
    collegeId?: string;
    /** Set for COMPANY users - the company they belong to. */
    companyId?: string;
    /** Set for CANDIDATE users. */
    candidateId?: string;
  }
}

/**
 * Routes that may be reached without a session. This is an allowlist, not a
 * denylist: `requireAuth` is mounted globally, so a new route is protected by
 * default and only becomes public by being named here on purpose.
 *
 * Entries are matched against the path the API router sees (no /api prefix).
 */
const PUBLIC_ROUTES: ReadonlyArray<RegExp> = [
  /^\/health$/,
  /^\/auth\/login$/,
  /^\/auth\/logout$/, // idempotent, and must work even with a dead session
  /^\/auth\/invite\/[^/]+$/, // preview an invitation before accepting it
  /^\/auth\/invite\/[^/]+\/accept$/,
  /^\/auth\/join\/[^/]+$/, // preview a batch join link
  /^\/auth\/join\/[^/]+\/accept$/,
  /^\/auth\/register\/options$/, // the signup form needs the industry list to render
  /^\/auth\/register\/company$/, // the one open front door; lands in a review queue
  /^\/files\/[^/]+$/, // institution logos and favicons, shown on the sign-in page
  /^\/internships\/review\/[^/]+$/, // a mentor's evaluation link - the token is the credential
  /^\/proof\/certificates\/[^/]+$/, // anyone may check a simulation certificate is real
  /^\/public\/tenants\/[^/]+$/, // an institution's branded sign-in page and Contact us
];

function isPublic(path: string): boolean {
  return PUBLIC_ROUTES.some((pattern) => pattern.test(path));
}

/**
 * Layer 1 - authenticated. Mounted once, in front of the whole API.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (isPublic(req.path)) {
    next();
    return;
  }
  if (!req.session?.userId) {
    next(unauthorized());
    return;
  }
  next();
}

/**
 * Layer 2 - role. Applied per router, never re-checked inside a handler.
 *
 *   router.use(requireRole('CAMPUS'));
 */
export function requireRole(...allowed: Role[]) {
  return function roleGuard(req: Request, _res: Response, next: NextFunction): void {
    const role = req.session?.role;
    if (!role) {
      next(unauthorized());
      return;
    }
    if (!allowed.includes(role)) {
      next(forbidden(`This area is for ${allowed.join(' or ').toLowerCase()} accounts.`));
      return;
    }
    next();
  };
}

/**
 * Layer 3 - object scope. Not a middleware but a helper: every query that
 * reads org-owned rows must narrow by these, so a caller who guesses another
 * organisation's id gets an empty result rather than someone else's data.
 */
export function currentScope(req: Request) {
  const { userId, role, collegeId, companyId, candidateId } = req.session;
  if (!userId || !role) throw unauthorized();
  return { userId, role, collegeId, companyId, candidateId };
}

/** Narrowing helpers so handlers never repeat the null checks. */
export function requireCollegeId(req: Request): string {
  const id = req.session.collegeId;
  if (!id) throw forbidden('This account is not linked to a college.');
  return id;
}

export function requireCompanyId(req: Request): string {
  const id = req.session.companyId;
  if (!id) throw forbidden('This account is not linked to a company.');
  return id;
}

export function requireCandidateId(req: Request): string {
  const id = req.session.candidateId;
  if (!id) throw forbidden('This account is not a student account.');
  return id;
}
