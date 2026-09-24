import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { prisma } from '../../lib/prisma.js';
import { unauthorized } from '../../lib/errors.js';

/**
 * The language a person reads the portal in.
 *
 * Kept on the account rather than only in the browser, so a student who
 * chose Marathi on their phone finds Marathi on the college lab computer too.
 * The browser keeps a copy as well, so the first paint is already in the
 * right language before this answers.
 *
 * Open to any signed-in person: a language is nobody's secret, and each
 * account only ever reads and writes its own.
 */

export const LOCALES = ['en', 'hi', 'mr'] as const;
export type Locale = (typeof LOCALES)[number];

const putSchema = z.object({
  locale: z.enum(LOCALES, { errorMap: () => ({ message: 'Choose English, Hindi or Marathi.' }) }),
});

export const localeRouter = Router();

/** GET /api/locale - the saved choice, or null when none has been made. */
localeRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    if (!userId) throw unauthorized();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
    const locale = user?.locale && (LOCALES as readonly string[]).includes(user.locale) ? user.locale : null;
    res.json({ locale, available: LOCALES });
  }),
);

/** PUT /api/locale { locale } - save the choice for this account. */
localeRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    if (!userId) throw unauthorized();
    const { locale } = putSchema.parse(req.body);
    await prisma.user.update({ where: { id: userId }, data: { locale } });
    res.json({ locale });
  }),
);
