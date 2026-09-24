import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus, PostingStatus, Role } from '@prisma/client';
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
  makeTenant,
  systemRole,
} from './factories.js';
import { opsRouter } from '../src/modules/ops/ops.routes.js';
import { followUpState, yearsByCompany } from '../src/modules/ops/crm.js';
import { shortCode, signPass, verifyPass } from '../src/modules/ops/driveDay.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The placement-cell tools, through the real router with a planted session.
 *
 * What matters is what a demo would not show: one college never sees
 * another's board, drive or students; a pass cannot be forged or carried to
 * another drive; checking in twice is harmless; each stalled-student rule
 * fires for the reason it says; and a switched-off tool is really off.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function appFor(session: Partial<SessionData>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Partial<SessionData> }).session = { ...session };
    next();
  });
  app.use('/ops', opsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any };
  };
}

const ALL = ['ops.employerCrm', 'ops.driveDay', 'ops.atRisk'];

async function modulesOn(tenantId: string, keys = ALL) {
  for (const moduleKey of keys) await db.tenantModule.create({ data: { tenantId, moduleKey, enabled: true } });
}

async function officerAt(collegeId: string, tenantId: string) {
  const user = await db.user.create({
    data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: user.id, collegeId, roleId: (await systemRole('campus.officer')).id } });
  return appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId });
}

/** A college with a drive, a company role accepted into it, and one student. */
async function world(opts: { modules?: string[] } = {}) {
  const tenant = await makeTenant();
  await modulesOn(tenant.id, opts.modules ?? ALL);
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const drive = await makeDrive(college.id, batch.id);
  const company = await makeCompany('Demo Systems');
  const recruiter = await makeRecruiter(company.id);
  const job = await makeJob(company.id, recruiter.id);
  await makePosting(job.id, drive.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  return { tenant, college, batch, drive, company, job, user, candidate };
}

describe('follow-ups', () => {
  const now = new Date(2026, 8, 19, 15, 0, 0);
  it('are overdue before today, due today, and upcoming after', () => {
    expect(followUpState(new Date(2026, 8, 18, 23, 0), null, now)).toBe('overdue');
    expect(followUpState(new Date(2026, 8, 19, 9, 0), null, now)).toBe('today');
    expect(followUpState(new Date(2026, 8, 19, 23, 59), null, now)).toBe('today');
    expect(followUpState(new Date(2026, 8, 20, 0, 1), null, now)).toBe('upcoming');
  });
  it('stop mattering once done, or when there is none', () => {
    expect(followUpState(new Date(2026, 8, 1), new Date(), now)).toBeNull();
    expect(followUpState(null, null, now)).toBeNull();
  });
});

describe('the employer CRM', () => {
  it('keeps each college to its own board', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const created = await mine('POST', '/ops/crm/employers', { companyName: 'Demo Logistics' });
    expect(created.status).toBe(201);

    const otherCollege = await makeCollege('Other College', w.tenant.id);
    const theirs = await officerAt(otherCollege.id, w.tenant.id);
    expect((await theirs('GET', '/ops/crm')).body.employers).toHaveLength(0);
    expect((await theirs('PATCH', `/ops/crm/employers/${created.body.employer.id}`, { stage: 'HIRED' })).status).toBe(404);
    expect((await theirs('POST', `/ops/crm/employers/${created.body.employer.id}/interactions`, { kind: 'CALL', summary: 'Hello' })).status).toBe(404);
  });

  it('suggests companies that already sent roles, and links them on add', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const first = await mine('GET', '/ops/crm');
    expect(first.body.suggestions).toEqual([expect.objectContaining({ companyId: w.company.id, name: 'Demo Systems', roles: 1 })]);

    const added = await mine('POST', '/ops/crm/employers', { companyId: w.company.id, companyName: 'ignored' });
    expect(added.body.employer).toMatchObject({ companyId: w.company.id, companyName: 'Demo Systems' });
    const after = await mine('GET', '/ops/crm');
    expect(after.body.suggestions).toHaveLength(0);
    expect(after.body.employers[0].yearsHired).toEqual([2026]);
    expect((await mine('POST', '/ops/crm/employers', { companyName: 'Demo Systems' })).status).toBe(409);
  });

  it('lists follow-ups that are due, and drops them once done', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const { body } = await mine('POST', '/ops/crm/employers', { companyName: 'Demo Foods' });
    const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const logged = await mine('POST', `/ops/crm/employers/${body.employer.id}/interactions`, {
      kind: 'CALL',
      summary: 'Asked about a summer drive',
      followUpAt: yesterday,
    });
    expect(logged.status).toBe(201);
    let board = await mine('GET', '/ops/crm');
    expect(board.body.followUps).toEqual([expect.objectContaining({ companyName: 'Demo Foods', state: 'overdue' })]);

    await mine('POST', `/ops/crm/interactions/${logged.body.interaction.id}/done`);
    board = await mine('GET', '/ops/crm');
    expect(board.body.followUps).toHaveLength(0);
  });

  it('reads came-back-each-year from accepted postings only', async () => {
    const w = await world();
    const batch2 = await makeBatch(w.college.id);
    const drive2 = await db.placement.create({
      data: { collegeId: w.college.id, name: 'Drive 2027', year: 2027, batches: { connect: { id: batch2.id } } },
    });
    const recruiter = await db.companyMember.findFirstOrThrow({ where: { companyId: w.company.id } });
    const job2 = await makeJob(w.company.id, recruiter.userId);
    await makePosting(job2.id, drive2.id);
    const declined = await makeCompany('Demo Declined');
    const r2 = await makeRecruiter(declined.id);
    const job3 = await makeJob(declined.id, r2.id);
    await makePosting(job3.id, drive2.id, PostingStatus.DECLINED);

    const years = await yearsByCompany(w.college.id);
    expect(years.get(w.company.id)?.years).toEqual([2026, 2027]);
    expect(years.has(declined.id)).toBe(false);
  });
});

