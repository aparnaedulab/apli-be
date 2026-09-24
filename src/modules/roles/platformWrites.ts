import type { NextFunction, Request, Response } from 'express';
import { requirePlatform } from '../tenants/tenant.context.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads for every operations account, writes for the platform team only.
 *
 * For the things every institution shares - roles, the course and industry
 * lists, the reference vocabularies, the companies in the marketplace. A
 * tenant admin reads them all day, to pick from; but a rename there is a
 * rename in every other university's portal, made by somebody who answers to
 * none of them. So changing one is the platform's job.
 *
 * Mounted after requireRole('ADMIN') and before the per-route permission
 * checks, which still apply on top.
 */
export function platformWrites(req: Request, res: Response, next: NextFunction): void {
  if (READS.has(req.method)) {
    next();
    return;
  }
  requirePlatform(req, res, next);
}
