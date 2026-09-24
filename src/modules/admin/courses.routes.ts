import { Router } from 'express';
import { ensureBranch } from '../tenants/branches.js';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireRole } from '../../middleware/auth.js';
import { platformWrites } from '../roles/platformWrites.js';
import { can } from '../roles/can.js';

/**
 * The courses and branches the university runs.
 *
 * Course and branch used to be free text on a batch, a student and a job -
 * which meant a role asking for "B.E." against a roster recording "B.Tech"
 * matched nobody, and nothing anywhere said so. Operations keeps the list
 * now, the same way it keeps college types and industries, and every other
 * screen picks from it.
 *
 * Nothing is deleted while it is in use. A course on a hundred students is
 * retired instead: it disappears from the forms and stays on the records that
 * already carry it, because the alternative is a hundred students whose
 * course is suddenly a name the university does not recognise.
 */

export const coursesRouter = Router();

coursesRouter.use(requireRole('ADMIN'));

// A shared list: every institution picks from it, so only the platform edits it.
coursesRouter.use(platformWrites);

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Enter a name.')
    .max(80, 'Keep it short enough to read in a dropdown.')
    // Stored as typed, compared case-insensitively, so "b.tech" cannot be
    // added alongside "B.Tech" and split one course into two.
    .regex(/^[A-Za-z0-9 &.()\-/]+$/, 'Letters, numbers, spaces and & . ( ) - / only.'),
});

/** How many records would be orphaned if this course vanished. */
async function usageOf(name: string) {
  const [batches, candidates, jobs] = await Promise.all([
    prisma.batch.count({ where: { course: name } }),
    prisma.candidate.count({ where: { course: name } }),
    prisma.jobCourse.count({ where: { course: name } }),
  ]);
  return { batches, candidates, jobs, total: batches + candidates + jobs };
}

/** GET /api/admin/courses */
coursesRouter.get(
  '/',
  can('college:read'),
  asyncHandler(async (req, res) => {
    const { includeRetired } = z
      .object({ includeRetired: z.enum(['true', 'false']).default('false') })
      .parse(req.query);

    const where = includeRetired === 'true' ? {} : { isActive: true };

    const [courses, branches] = await Promise.all([
      prisma.course.findMany({ where, orderBy: { name: 'asc' } }),
      prisma.specialisation.findMany({ where, orderBy: { name: 'asc' } }),
    ]);

    const usage = await Promise.all(courses.map((c) => usageOf(c.name)));

    res.json({
      courses: courses.map((c, i) => ({
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        inUse: usage[i]!.total,
        branches: branches
          .filter((b) => b.courseId === c.id)
          .map((b) => ({ id: b.id, name: b.name, isActive: b.isActive })),
      })),
      // Branches recorded before anybody said which course they belong to.
      looseBranches: branches
        .filter((b) => b.courseId === null)
        .map((b) => ({ id: b.id, name: b.name, isActive: b.isActive })),
    });
  }),
);

/** POST /api/admin/courses */
coursesRouter.post(
  '/',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);

    const existing = await prisma.course.findFirst({ where: { name } });
    if (existing) {
      if (!existing.isActive) {
        // Re-adding a retired course brings it back, which is what somebody
        // typing the name again actually means.
        const revived = await prisma.course.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
        res.json({ course: revived, revived: true });
        return;
      }
      throw conflict(`${existing.name} is already on the list.`);
    }

    res.status(201).json({ course: await prisma.course.create({ data: { name } }) });
  }),
);