describe('drive passes', () => {
  it('verify only their own drive, and not when tampered with', () => {
    const token = signPass('drive-a', 'cand-1');
    expect(verifyPass(token, 'drive-a')).toBe('cand-1');
    expect(() => verifyPass(token, 'drive-b')).toThrow(/different drive/);
    expect(() => verifyPass(token.replace('cand-1', 'cand-2'), 'drive-a')).toThrow(/not valid/);
    expect(() => verifyPass(`${token.slice(0, -2)}xx`, 'drive-a')).toThrow(/not valid/);
    expect(() => verifyPass('rubbish', 'drive-a')).toThrow();
    expect(shortCode('drive-a', 'cand-1')).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(shortCode('drive-a', 'cand-1')).not.toBe(shortCode('drive-b', 'cand-1'));
  });
});

describe('drive day', () => {
  it('checks a student in by pass, code or name - once', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const token = signPass(w.drive.id, w.candidate.id);

    const first = await mine('POST', `/ops/drive-day/${w.drive.id}/check-in`, { token });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ alreadyCheckedIn: false, name: 'Test Student' });
    const again = await mine('POST', `/ops/drive-day/${w.drive.id}/check-in`, { code: shortCode(w.drive.id, w.candidate.id) });
    expect(again.body.alreadyCheckedIn).toBe(true);
    expect(await db.driveCheckIn.count({ where: { placementId: w.drive.id } })).toBe(1);

    const csv = await mine('GET', `/ops/drive-day/${w.drive.id}/attendance.csv`);
    expect(csv.body).toContain('Test Student');
    expect(csv.body.split('\n')[0]).toBe('Name,Email,Roll no,Batch,Checked in at,Method,Room');
  });

  it('refuses a pass from another drive and a student who is not in this one', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const otherBatch = await makeBatch(w.college.id);
    const otherDrive = await makeDrive(w.college.id, otherBatch.id);
    const { candidate: outsider } = await makeStudent(otherBatch.id, { collegeId: w.college.id });

    expect((await mine('POST', `/ops/drive-day/${w.drive.id}/check-in`, { token: signPass(otherDrive.id, w.candidate.id) })).status).toBe(400);
    expect((await mine('POST', `/ops/drive-day/${w.drive.id}/check-in`, { candidateId: outsider.id })).status).toBe(404);
    expect((await mine('POST', `/ops/drive-day/${w.drive.id}/check-in`, { code: 'ZZZZZZZZ' })).status).toBe(404);
  });

  it('shows the board for its own drives only, with where each applicant is', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const round = await db.round.findFirstOrThrow({ where: { jobId: w.job.id, order: 1 } });
    await db.application.create({
      data: { candidateId: w.candidate.id, jobId: w.job.id, placementId: w.drive.id, status: ApplicationStatus.IN_ROUND, currentRoundId: round.id },
    });
    const room = await mine('POST', `/ops/drive-day/${w.drive.id}/rooms`, { name: 'Room 101', jobId: w.job.id, panel: 'Panel A' });
    expect(room.status).toBe(201);

    const board = await mine('GET', `/ops/drive-day/${w.drive.id}`);
    expect(board.body.jobs[0].applicants[0]).toMatchObject({ name: 'Test Student', round: 'Round 1', status: 'IN_ROUND' });
    expect(board.body.jobs[0].rounds[0].count).toBe(1);
    expect(board.body.jobs[0].rooms[0].name).toBe('Room 101');

    const otherCollege = await makeCollege('Other College', w.tenant.id);
    const theirs = await officerAt(otherCollege.id, w.tenant.id);
    expect((await theirs('GET', `/ops/drive-day/${w.drive.id}`)).status).toBe(404);
  });

  it('gives a student a pass for each open drive they sit in', async () => {
    const w = await world();
    const student = appFor({ userId: w.user.id, role: Role.CANDIDATE, candidateId: w.candidate.id, tenantId: w.tenant.id });
    const { body } = await student('GET', '/ops/drive-pass');
    expect(body.passes).toHaveLength(1);
    expect(verifyPass(body.passes[0].token, w.drive.id)).toBe(w.candidate.id);
    expect(body.passes[0].code).toBe(shortCode(w.drive.id, w.candidate.id));
  });
});

