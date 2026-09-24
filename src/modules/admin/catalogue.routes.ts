import { Router } from 'express';
import { RefKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { ACCOMMODATIONS, PWD_CATEGORIES, TRAVEL } from '../jobs/inclusion.js';

/**
 * The course catalogue, readable by anybody signed in.
 *
 * Operations keeps the list; a placement cell creating a batch and a recruiter
 * writing criteria both have to pick from the same one, or the exact-string
 * matching that eligibility depends on starts failing quietly.
 *
 * No capability check: these are the names of courses a university runs, which
 * every staff account needs and none of them could misuse. Editing the list is
 * a different matter and lives on the admin router behind `settings:write`.
 */
export const catalogueRouter = Router();

/**
 * GET /api/catalogue
 *
 * Every list a form might need, in one call. A form that asks for a city, a
 * course and a NAAC grade should not make three requests to fill three
 * dropdowns.
 */
catalogueRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    /*
     * Colleges are the one list here that belongs to somebody.
     *
     * Courses, cities and skills are the platform's and the same everywhere;
     * a college belongs to the institution that runs it, so a student is
     * offered their own university's and nobody else's. Operations, which has
     * no tenant of its own, sees them all.
     */
    const tenantId = req.session.tenantId;

    const [courses, branches, values, collegeTypes, industries, skills, colleges] = await Promise.all([
      prisma.course.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.specialisation.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.refValue.findMany({
        where: { isActive: true },
        orderBy: [{ position: 'asc' }, { value: 'asc' }],
      }),
      prisma.collegeType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.industry.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      // Shared between students and roles: a student lists one and a role
      // asks for it, and they only meet if it is the same row. Offering the
      // list is what stops a third spelling being typed.
      prisma.skill.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
      prisma.college.findMany({
        where: tenantId ? { tenantId } : {},
        orderBy: { name: 'asc' },
        // The name is all a dropdown needs. Codes, contacts and counts are
        // the institution's business, not a student's.
        select: { name: true },
      }),
    ]);

    const of = (kind: RefKind) => values.filter((v) => v.kind === kind).map((v) => v.value);

    res.json({
      courses: courses.map((c) => ({
        id: c.id,
        name: c.name,
        branches: branches.filter((b) => b.courseId === c.id).map((b) => b.name),
      })),
      looseBranches: branches.filter((b) => b.courseId === null).map((b) => b.name),
      cities: of(RefKind.CITY),
      states: of(RefKind.STATE),
      naacGrades: of(RefKind.NAAC_GRADE),
      genders: of(RefKind.GENDER),
      collegeTypes: collegeTypes.map((t) => ({ id: t.id, name: t.name })),
      industries: industries.map((i) => ({ id: i.id, name: i.name })),
      skills: skills.map((s) => s.name),
      colleges: colleges.map((c) => c.name),
      // Fixed lists, not reference data: a role states these and a student
      // answers in the same keys, so they have to be the same list on both
      // sides of the screen rather than two that drifted.
      pwdCategories: PWD_CATEGORIES,
      accommodations: ACCOMMODATIONS,
      travel: TRAVEL,
    });
  }),
);

/** GET /api/catalogue/courses */
catalogueRouter.get(
  '/courses',
  asyncHandler(async (_req, res) => {
    const [courses, branches] = await Promise.all([
      prisma.course.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      prisma.specialisation.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    ]);

    res.json({
      courses: courses.map((c) => ({
        id: c.id,
        name: c.name,
        branches: branches.filter((b) => b.courseId === c.id).map((b) => b.name),
      })),
      // Branches recorded before anybody said which course they belong to.
      // Offered everywhere, since narrowing by course would hide them.
      looseBranches: branches.filter((b) => b.courseId === null).map((b) => b.name),
    });
  }),
);
