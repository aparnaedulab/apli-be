import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { ApplicationStatus, PlacementType, PostingStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import {
  makeApplication,
  makeBatch,
  makeCollege,
  makeCompany,
  makeDrive,
  makeJob,
  makeRecruiter,
  makeStudent,
  makeTenant,
  systemRole,
} from './factories.js';
import { networkRouter } from '../src/modules/network/network.routes.js';
import { isAlumnus } from '../src/modules/network/network.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Alumni connect and pooled drives. What matters here is invisible in a demo:
 * that a student only ever reaches their own college's seniors, that
 * "anonymous" hides the asker, that referral requests are rationed, and that a
 * pool never crosses institutions nor lets a company skip a college's own
 * approval.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/network', networkRouter);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function tenantWith(...modules: string[]) {
  const tenant = await makeTenant();
  for (const m of modules) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: m, enabled: true } });
  }
  return tenant;
}

async function student(tenantId: string, collegeId: string, graduationYear?: number) {
  const batch = await makeBatch(collegeId);
  const { user, candidate } = await makeStudent(batch.id, { collegeId });
  if (graduationYear) await db.candidate.update({ where: { id: candidate.id }, data: { graduationYear } });
  const call = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId });
  return { user, candidate, batch, call };
}

async function officer(tenantId: string, collegeId: string, roleKey = 'campus.officer') {
  const user = await db.user.create({
    data: { email: `po-${Math.random()}@test.local`, fullName: 'Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: user.id, collegeId, roleId: (await systemRole(roleKey)).id } });
  return { user, call: appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId }) };
}

async function recruiter(verified = true) {
  const company = await makeCompany(undefined, verified);
  const user = await makeRecruiter(company.id);
  return { company, user, call: appFor({ userId: user.id, role: Role.COMPANY, companyId: company.id }) };
}

const lastYear = new Date().getFullYear() - 1;
const nextYear = new Date().getFullYear() + 1;

/* ========================================================================== */

describe('who counts as an alumnus', () => {
  it('is a graduate, or someone who has accepted an offer - nobody else', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('Alumni College', tenant.id);
    const graduate = await student(tenant.id, college.id, lastYear);
    const current = await student(tenant.id, college.id, nextYear);
    const placed = await student(tenant.id, college.id, nextYear);

    const { company, user } = await recruiter();
    const job = await makeJob(company.id, user.id);
    const drive = await makeDrive(college.id, placed.batch.id);
    await makeApplication(placed.candidate.id, job.id, drive.id, ApplicationStatus.ACCEPTED);

    expect(await isAlumnus(graduate.candidate.id)).toBe(true);
    expect(await isAlumnus(current.candidate.id)).toBe(false);
    expect(await isAlumnus(placed.candidate.id)).toBe(true);
  });

  it('only lets alumni opt in as mentors', async () => {
    const tenant = await tenantWith('community.alumni');
    const college = await makeCollege('Mentor College', tenant.id);
    const junior = await student(tenant.id, college.id, nextYear);
    const senior = await student(tenant.id, college.id, lastYear);
    const profile = { available: true, currentCompany: 'Demo Systems', currentRole: 'Analyst', canRefer: true, topics: ['Interviews'] };

    expect((await junior.call('PUT', '/network/alumni/me', profile)).status).toBe(403);
    expect((await senior.call('PUT', '/network/alumni/me', profile)).status).toBe(200);
  });
});

