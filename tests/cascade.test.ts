import { describe, expect, it } from 'vitest';
import { ApplicationStatus as S } from '@prisma/client';
import { db } from './setup.js';
import { transition } from '../src/modules/applications/state.js';
import { IllegalTransition } from '../src/lib/errors.js';
import {
  makeApplication,
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makeRecruiter,
  makeStudent,
} from './factories.js';

async function world(oneOfferRule = true) {
  const college = await makeCollege();
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id, { oneOfferRule });
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);
  const { candidate, user } = await makeStudent(batch.id, { collegeId: college.id });
  return { college, batch, drive, company, recruiter, candidate, user };
}

/**
 * The one-offer rule: the behaviour most likely to be broken by a later change,
 * and the hardest to notice by hand.
 */
describe('accepting an offer', () => {
  it('closes the other live applications in the same drive', async () => {
    const w = await world();
    const jobA = await makeJob(w.company.id, w.recruiter.id);
    const jobB = await makeJob(w.company.id, w.recruiter.id);
    const jobC = await makeJob(w.company.id, w.recruiter.id);

    const offered = await makeApplication(w.candidate.id, jobA.id, w.drive.id, S.OFFERED);
    const applied = await makeApplication(w.candidate.id, jobB.id, w.drive.id, S.APPLIED);
    const inRound = await makeApplication(w.candidate.id, jobC.id, w.drive.id, S.IN_ROUND);

    const result = await transition({
      applicationId: offered.id,
      to: S.ACCEPTED,
      actorId: w.user.id,
    });

    expect(result.cascaded).toBe(2);
    expect((await db.application.findUniqueOrThrow({ where: { id: applied.id } })).status).toBe(
      S.WITHDRAWN,
    );
    expect((await db.application.findUniqueOrThrow({ where: { id: inRound.id } })).status).toBe(
      S.WITHDRAWN,
    );
  });

  it('marks each closed application with a reason a recruiter can act on', async () => {
    const w = await world();
    const jobA = await makeJob(w.company.id, w.recruiter.id);
    const jobB = await makeJob(w.company.id, w.recruiter.id);
    const offered = await makeApplication(w.candidate.id, jobA.id, w.drive.id, S.OFFERED);
    const other = await makeApplication(w.candidate.id, jobB.id, w.drive.id, S.APPLIED);

    await transition({ applicationId: offered.id, to: S.ACCEPTED, actorId: w.user.id });

    const event = await db.statusEvent.findFirstOrThrow({
      where: { applicationId: other.id, toStatus: S.WITHDRAWN },
    });
    expect(event.reason).toBe('auto_placed');
    expect(event.fromStatus).toBe(S.APPLIED);
  });

  it('leaves applications in other drives alone', async () => {
    const w = await world();
    const otherBatch = await makeBatch(w.college.id);
    const otherDrive = await makeDrive(w.college.id, otherBatch.id);

    const jobA = await makeJob(w.company.id, w.recruiter.id);
    const jobB = await makeJob(w.company.id, w.recruiter.id);
    const offered = await makeApplication(w.candidate.id, jobA.id, w.drive.id, S.OFFERED);
    const elsewhere = await makeApplication(w.candidate.id, jobB.id, otherDrive.id, S.APPLIED);

    const result = await transition({
      applicationId: offered.id,
      to: S.ACCEPTED,
      actorId: w.user.id,
    });

    expect(result.cascaded).toBe(0);
    expect((await db.application.findUniqueOrThrow({ where: { id: elsewhere.id } })).status).toBe(
      S.APPLIED,
    );
  });

  it('does nothing when the drive has the one-offer rule turned off', async () => {
    const w = await world(false);
    const jobA = await makeJob(w.company.id, w.recruiter.id);
    const jobB = await makeJob(w.company.id, w.recruiter.id);
    const offered = await makeApplication(w.candidate.id, jobA.id, w.drive.id, S.OFFERED);
    const other = await makeApplication(w.candidate.id, jobB.id, w.drive.id, S.APPLIED);

    const result = await transition({
      applicationId: offered.id,
      to: S.ACCEPTED,
      actorId: w.user.id,
    });

    expect(result.cascaded).toBe(0);
    expect((await db.application.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      S.APPLIED,
    );
  });

  it('leaves already-closed applications closed', async () => {
    const w = await world();
    const jobA = await makeJob(w.company.id, w.recruiter.id);
    const jobB = await makeJob(w.company.id, w.recruiter.id);
    const offered = await makeApplication(w.candidate.id, jobA.id, w.drive.id, S.OFFERED);
    const rejected = await makeApplication(w.candidate.id, jobB.id, w.drive.id, S.REJECTED);

    const result = await transition({
      applicationId: offered.id,
      to: S.ACCEPTED,
      actorId: w.user.id,
    });

    expect(result.cascaded).toBe(0);
    expect((await db.application.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe(
      S.REJECTED,
    );
  });

  it('does not cascade on a decline', async () => {
    const w = await world();
    const jobA = await makeJob(w.company.id, w.recruiter.id);
    const jobB = await makeJob(w.company.id, w.recruiter.id);
    const offered = await makeApplication(w.candidate.id, jobA.id, w.drive.id, S.OFFERED);
    const other = await makeApplication(w.candidate.id, jobB.id, w.drive.id, S.APPLIED);

    const result = await transition({
      applicationId: offered.id,
      to: S.DECLINED,
      actorId: w.user.id,
    });

    expect(result.cascaded).toBe(0);
    expect((await db.application.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      S.APPLIED,
    );
  });
});

describe('transition()', () => {
  it('refuses a move the table does not allow, and changes nothing', async () => {
    const w = await world();
    const job = await makeJob(w.company.id, w.recruiter.id);
    const application = await makeApplication(w.candidate.id, job.id, w.drive.id, S.APPLIED);

    await expect(
      transition({ applicationId: application.id, to: S.HIRED, actorId: w.recruiter.id }),
    ).rejects.toBeInstanceOf(IllegalTransition);

    const after = await db.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(after.status).toBe(S.APPLIED);
    expect(await db.statusEvent.count({ where: { applicationId: application.id } })).toBe(0);
  });

  it('writes exactly one audit row per move, in order', async () => {
    const w = await world();
    const job = await makeJob(w.company.id, w.recruiter.id);
    const application = await makeApplication(w.candidate.id, job.id, w.drive.id, S.APPLIED);

    await transition({ applicationId: application.id, to: S.UNDER_REVIEW, actorId: w.recruiter.id });
    await transition({ applicationId: application.id, to: S.IN_ROUND, actorId: w.recruiter.id });
    await transition({ applicationId: application.id, to: S.OFFERED, actorId: w.recruiter.id });

    const events = await db.statusEvent.findMany({
      where: { applicationId: application.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual([
      'APPLIED>UNDER_REVIEW',
      'UNDER_REVIEW>IN_ROUND',
      'IN_ROUND>OFFERED',
    ]);
  });

  it('notifies the student on a move that concerns them', async () => {
    const w = await world();
    const job = await makeJob(w.company.id, w.recruiter.id);
    const application = await makeApplication(w.candidate.id, job.id, w.drive.id, S.APPLIED);

    await transition({ applicationId: application.id, to: S.UNDER_REVIEW, actorId: w.recruiter.id });

    const notifications = await db.notification.findMany({ where: { userId: w.user.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('application.under_review');
  });
});
