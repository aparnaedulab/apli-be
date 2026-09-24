import { describe, expect, it } from 'vitest';
import { ApplicationStatus } from '@prisma/client';
import { db } from './setup.js';
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
 * What a company may ask for before an application counts.
 *
 * Two things, and both are recorded rather than merely checked: months later,
 * when somebody turns down an offer over a relocation they say nobody
 * mentioned, there has to be a row saying when they agreed to it.
 */

async function world() {
  const college = await makeCollege();
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const candidate = await makeStudent(batch.id, { collegeId: college.id, frozen: true });
  const job = await makeJob(company.id, recruiter.id);
  await makePosting(job.id, drive.id);
  return { college, batch, drive, company, recruiter, candidate, job };
}

describe('the conditions of a role', () => {
  it('keeps the order they were written in', async () => {
    const w = await world();

    await db.jobTerm.createMany({
      data: [
        { jobId: w.job.id, order: 1, text: 'Posted anywhere in India.' },
        { jobId: w.job.id, order: 2, text: 'Two-year service agreement.' },
        { jobId: w.job.id, order: 3, text: 'Rotational night shifts.' },
      ],
    });

    const terms = await db.jobTerm.findMany({
      where: { jobId: w.job.id },
      orderBy: { order: 'asc' },
    });

    expect(terms.map((t) => t.text)).toEqual([
      'Posted anywhere in India.',
      'Two-year service agreement.',
      'Rotational night shifts.',
    ]);
  });

  it('cannot hold two conditions at the same position', async () => {
    const w = await world();
    await db.jobTerm.create({ data: { jobId: w.job.id, order: 1, text: 'First.' } });

    // The order is what the student reads them in, so it has to be a real
    // order rather than whatever the database happens to return.
    await expect(
      db.jobTerm.create({ data: { jobId: w.job.id, order: 1, text: 'Also first.' } }),
    ).rejects.toThrow();
  });

  it('goes with the role when the role is deleted', async () => {
    const w = await world();
    await db.jobTerm.create({ data: { jobId: w.job.id, order: 1, text: 'Relocation.' } });

    await db.application.deleteMany({ where: { jobId: w.job.id } });
    await db.job.delete({ where: { id: w.job.id } });

    expect(await db.jobTerm.count({ where: { jobId: w.job.id } })).toBe(0);
  });
});

describe('what an application records', () => {
  it('keeps when the student accepted the conditions', async () => {
    const w = await world();
    await db.jobTerm.create({ data: { jobId: w.job.id, order: 1, text: 'Relocation.' } });

    const application = await makeApplication(w.candidate.candidate.id, w.job.id, w.drive.id);
    const accepted = new Date();
    await db.application.update({
      where: { id: application.id },
      data: { acceptedTermsAt: accepted, screeningRef: 'HR-88213' },
    });

    const saved = await db.application.findUniqueOrThrow({ where: { id: application.id } });

    expect(saved.acceptedTermsAt).not.toBeNull();
    expect(saved.screeningRef).toBe('HR-88213');
    expect(saved.status).toBe(ApplicationStatus.APPLIED);
  });

  it('leaves both empty for a role that asked for neither', async () => {
    const w = await world();
    const application = await makeApplication(w.candidate.candidate.id, w.job.id, w.drive.id);

    const saved = await db.application.findUniqueOrThrow({ where: { id: application.id } });

    // Null means "this role asked for nothing", not "they refused" - the two
    // are told apart by whether the role has any terms at all.
    expect(saved.acceptedTermsAt).toBeNull();
    expect(saved.screeningRef).toBeNull();
  });
});

describe('the test before applying', () => {
  it('is off unless a company turns it on', async () => {
    const w = await world();
    const job = await db.job.findUniqueOrThrow({ where: { id: w.job.id } });

    expect(job.screeningTestRequired).toBe(false);
    expect(job.screeningTestUrl).toBeNull();
  });

  it('holds everything a student needs to go and take it', async () => {
    const w = await world();
    const closes = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    await db.job.update({
      where: { id: w.job.id },
      data: {
        screeningTestName: 'Zenith aptitude test',
        screeningTestUrl: 'https://tests.example/zenith',
        screeningTestInstructions: '60 minutes, one attempt.',
        screeningTestDeadline: closes,
        screeningTestRequired: true,
      },
    });

    const job = await db.job.findUniqueOrThrow({ where: { id: w.job.id } });

    expect(job.screeningTestName).toBe('Zenith aptitude test');
    expect(job.screeningTestUrl).toBe('https://tests.example/zenith');
    expect(job.screeningTestRequired).toBe(true);
    expect(job.screeningTestDeadline?.getTime()).toBe(closes.getTime());
  });
});