describe('asking seniors', () => {
  it('stays inside the college, and anonymous really hides the asker', async () => {
    const tenant = await tenantWith('community.alumni');
    const a = await makeCollege('College A', tenant.id);
    const b = await makeCollege('College B', tenant.id);
    const asker = await student(tenant.id, a.id, nextYear);
    const classmate = await student(tenant.id, a.id, nextYear);
    const senior = await student(tenant.id, a.id, lastYear);
    const elsewhere = await student(tenant.id, b.id, nextYear);

    const asked = await asker.call('POST', '/network/alumni/questions', {
      body: 'How hard is the aptitude round at Demo Systems?',
      companyName: 'Demo Systems',
      anonymous: true,
    });
    expect(asked.status).toBe(201);

    const seen = await classmate.call('GET', '/network/alumni/questions');
    expect(seen.body.questions).toHaveLength(1);
    expect(seen.body.questions[0].askedBy).toBeNull();
    expect((await asker.call('GET', '/network/alumni/questions')).body.questions[0].askedBy).toBe('Test Student');
    expect((await elsewhere.call('GET', '/network/alumni/questions')).body.questions).toHaveLength(0);

    // A classmate who is not yet an alumnus cannot answer; a senior can.
    const id = asked.body.question.id;
    expect((await classmate.call('POST', `/network/alumni/questions/${id}/answers`, { body: 'I think it was easy enough.' })).status).toBe(403);
    expect((await senior.call('POST', `/network/alumni/questions/${id}/answers`, { body: 'Moderate - revise percentages and puzzles.' })).status).toBe(201);
    expect((await elsewhere.call('POST', `/network/alumni/questions/${id}/answers`, { body: 'Answering from elsewhere.' })).status).toBe(404);

    // The asker was told.
    expect(await db.notification.count({ where: { userId: asker.user.id, type: 'ALUMNI_ANSWER' } })).toBe(1);

    // The college sees the real name, and can hide it.
    const po = await officer(tenant.id, a.id);
    const college = await po.call('GET', '/network/college/questions');
    expect(college.body.questions[0].askedBy).toBe('Test Student');
    expect((await po.call('POST', `/network/college/questions/${id}/visibility`, { hidden: true })).status).toBe(200);
    expect((await classmate.call('GET', '/network/alumni/questions')).body.questions).toHaveLength(0);

    // A Verifier may read but not moderate.
    const verifier = await officer(tenant.id, a.id, 'campus.verifier');
    expect((await verifier.call('POST', `/network/college/questions/${id}/visibility`, { hidden: false })).status).toBe(403);
  });
});

describe('referral requests', () => {
  it('go only to opted-in seniors who can refer, and are rationed', async () => {
    const tenant = await tenantWith('community.alumni');
    const college = await makeCollege('Referral College', tenant.id);
    const other = await makeCollege('Other College', tenant.id);
    const junior = await student(tenant.id, college.id, nextYear);

    const referrers = [];
    for (let i = 0; i < 4; i++) {
      const s = await student(tenant.id, college.id, lastYear);
      await s.call('PUT', '/network/alumni/me', { available: true, canRefer: true, topics: [] });
      referrers.push(s);
    }
    const noRefer = await student(tenant.id, college.id, lastYear);
    await noRefer.call('PUT', '/network/alumni/me', { available: true, canRefer: false, topics: [] });
    const outsider = await student(tenant.id, other.id, lastYear);
    await outsider.call('PUT', '/network/alumni/me', { available: true, canRefer: true, topics: [] });

    const ask = (to: string) =>
      junior.call('POST', '/network/alumni/referrals', {
        toCandidateId: to,
        company: 'Demo Systems',
        role: 'Graduate Engineer',
        message: 'I am a final-year student and would value a referral for this role.',
      });

    // The directory holds opted-in seniors of this college only - and never contact details.
    const mentors = await junior.call('GET', '/network/alumni/mentors');
    expect(mentors.body.mentors).toHaveLength(5);
    expect(JSON.stringify(mentors.body)).not.toMatch(/@|email|phone/i);

    expect((await ask(noRefer.candidate.id)).status).toBe(409);
    expect((await ask(outsider.candidate.id)).status).toBe(404);

    for (let i = 0; i < 3; i++) expect((await ask(referrers[i]!.candidate.id)).status).toBe(201);
    expect((await ask(referrers[3]!.candidate.id)).status).toBe(429);

    // The senior was told, answers, and the junior hears back.
    expect(await db.notification.count({ where: { userId: referrers[0]!.user.id, type: 'REFERRAL_REQUEST' } })).toBe(1);
    const received = await referrers[0]!.call('GET', '/network/alumni/referrals');
    const rid = received.body.received[0].id;
    expect((await referrers[0]!.call('POST', `/network/alumni/referrals/${rid}/respond`, { status: 'ACCEPTED' })).status).toBe(200);
    expect(await db.notification.count({ where: { userId: junior.user.id, type: 'REFERRAL_ANSWER' } })).toBe(1);

    // With one answered, there is room for another.
    expect((await ask(referrers[3]!.candidate.id)).status).toBe(201);
  });

  it('is off where the institution has not switched alumni on', async () => {
    const tenant = await tenantWith();
    const college = await makeCollege('No Alumni', tenant.id);
    const s = await student(tenant.id, college.id, nextYear);
    expect((await s.call('GET', '/network/alumni/questions')).status).toBe(403);
  });
});