/** POST /api/admin/courses/:id/branches */
coursesRouter.post(
  '/:id/branches',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const { name } = nameSchema.parse(req.body);

    const course = await prisma.course.findUnique({ where: { id: req.params.id } });
    if (!course) throw notFound('No such course.');

    const existing = await prisma.specialisation.findFirst({
      where: { name, courseId: course.id },
    });
    if (existing) {
      if (!existing.isActive) {
        const revived = await prisma.specialisation.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
        res.json({ branch: revived, revived: true });
        return;
      }
      throw conflict(`${existing.name} is already a branch of ${course.name}.`);
    }

    // Through the master list, so this course's branch is spelt exactly as
    // the same branch is everywhere else.
    const master = await ensureBranch(prisma, name);
    res.status(201).json({
      branch: await prisma.specialisation.create({
        data: { name: master.name, courseId: course.id, branchId: master.id },
      }),
    });
  }),
);

/** PATCH /api/admin/courses/:id — rename, or retire and restore */
coursesRouter.patch(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const data = nameSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const course = await prisma.course.findUnique({ where: { id: req.params.id } });
    if (!course) throw notFound('No such course.');

    if (data.name && data.name !== course.name) {
      const clash = await prisma.course.findFirst({
        where: { name: data.name, id: { not: course.id } },
      });
      if (clash) throw conflict(`${clash.name} is already on the list.`);

      /*
       * Renaming carries the records with it.
       *
       * Course is matched as a plain string on batches, students and roles -
       * that is what makes the eligibility query one statement - so a rename
       * that changed only this row would leave every one of them pointing at
       * a course the university no longer lists.
       */
      await prisma.$transaction([
        prisma.batch.updateMany({ where: { course: course.name }, data: { course: data.name } }),
        prisma.candidate.updateMany({
          where: { course: course.name },
          data: { course: data.name },
        }),
        prisma.jobCourse.updateMany({
          where: { course: course.name },
          data: { course: data.name },
        }),
      ]);
    }

    const updated = await prisma.course.update({
      where: { id: course.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    res.json({ course: updated });
  }),
);

/** PATCH /api/admin/courses/branches/:id — rename, or retire and restore */
coursesRouter.patch(
  '/branches/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const data = nameSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);

    const branch = await prisma.specialisation.findUnique({ where: { id: req.params.id } });
    if (!branch) throw notFound('No such branch.');

    if (data.name && data.name !== branch.name) {
      await prisma.$transaction([
        prisma.batch.updateMany({
          where: { specialisation: branch.name },
          data: { specialisation: data.name },
        }),
        prisma.candidate.updateMany({
          where: { specialisation: branch.name },
          data: { specialisation: data.name },
        }),
        prisma.jobSpecialisation.updateMany({
          where: { specialisation: branch.name },
          data: { specialisation: data.name },
        }),
      ]);
    }

    // A renamed branch is a different master branch; keep the link honest.
    const master = data.name ? await ensureBranch(prisma, data.name) : null;

    res.json({
      branch: await prisma.specialisation.update({
        where: { id: branch.id },
        data: {
          ...(master ? { name: master.name, branchId: master.id } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      }),
    });
  }),
);

/**
 * DELETE /api/admin/courses/:id
 *
 * Only while nothing uses it. A course in use is retired instead, which keeps
 * it off the forms without leaving a batch pointing at a course that no
 * longer exists.
 */
coursesRouter.delete(
  '/:id',
  can('settings:write'),
  asyncHandler(async (req, res) => {
    const course = await prisma.course.findUnique({ where: { id: req.params.id } });
    if (!course) throw notFound('No such course.');

    const usage = await usageOf(course.name);
    if (usage.total > 0) {
      const parts = [
        usage.batches ? `${usage.batches} batch${usage.batches === 1 ? '' : 'es'}` : null,
        usage.candidates ? `${usage.candidates} student${usage.candidates === 1 ? '' : 's'}` : null,
        usage.jobs ? `${usage.jobs} role${usage.jobs === 1 ? '' : 's'}` : null,
      ].filter(Boolean);

      throw conflict(
        `${parts.join(', ')} still use ${course.name}. Retire it instead — it stays on those records and disappears from the forms.`,
      );
    }

    await prisma.course.delete({ where: { id: course.id } });
    res.status(204).end();
  }),
);
