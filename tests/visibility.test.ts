import { describe, expect, it } from 'vitest';
import { ApplicationStatus as S, JobStatus, PostingStatus } from '@prisma/client';
import { db } from './setup.js';
import {
  explainIneligibility,
  loadCandidateContext,
  resolvePlacementFor,
  visibleJobWhere,
} from '../src/modules/jobs/visibility.js';
import {
  makeApplication,
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makePosting,
  makeRecruiter,
  makeStudent,
} from './factories.js';

/**
 * The six conditions, one test each. Every test builds a world where the role
 * *is* visible, then breaks exactly one condition and expects it to disappear -
 * so a failure names the rule that broke.
 */
describe('what a student can see', () => {
  async function setupVisible(opts: { studentCgpa?: number; frozen?: boolean } = {}) {
    const college = await makeCollege();
    const batch = await makeBatch(college.id);
    const drive = await makeDrive(college.id, batch.id);
    const company = await makeCompany();
    const recruiter = await makeRecruiter(company.id);
    const { candidate } = await makeStudent(batch.id, {
      collegeId: college.id,
      cgpa: opts.studentCgpa ?? 8.5,
      frozen: opts.frozen ?? true,
    });
    const job = await makeJob(company.id, recruiter.id);
    const posting = await makePosting(job.id, drive.id);
    return { college, batch, drive, company, recruiter, candidate, job, posting };
  }

  async function visibleCount(candidateId: string): Promise<number> {
    const ctx = await loadCandidateContext(candidateId);
    return db.job.count({ where: visibleJobWhere(ctx) });
  }

  it('shows a role when all six conditions hold', async () => {
    const w = await setupVisible();
    expect(await visibleCount(w.candidate.id)).toBe(1);
  });

  it('1. hides a job the company has not published', async () => {
    const w = await setupVisible();
    await db.job.update({ where: { id: w.job.id }, data: { status: JobStatus.DRAFT } });
    expect(await visibleCount(w.candidate.id)).toBe(0);
  });

  it('2. hides a job whose deadline has passed', async () => {
    const w = await setupVisible();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await db.job.update({ where: { id: w.job.id }, data: { deadline: yesterday } });
    expect(await visibleCount(w.candidate.id)).toBe(0);
  });

  it('3. hides a job the college has not accepted', async () => {
    const w = await setupVisible();
    await db.jobPosting.update({
      where: { id: w.posting.id },
      data: { status: PostingStatus.PENDING },
    });
    expect(await visibleCount(w.candidate.id)).toBe(0);

    await db.jobPosting.update({
      where: { id: w.posting.id },
      data: { status: PostingStatus.DECLINED },
    });
    expect(await visibleCount(w.candidate.id)).toBe(0);
  });

  it('4. hides a job aimed at a drive the student is not in', async () => {
    const w = await setupVisible();
    const otherCollege = await makeCollege('Other College');
    const otherBatch = await makeBatch(otherCollege.id);
    const otherDrive = await makeDrive(otherCollege.id, otherBatch.id);

    await db.jobPosting.update({
      where: { id: w.posting.id },
      data: { placementId: otherDrive.id },
    });
    expect(await visibleCount(w.candidate.id)).toBe(0);
  });

  /*
   * A drive at a big college holds several batches, and a role aimed at the
   * computing one should not land in front of the civil one.
   */
  describe('4b. the batches inside a drive', () => {
    it('reaches the whole drive when no batch was named', async () => {
      const w = await setupVisible();
      expect(await db.jobPostingBatch.count({ where: { postingId: w.posting.id } })).toBe(0);

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('reaches a student whose batch was named', async () => {
      const w = await setupVisible();
      await db.jobPostingBatch.create({
        data: { postingId: w.posting.id, batchId: w.batch.id },
      });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides it from a student in a batch that was not named', async () => {
      const w = await setupVisible();
      const other = await makeBatch(w.college.id);
      await db.jobPostingBatch.create({ data: { postingId: w.posting.id, batchId: other.id } });

      // Their college accepted it and their drive carries it - the narrowing
      // is the only thing standing between them and the role.
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('will not let them apply to a role their batch was left out of', async () => {
      const w = await setupVisible();
      const other = await makeBatch(w.college.id);
      await db.jobPostingBatch.create({ data: { postingId: w.posting.id, batchId: other.id } });

      const ctx = await loadCandidateContext(w.candidate.id);

      // Hiding it in the list is not enough on its own: applying by id has to
      // meet the same narrowing, or the list is only a suggestion.
      await expect(resolvePlacementFor(w.job.id, ctx)).rejects.toThrow();
    });
  });

  describe('5. criteria', () => {
    it('hides a job whose CGPA bar the student misses', async () => {
      const w = await setupVisible({ studentCgpa: 6.0 });
      await db.job.update({ where: { id: w.job.id }, data: { minCgpa: 7.5 } });
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('treats a missing CGPA as failing the bar, not passing it', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { cgpa: null } });
      await db.job.update({ where: { id: w.job.id }, data: { minCgpa: 7.5 } });
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('shows a job with no CGPA bar to a student with no CGPA', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { cgpa: null } });
      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides a job restricted to another course', async () => {
      const w = await setupVisible();
      await db.jobCourse.create({ data: { jobId: w.job.id, course: 'M.Tech' } });
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('shows a job restricted to the course the student is on', async () => {
      const w = await setupVisible();
      await db.jobCourse.create({ data: { jobId: w.job.id, course: 'B.Tech' } });
      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides a job restricted to another graduating year', async () => {
      const w = await setupVisible();
      await db.jobGradYear.create({ data: { jobId: w.job.id, year: 2027 } });
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('hides a job when the student has more backlogs than allowed', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { backlogs: 3 } });
      await db.job.update({ where: { id: w.job.id }, data: { maxBacklogs: 0 } });
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    /*
     * Backlogs are two criteria stated in one breath - "no live backlogs, at
     * most two cleared" - and a student who cleared theirs must not be
     * refused by the rule about the ones they no longer have.
     */
    it('lets a student with cleared backlogs past a no-live-backlogs bar', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { backlogs: 2, activeBacklogs: 0 },
      });
      await db.job.update({
        where: { id: w.job.id },
        data: { maxActiveBacklogs: 0, maxBacklogs: 2 },
      });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides it from a student who still has one outstanding', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { backlogs: 1, activeBacklogs: 1 },
      });
      await db.job.update({ where: { id: w.job.id }, data: { maxActiveBacklogs: 0 } });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('treats an unrecorded live-backlog count as failing the bar', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { activeBacklogs: null } });
      await db.job.update({ where: { id: w.job.id }, data: { maxActiveBacklogs: 0 } });

      // "Nothing on record" is not the same as "none", and guessing in the
      // student's favour would put them in front of a recruiter on a claim
      // the college never made.
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    /*
     * One bar a role may write in either unit. A university that awards a
     * percentage rather than a CGPA had every one of its students fail every
     * CGPA bar before this, silently.
     */
    it('lets a percentage clear a bar stated in percentages', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { cgpa: null, degreePct: 78 },
      });
      await db.job.update({ where: { id: w.job.id }, data: { minDegreePct: 70 } });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('clears a two-unit bar on whichever unit the student has', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { cgpa: null, degreePct: 78 },
      });
      // "7.5 CGPA or 70%" - they have no CGPA, so the percentage decides.
      await db.job.update({
        where: { id: w.job.id },
        data: { minCgpa: 7.5, minDegreePct: 70 },
      });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('still hides it from somebody who clears neither unit', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { cgpa: 6, degreePct: 60 },
      });
      await db.job.update({
        where: { id: w.job.id },
        data: { minCgpa: 7.5, minDegreePct: 70 },
      });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('hides a percentage-only bar from a student who has only a CGPA', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { degreePct: null } });
      await db.job.update({ where: { id: w.job.id }, data: { minDegreePct: 70 } });

      // The conversion differs by university, so a CGPA cannot be turned into
      // a percentage to answer this. Nothing on record fails the bar.
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    /*
     * The trap this pairing closes: a lateral entrant has no 12th standard
     * result at all, so a 12th bar excluded every one of them - including on
     * roles that had explicitly said they were welcome.
     */
    it('lets a diploma stand in for a 12th', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { twelfthPct: null, diplomaPct: 74, isLateralEntry: true },
      });
      await db.job.update({
        where: { id: w.job.id },
        data: { minTwelfthPct: 60, minDiplomaPct: 60 },
      });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides it from a diploma student who misses the diploma bar', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { twelfthPct: null, diplomaPct: 55, isLateralEntry: true },
      });
      await db.job.update({
        where: { id: w.job.id },
        data: { minTwelfthPct: 60, minDiplomaPct: 60 },
      });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('leaves a 12th-standard student judged on their 12th', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { twelfthPct: 88, diplomaPct: null },
      });
      await db.job.update({
        where: { id: w.job.id },
        data: { minTwelfthPct: 60, minDiplomaPct: 90 },
      });

      // The diploma bar is high, but it is not their bar.
      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    /*
     * A master's is its own stage. An MCA drive routinely asks for the
     * bachelor's and the MCA in the same sentence, and one number could not
     * hold both.
     */
    it('judges a post-graduate on their master’s, not only their degree', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { cgpa: 7.5, pgCgpa: 8.2 },
      });
      await db.job.update({
        where: { id: w.job.id },
        data: { minCgpa: 7, minPgCgpa: 8 },
      });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides it from a post-graduate who misses the master’s bar', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { cgpa: 9, pgCgpa: 6 },
      });
      await db.job.update({ where: { id: w.job.id }, data: { minPgCgpa: 8 } });

      // A strong bachelor's does not answer a question about the master's.
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('hides a role asking for a master’s from an undergraduate', async () => {
      const w = await setupVisible();
      await db.job.update({ where: { id: w.job.id }, data: { minPgCgpa: 7 } });

      // They have no master's on record, and nothing on record fails a bar.
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('leaves an undergraduate alone when no master’s is asked for', async () => {
      const w = await setupVisible();
      await db.job.update({ where: { id: w.job.id }, data: { minCgpa: 7 } });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides a job restricted to another branch', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { specialisation: 'Civil' },
      });
      await db.jobSpecialisation.create({
        data: { jobId: w.job.id, specialisation: 'Computer Science' },
      });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('shows a job restricted to the branch the student is on', async () => {
      const w = await setupVisible();
      await db.candidate.update({
        where: { id: w.candidate.id },
        data: { specialisation: 'Computer Science' },
      });
      await db.jobSpecialisation.create({
        data: { jobId: w.job.id, specialisation: 'Computer Science' },
      });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides a branch-restricted job from a student with no branch on record', async () => {
      const w = await setupVisible();
      await db.jobSpecialisation.create({
        data: { jobId: w.job.id, specialisation: 'Computer Science' },
      });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('hides a job when the student has more gap years than allowed', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { gapYears: 2 } });
      await db.job.update({ where: { id: w.job.id }, data: { maxGapYears: 1 } });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('hides a job that excludes lateral entry from a lateral entrant', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { isLateralEntry: true } });
      await db.job.update({ where: { id: w.job.id }, data: { allowsLateralEntry: false } });

      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('leaves everyone else alone when lateral entry is excluded', async () => {
      const w = await setupVisible();
      await db.job.update({ where: { id: w.job.id }, data: { allowsLateralEntry: false } });

      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('shows a women-only role to a student recorded as female, and hides it from others', async () => {
      const w = await setupVisible();
      await db.job.update({ where: { id: w.job.id }, data: { genderEligibility: 'WOMEN' } });

      await db.candidate.update({ where: { id: w.candidate.id }, data: { gender: 'Female' } });
      expect(await visibleCount(w.candidate.id)).toBe(1);

      await db.candidate.update({ where: { id: w.candidate.id }, data: { gender: 'Male' } });
      expect(await visibleCount(w.candidate.id)).toBe(0);

      // Nothing on record fails a restriction, the same as a missing mark.
      await db.candidate.update({ where: { id: w.candidate.id }, data: { gender: null } });
      expect(await visibleCount(w.candidate.id)).toBe(0);
    });

    it('matches recorded gender regardless of letter case', async () => {
      const w = await setupVisible();
      await db.job.update({ where: { id: w.job.id }, data: { genderEligibility: 'MEN' } });
      await db.candidate.update({ where: { id: w.candidate.id }, data: { gender: 'male' } });
      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('hides nobody for a role that only prefers women', async () => {
      const w = await setupVisible();
      await db.job.update({ where: { id: w.job.id }, data: { genderEligibility: 'WOMEN_PREFERRED' } });
      await db.candidate.update({ where: { id: w.candidate.id }, data: { gender: 'Male' } });
      expect(await visibleCount(w.candidate.id)).toBe(1);
    });

    it('explains a gender restriction to the student it hides from', async () => {
      const w = await setupVisible();
      await db.candidate.update({ where: { id: w.candidate.id }, data: { gender: 'Male' } });
      const ctx = await loadCandidateContext(w.candidate.id);
      const job = await db.job.update({
        where: { id: w.job.id },
        data: { genderEligibility: 'WOMEN' },
        include: {
          courses: true,
          specialisations: true,
          gradYears: true,
          postings: { include: { placement: { select: { name: true } }, batches: true } },
        },
      });
      const reasons = explainIneligibility(ctx, job);
      expect(reasons.map((r) => r.code)).toContain('GENDER');
    });
  });

  it('6. hides everything in a drive the student is already placed in', async () => {
    const w = await setupVisible();
    const otherJob = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(otherJob.id, w.drive.id);

    expect(await visibleCount(w.candidate.id)).toBe(2);

    await makeApplication(w.candidate.id, w.job.id, w.drive.id, S.ACCEPTED);
    expect(await visibleCount(w.candidate.id)).toBe(0);
  });

  it('still shows other drives to a student placed in one of them', async () => {
    const w = await setupVisible();
    const secondBatch = await makeBatch(w.college.id);
    const internships = await makeDrive(w.college.id, secondBatch.id);
    // The student sits in both drives.
    await db.batchMembership.create({
      data: { batchId: secondBatch.id, candidateId: w.candidate.id, isFrozen: true },
    });
    const internJob = await makeJob(w.company.id, w.recruiter.id);
    await makePosting(internJob.id, internships.id);

    await makeApplication(w.candidate.id, w.job.id, w.drive.id, S.ACCEPTED);

    // The final-placement drive is closed to them; the internship drive is not.
    const ctx = await loadCandidateContext(w.candidate.id);
    expect(ctx.closedPlacementIds).toContain(w.drive.id);
    expect(ctx.closedPlacementIds).not.toContain(internships.id);
  });

  it('reports an unverified student as unable to apply', async () => {
    const w = await setupVisible({ frozen: false });
    const ctx = await loadCandidateContext(w.candidate.id);
    expect(ctx.isFrozen).toBe(false);
    // They can still see the role - verification gates applying, not looking.
    expect(await visibleCount(w.candidate.id)).toBe(1);
  });
});