describe('students who have stalled', () => {
  it('fires each rule for the reason it gives, and only for this college', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);

    // Unverified, never signed in, and a thin profile.
    const { candidate: fresh } = await makeStudent(w.batch.id, { collegeId: w.college.id, frozen: false });

    // Verified, eligible for two open roles, applied to none.
    const recruiter = await db.companyMember.findFirstOrThrow({ where: { companyId: w.company.id } });
    const job2 = await makeJob(w.company.id, recruiter.userId);
    await makePosting(job2.id, w.drive.id);

    // Rejected three times, no offer.
    const { candidate: unlucky } = await makeStudent(w.batch.id, { collegeId: w.college.id });
    for (let i = 0; i < 3; i++) {
      const j = await makeJob(w.company.id, recruiter.userId);
      await makePosting(j.id, w.drive.id);
      await makeApplication(unlucky.id, j.id, w.drive.id, ApplicationStatus.REJECTED);
    }

    // A student at another college who would trip every rule.
    const other = await makeCollege('Other College', w.tenant.id);
    const otherBatch = await makeBatch(other.id);
    await makeStudent(otherBatch.id, { collegeId: other.id, frozen: false });

    const { body } = await mine('GET', '/ops/at-risk');
    const byId = new Map(body.students.map((s: { candidateId: string; flags: { key: string }[] }) => [s.candidateId, s.flags.map((f) => f.key)]));
    expect(body.students).toHaveLength(3);

    expect(byId.get(fresh.id)).toEqual(expect.arrayContaining(['not_verified', 'inactive', 'profile_incomplete']));
    expect(byId.get(fresh.id)).not.toContain('not_applying');
    expect(byId.get(w.candidate.id)).toEqual(expect.arrayContaining(['not_applying', 'not_placed']));
    expect(byId.get(unlucky.id)).toEqual(expect.arrayContaining(['repeated_rejections']));

    const filtered = await mine('GET', `/ops/at-risk?batchId=${otherBatch.id}`);
    expect(filtered.body.students).toHaveLength(0);
  });

  it('does not flag somebody who is doing fine', async () => {
    const w = await world();
    await db.user.update({ where: { id: w.user.id }, data: { lastLoginAt: new Date() } });
    await db.candidate.update({
      where: { id: w.candidate.id },
      data: { phone: '+91 90000 00000', resumeUrl: 'https://example.com/cv.pdf' },
    });
    await makeApplication(w.candidate.id, w.job.id, w.drive.id, ApplicationStatus.ACCEPTED);
    const mine = await officerAt(w.college.id, w.tenant.id);
    const { body } = await mine('GET', '/ops/at-risk');
    const row = body.students.find((s: { candidateId: string }) => s.candidateId === w.candidate.id);
    expect(row?.flags.map((f: { key: string }) => f.key) ?? []).not.toEqual(
      expect.arrayContaining(['not_applying', 'not_placed', 'inactive']),
    );
  });

  it('sends a kind nudge that never says "at risk", and not twice in a row', async () => {
    const w = await world();
    const mine = await officerAt(w.college.id, w.tenant.id);
    const sent = await mine('POST', `/ops/at-risk/${w.candidate.id}/nudge`);
    expect(sent.status).toBe(201);
    const note = await db.notification.findFirstOrThrow({ where: { userId: w.user.id } });
    expect(`${note.title} ${note.body}`.toLowerCase()).not.toContain('risk');
    expect((await mine('POST', `/ops/at-risk/${w.candidate.id}/nudge`)).status).toBe(409);

    const other = await makeCollege('Other College', w.tenant.id);
    const theirs = await officerAt(other.id, w.tenant.id);
    expect((await theirs('POST', `/ops/at-risk/${w.candidate.id}/nudge`)).status).toBe(404);
  });
});

describe('switched off', () => {
  it('each tool refuses when its module is off', async () => {
    const w = await world({ modules: [] });
    const mine = await officerAt(w.college.id, w.tenant.id);
    expect((await mine('GET', '/ops/crm')).status).toBe(403);
    expect((await mine('GET', '/ops/drive-day')).status).toBe(403);
    expect((await mine('GET', '/ops/at-risk')).status).toBe(403);
    const student = appFor({ userId: w.user.id, role: Role.CANDIDATE, candidateId: w.candidate.id, tenantId: w.tenant.id });
    expect((await student('GET', '/ops/drive-pass')).status).toBe(403);
  });
});
