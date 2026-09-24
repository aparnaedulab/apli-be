import { describe, expect, it } from 'vitest';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent } from './factories.js';
import { eligibilityOptions } from '../src/modules/jobs/job.service.js';

/**
 * What the Eligibility step of the job form offers.
 *
 * The rule the tests hold: the picker is never narrower than the matcher. A
 * course the visibility query would match on has to be a course a recruiter
 * can choose, or the role reaches nobody and nothing says why.
 */

describe('courses and branches offered to a recruiter', () => {
  it('offers what a batch carries, even before the catalogue knows the name', async () => {
    const college = await makeCollege();
    await makeBatch(college.id, { course: 'B.Tech' });
    await db.batch.updateMany({ data: { specialisation: 'Computer Science' } });

    const options = await eligibilityOptions();

    // Nothing is in Course or Specialisation - this is the case that used to
    // read "No courses set up yet" while fourteen students sat in the batch.
    expect(await db.course.count()).toBe(0);
    expect(options.courses).toContain('B.Tech');
    expect(options.specialisations).toContain('Computer Science');
  });

  it('offers what a student carries, when it is their own rather than their batch', async () => {
    const college = await makeCollege();
    const batch = await makeBatch(college.id, { course: 'B.Tech' });
    const { candidate } = await makeStudent(batch.id, { collegeId: college.id });
    await db.candidate.update({
      where: { id: candidate.id },
      data: { course: 'MCA', specialisation: 'Data Science' },
    });

    const options = await eligibilityOptions();

    expect(options.courses).toEqual(expect.arrayContaining(['B.Tech', 'MCA']));
    expect(options.specialisations).toContain('Data Science');
  });

  it('offers the catalogue, and the catalogue first', async () => {
    const course = await db.course.create({ data: { name: 'B.Tech' } });
    const branch = await db.branch.create({ data: { name: 'Computer Science' } });
    await db.specialisation.create({
      data: { name: branch.name, branchId: branch.id, courseId: course.id },
    });
    await db.course.create({ data: { name: 'MCA' } });

    const options = await eligibilityOptions();

    expect(options.courses).toEqual(['B.Tech', 'MCA']);
    expect(options.specialisations).toEqual(['Computer Science']);
  });

  it('says a name once, however many places it is set up in', async () => {
    await db.course.create({ data: { name: 'B.Tech' } });
    const college = await makeCollege();
    await makeBatch(college.id, { course: 'B.Tech' });
    await makeBatch(college.id, { course: 'B.Tech' });

    const options = await eligibilityOptions();

    expect(options.courses.filter((c) => c === 'B.Tech')).toHaveLength(1);
  });

  it('leaves out a course nobody has set up and a retired one', async () => {
    await db.course.create({ data: { name: 'B.Arch', isActive: false } });

    const options = await eligibilityOptions();

    expect(options.courses).not.toContain('B.Arch');
    expect(options.courses).toEqual([]);
  });

  it('offers the years somebody is actually graduating in', async () => {
    const college = await makeCollege();
    await makeBatch(college.id, { graduationYear: 2027 });
    await makeBatch(college.id, { graduationYear: 2026 });

    const options = await eligibilityOptions();

    expect(options.graduationYears).toEqual([2026, 2027]);
  });
});
