import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { platformWrites } from '../roles/platformWrites.js';
import { can } from '../roles/can.js';

/**
 * The skills the portal knows about, kept by operations.
 *
 * A skill is shared: a student lists it on their profile and a role asks for
 * it, and they only meet if it is the same row. That is exactly why it is not
 * a recruiter's to invent - "Node.js", "NodeJS" and "node js" would be three
 * skills that never match each other, and nobody would notice until a search
 * quietly returned nobody.
 *
 * Kept as its own table rather than among the flat vocabularies because it
 * has relations on both sides, and those are what the usage count reads.
 */

export const skillsRouter = Router();

skillsRouter.use(requireRole('ADMIN'));

// A shared list: every institution picks from it, so only the platform edits it.
skillsRouter.use(platformWrites);

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a skill.')
    .max(60, 'Keep it short enough to read in a list.')
    // Collapsed so "React  Native" and "React Native" cannot both exist.
    .transform((v) => v.replace(/\s+/g, ' ')),
});

/** GET /api/admin/skills */
skillsRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (_req, res) => {
    const skills = await prisma.skill.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { candidates: true, jobs: true } } },
    });

    res.json({
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        students: s._count.candidates,
        roles: s._count.jobs,
        inUse: s._count.candidates + s._count.jobs,
      })),
    });
  }),
);

/** POST /api/admin/skills */
skillsRouter.post(
  '/',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);

    const existing = await prisma.skill.findFirst({ where: { name } });
    if (existing) throw conflict(`${existing.name} is already on the list.`);

    res.status(201).json({ skill: await prisma.skill.create({ data: { name } }) });
  }),
);

/** PATCH /api/admin/skills/:id — rename */
skillsRouter.patch(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);

    const skill = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!skill) throw notFound('No such skill.');

    const clash = await prisma.skill.findFirst({ where: { name, id: { not: skill.id } } });
    if (clash) {
      throw conflict(
        `${clash.name} is already on the list. Two rows for one skill is what this list exists to prevent.`,
      );
    }

    // Renaming needs no fan-out: students and roles point at the row by id,
    // so they follow it. That is the whole advantage of a table over a string.
    res.json({ skill: await prisma.skill.update({ where: { id: skill.id }, data: { name } }) });
  }),
);

/**
 * DELETE /api/admin/skills/:id
 *
 * Only while nobody claims it and no role asks for it. There is no retiring
 * here: a skill nobody uses is noise, and one somebody uses should stay.
 */
skillsRouter.delete(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const skill = await prisma.skill.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { candidates: true, jobs: true } } },
    });
    if (!skill) throw notFound('No such skill.');

    const { candidates, jobs } = skill._count;
    if (candidates + jobs > 0) {
      const parts = [
        candidates ? `${candidates} student${candidates === 1 ? '' : 's'} list${candidates === 1 ? 's' : ''} it` : null,
        jobs ? `${jobs} role${jobs === 1 ? '' : 's'} ask${jobs === 1 ? 's' : ''} for it` : null,
      ].filter(Boolean);

      throw conflict(`${parts.join(' and ')}. Rename it instead if it is wrong.`);
    }

    await prisma.skill.delete({ where: { id: skill.id } });
    res.status(204).end();
  }),
);
