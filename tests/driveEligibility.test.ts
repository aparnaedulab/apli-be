import { describe, expect, it } from 'vitest';
import { db } from './setup.js';
import {
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makeRecruiter,
  makeStudent,
} from './factories.js';
import { eligibilityReport } from '../src/modules/campusDrives/drive.service.js';

/**
 * The report a company is shown before it agrees to visit a campus.
 *
 * The rule these tests hold: the report counts by the same criteria that will
 * decide who may apply. It used to count by a second bar stored on the drive,
 * which gated nothing - so a recruiter could be shown forty eligible students
 * and have the role refuse thirty of them, with the two numbers coming from
 * different columns and nothing obliged to reconcile them.
 */

async function scene(opts: { frozen?: number; unfrozen?: number } = {}) {
  const college = await makeCollege();
  const batch = await makeBatch(college.id, { course: 'B.Tech' });
  const placement = await makeDrive(college.id, batch.id);
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);

  const drive = await db.campusDrive.create({
    data: {
      collegeId: college.id,
      placementId: placement.id,
      companyId: company.id,
      title: 'Autumn visit',
    },
  });

  return { college, batch, placement, company, recruiter, drive };
}

const attach = (driveId: string, jobId: string) =>
  db.campusDriveJob.create({ data: { driveId, jobId } });

describe('the eligibility report a company is shown', () => {
  it('counts against the role, not against the drive', async () => {
    const s = await scene();
    // Two clear 7.0, one does not. Only verified students are ever counted.
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 9, frozen: true });
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 7.5, frozen: true });
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 6, frozen: true });

    const job = await makeJob(s.company.id, s.recruiter.id, { minCgpa: 7 });
    await attach(s.drive.id, job.id);

    const report = await eligibilityReport(s.drive.id);

    expect(report.verified).toBe(3);
    expect(report.eligible).toBe(2);
    expect(report.failing).toEqual([{ reason: 'CGPA', count: 1 }]);
  });

  it('will not count anybody when no role has been put on the day', async () => {
    const s = await scene();
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 9, frozen: true });
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 6, frozen: true });

    const report = await eligibilityReport(s.drive.id);

    /*
     * The old report had no bar either at this point and answered "both of
     * them are eligible", which was a promise about a role that did not
     * exist. There is nothing to clear, so nobody has cleared it.
     */
    expect(report.verified).toBe(2);
    expect(report.eligible).toBe(0);
    expect(report.roles).toEqual([]);
    expect(report.note).toContain('No roles are on this drive yet');
  });

  it('counts a student who clears any one role, not one who must clear them all', async () => {
    const s = await scene();
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 9, frozen: true });
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 6.5, frozen: true });

    const strict = await makeJob(s.company.id, s.recruiter.id, { minCgpa: 8 });
    const open = await makeJob(s.company.id, s.recruiter.id, { minCgpa: 6 });
    await attach(s.drive.id, strict.id);
    await attach(s.drive.id, open.id);

    const report = await eligibilityReport(s.drive.id);

    // They came for a job, not for every job.
    expect(report.eligible).toBe(2);
    expect(report.roles).toEqual(
      expect.arrayContaining([
        { jobId: strict.id, title: strict.title, eligible: 1 },
        { jobId: open.id, title: open.title, eligible: 2 },
      ]),
    );
  });

  it('leaves out students the college has not verified', async () => {
    const s = await scene();
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 9, frozen: true });
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 9, frozen: false });

    const job = await makeJob(s.company.id, s.recruiter.id, { minCgpa: 7 });
    await attach(s.drive.id, job.id);

    const report = await eligibilityReport(s.drive.id);

    expect(report.inSeason).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.eligible).toBe(1);
  });

  it('honours a role that says it has no bar at all', async () => {
    const s = await scene();
    await makeStudent(s.batch.id, { collegeId: s.college.id, cgpa: 4, frozen: true });

    // openToAll clears every bar, exactly as the job editor promises. Reading
    // the columns without honouring it would refuse a student the role admits.
    const job = await makeJob(s.company.id, s.recruiter.id, { minCgpa: 9 });
    await db.job.update({ where: { id: job.id }, data: { openToAll: true } });
    await attach(s.drive.id, job.id);

    const report = await eligibilityReport(s.drive.id);

    expect(report.eligible).toBe(1);
    expect(report.failing).toEqual([]);
  });

  it('fails a criterion the student has no number for', async () => {
    const s = await scene();
    const { candidate } = await makeStudent(s.batch.id, { collegeId: s.college.id, frozen: true });
    await db.candidate.update({ where: { id: candidate.id }, data: { cgpa: null } });

    const job = await makeJob(s.company.id, s.recruiter.id, { minCgpa: 7 });
    await attach(s.drive.id, job.id);

    const report = await eligibilityReport(s.drive.id);

    // "No CGPA on record" is not "clears 7.0" - the same rule as the matcher.
    expect(report.eligible).toBe(0);
    expect(report.failing).toEqual([{ reason: 'CGPA', count: 1 }]);
  });

  it('says so when the season has no batches to count', async () => {
    const college = await makeCollege();
    const company = await makeCompany();
    const placement = await db.placement.create({
      data: { collegeId: college.id, name: 'Empty season', year: 2026 },
    });
    const drive = await db.campusDrive.create({
      data: {
        collegeId: college.id,
        placementId: placement.id,
        companyId: company.id,
        title: 'Visit',
      },
    });

    const report = await eligibilityReport(drive.id);

    expect(report.inSeason).toBe(0);
    expect(report.note).toContain('No batches are in this season yet');
  });
});