/* ========================================================================== */

async function driveFor(collegeId: string, type: PlacementType = PlacementType.FINAL) {
  const batch = await makeBatch(collegeId);
  const drive = await makeDrive(collegeId, batch.id);
  if (type !== PlacementType.FINAL) await db.placement.update({ where: { id: drive.id }, data: { type } });
  return { batch, drive };
}

describe('pooled drives', () => {
  it('invite only colleges of the same institution, and join through an own drive of the same kind', async () => {
    const tenant = await tenantWith('ops.pooledDrives');
    const elsewhereTenant = await tenantWith('ops.pooledDrives');
    const host = await makeCollege('Host College', tenant.id);
    const small = await makeCollege('Small College', tenant.id);
    const foreign = await makeCollege('Foreign College', elsewhereTenant.id);

    const hostDrive = await driveFor(host.id);
    const smallFinal = await driveFor(small.id);
    const smallIntern = await driveFor(small.id, PlacementType.INTERNSHIP);
    const hostDriveOfOther = await driveFor(foreign.id);

    const hostPo = await officer(tenant.id, host.id);
    const smallPo = await officer(tenant.id, small.id);

    // The host must bring its own drive.
    expect(
      (await hostPo.call('POST', '/network/pools', { name: 'Pune Joint Drive', year: 2026, type: 'FINAL', placementId: hostDriveOfOther.drive.id })).status,
    ).toBe(404);
    const created = await hostPo.call('POST', '/network/pools', {
      name: 'Pune Joint Drive',
      year: 2026,
      type: 'FINAL',
      placementId: hostDrive.drive.id,
    });
    expect(created.status).toBe(201);
    const poolId = created.body.pool.id;

    expect((await hostPo.call('POST', `/network/pools/${poolId}/invites`, { collegeIds: [foreign.id] })).status).toBe(404);
    const invited = await hostPo.call('POST', `/network/pools/${poolId}/invites`, { collegeIds: [small.id] });
    expect(invited.body.invited).toBe(1);
    expect(await db.notification.count({ where: { userId: smallPo.user.id, type: 'POOL_INVITE' } })).toBe(1);

    // Wrong kind of drive, or somebody else's drive, is refused.
    expect((await smallPo.call('POST', `/network/pools/${poolId}/join`, { placementId: smallIntern.drive.id })).status).toBe(409);
    expect((await smallPo.call('POST', `/network/pools/${poolId}/join`, { placementId: hostDrive.drive.id })).status).toBe(404);
    const joined = await smallPo.call('POST', `/network/pools/${poolId}/join`, { placementId: smallFinal.drive.id });
    expect(joined.status).toBe(200);
    expect(joined.body.pool.joined).toBe(2);

    // A college not invited cannot join.
    const foreignPo = await officer(elsewhereTenant.id, foreign.id);
    expect((await foreignPo.call('POST', `/network/pools/${poolId}/join`, { placementId: hostDriveOfOther.drive.id })).status).toBe(404);
  });

  it('turn a role into a pending request at each joined college, once, and never at the rest', async () => {
    const tenant = await tenantWith('ops.pooledDrives');
    const host = await makeCollege('Host', tenant.id);
    const joiner = await makeCollege('Joiner', tenant.id);
    const decliner = await makeCollege('Decliner', tenant.id);
    const waiting = await makeCollege('Waiting', tenant.id);

    const hostDrive = await driveFor(host.id);
    const joinerDrive = await driveFor(joiner.id);
    await driveFor(decliner.id);
    await driveFor(waiting.id);
    await makeStudent(joinerDrive.batch.id, { collegeId: joiner.id });

    const hostPo = await officer(tenant.id, host.id);
    const pool = (await hostPo.call('POST', '/network/pools', { name: 'Joint', year: 2026, type: 'FINAL', placementId: hostDrive.drive.id })).body.pool;
    await hostPo.call('POST', `/network/pools/${pool.id}/invites`, { collegeIds: [joiner.id, decliner.id, waiting.id] });
    await (await officer(tenant.id, joiner.id)).call('POST', `/network/pools/${pool.id}/join`, { placementId: joinerDrive.drive.id });
    await (await officer(tenant.id, decliner.id)).call('POST', `/network/pools/${pool.id}/decline`);

    const rec = await recruiter();
    const job = await makeJob(rec.company.id, rec.user.id);

    const seen = await rec.call('GET', '/network/company/pools');
    expect(seen.status).toBe(200);
    expect(seen.body.pools).toHaveLength(1);
    expect(seen.body.pools[0].members).toHaveLength(2); // joined only
    expect(seen.body.pools[0].students).toBe(1);

    const sent = await rec.call('POST', `/network/company/pools/${pool.id}/send`, { jobId: job.id });
    expect(sent.status).toBe(200);
    expect(sent.body.created).toBe(2);

    const postings = await db.jobPosting.findMany({ where: { jobId: job.id } });
    expect(postings.map((p) => p.status)).toEqual([PostingStatus.PENDING, PostingStatus.PENDING]);
    expect(new Set(postings.map((p) => p.placementId))).toEqual(new Set([hostDrive.drive.id, joinerDrive.drive.id]));

    // Again: nothing new.
    const again = await rec.call('POST', `/network/company/pools/${pool.id}/send`, { jobId: job.id });
    expect(again.body.created).toBe(0);
    expect(again.body.alreadyThere).toBe(2);
    expect(await db.jobPosting.count({ where: { jobId: job.id } })).toBe(2);

    // Another company's role cannot be sent.
    const other = await recruiter();
    expect((await other.call('POST', `/network/company/pools/${pool.id}/send`, { jobId: job.id })).status).toBe(404);
  });

  it('are closed to unverified companies, and to colleges where the module is off', async () => {
    const pending = await recruiter(false);
    expect((await pending.call('GET', '/network/company/pools')).status).toBe(403);

    const tenant = await tenantWith();
    const college = await makeCollege('No Pools', tenant.id);
    const po = await officer(tenant.id, college.id);
    expect((await po.call('GET', '/network/pools')).status).toBe(403);
  });

  it('are invisible to companies once the institution switches pooling off', async () => {
    const tenant = await tenantWith('ops.pooledDrives');
    const host = await makeCollege('Host', tenant.id);
    const hostDrive = await driveFor(host.id);
    const hostPo = await officer(tenant.id, host.id);
    const pool = (await hostPo.call('POST', '/network/pools', { name: 'Joint', year: 2026, type: 'FINAL', placementId: hostDrive.drive.id })).body.pool;

    await db.tenantModule.update({
      where: { tenantId_moduleKey: { tenantId: tenant.id, moduleKey: 'ops.pooledDrives' } },
      data: { enabled: false },
    });
    const rec = await recruiter();
    const job = await makeJob(rec.company.id, rec.user.id);
    expect((await rec.call('GET', '/network/company/pools')).body.pools).toHaveLength(0);
    expect((await rec.call('POST', `/network/company/pools/${pool.id}/send`, { jobId: job.id })).status).toBe(404);
  });
});
