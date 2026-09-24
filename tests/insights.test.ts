import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { PostingStatus, Role } from '@prisma/client';
import { db } from './setup.js';
import {
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
import { insightsRouter } from '../src/modules/insights/insights.routes.js';
import { gapScore } from '../src/modules/insights/heatmap.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The skill-demand heatmap and the WhatsApp message log.
 *
 * The heatmap feeds curriculum decisions, so its arithmetic is pinned on a
 * small world where every number can be worked out by hand - and so is the
 * fence: nothing from another college, or another institution, gets in.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/insights', insightsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  };
}

async function officerOf(collegeId: string, tenantId: string) {
  const user = await db.user.create({
    data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({ data: { userId: user.id, collegeId, roleId: (await systemRole('campus.officer')).id } });
  return appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId });
}

async function adminOf(tenantId: string) {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@demo-university.example`, fullName: 'Demo Admin', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({ data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId } });
  return appFor({ userId: user.id, role: Role.ADMIN, tenantId });
}

async function on(tenantId: string, moduleKey: string) {
  await db.tenantModule.create({ data: { tenantId, moduleKey, enabled: true } });
}

async function skill(name: string) {
  return db.skill.create({ data: { name } });
}

async function asks(jobId: string, skillId: string, isRequired: boolean) {
  await db.jobSkill.create({ data: { jobId, skillId, isRequired } });
}

async function knows(candidateId: string, ...skillIds: string[]) {
  for (const skillId of skillIds) await db.candidateSkill.create({ data: { candidateId, skillId } });
}

/**
 * University T with colleges A and B, and a stranger institution with C.
 *
 * College A, 2026: three students (two Computer, one Mechanical).
 *   J1 asks Java (required) and SQL (nice), 10 openings.
 *   J2 asks Python and Java, both required.
 *   J3 asks SQL but A declined it - it must not count.
 * College A, 2025: J0 asked Java.
 * College B, 2026: one student, J4 asks Java.
 * College C (other tenant): J5 asks Python. Never seen by T.
 */
async function world() {
  const t = await makeTenant('Demo University');
  const other = await makeTenant('Stranger University');
  const a = await makeCollege('College A', t.id);
  const b = await makeCollege('College B', t.id);
  const c = await makeCollege('College C', other.id);

  const [java, sql, python] = await Promise.all([skill('Java'), skill('SQL'), skill('Python')]);
  const company = await makeCompany();
  const recruiter = await makeRecruiter(company.id);

  const batchA = await makeBatch(a.id);
  const driveA = await makeDrive(a.id, batchA.id);
  const s1 = await makeStudent(batchA.id, { collegeId: a.id, specialisation: 'Computer' });
  const s2 = await makeStudent(batchA.id, { collegeId: a.id, specialisation: 'Computer' });
  const s3 = await makeStudent(batchA.id, { collegeId: a.id, specialisation: 'Mechanical' });
  await knows(s1.candidate.id, java.id, sql.id);
  await knows(s2.candidate.id, java.id);

  const j1 = await makeJob(company.id, recruiter.id);
  await db.job.update({ where: { id: j1.id }, data: { openings: 10 } });
  await asks(j1.id, java.id, true);
  await asks(j1.id, sql.id, false);
  await makePosting(j1.id, driveA.id);

  const j2 = await makeJob(company.id, recruiter.id);
  await asks(j2.id, python.id, true);
  await asks(j2.id, java.id, true);
  await makePosting(j2.id, driveA.id, PostingStatus.PENDING);

  const j3 = await makeJob(company.id, recruiter.id);
  await asks(j3.id, sql.id, true);
  await makePosting(j3.id, driveA.id, PostingStatus.DECLINED);

  const lastYear = await db.placement.create({ data: { collegeId: a.id, name: 'Drive 2025', year: 2025 } });
  const j0 = await makeJob(company.id, recruiter.id);
  await asks(j0.id, java.id, true);
  await makePosting(j0.id, lastYear.id);

  const batchB = await makeBatch(b.id);
  const driveB = await makeDrive(b.id, batchB.id);
  const s4 = await makeStudent(batchB.id, { collegeId: b.id, specialisation: 'Computer' });
  await knows(s4.candidate.id, python.id);
  const j4 = await makeJob(company.id, recruiter.id);
  await asks(j4.id, java.id, true);
  await makePosting(j4.id, driveB.id);

  const batchC = await makeBatch(c.id);
  const driveC = await makeDrive(c.id, batchC.id);
  await makeStudent(batchC.id, { collegeId: c.id });
  const j5 = await makeJob(company.id, recruiter.id);
  await asks(j5.id, python.id, true);
  await makePosting(j5.id, driveC.id);

  return { t, other, a, b, c, s1, s3, s4 };
}

describe('the gap score', () => {
  it('is high when many roles ask and few students have it, zero when nobody asks', () => {
    expect(gapScore(100, 0)).toBe(100);
    expect(gapScore(100, 100)).toBe(0);
    expect(gapScore(50, 0)).toBe(50);
    expect(gapScore(0, 0)).toBe(0);
    expect(gapScore(100, 66.7)).toBe(33);
  });
});

describe('the skill-demand heatmap', () => {
  it('counts demand and coverage for one college, gaps first', async () => {
    const w = await world();
    await on(w.t.id, 'ops.skillHeatmap');
    const call = await officerOf(w.a.id, w.t.id);

    const { status, body } = await call('/insights/skills/college?year=2026');
    expect(status).toBe(200);
    expect(body.year).toBe(2026);
    expect(body.years).toEqual([2026, 2025]);
    expect(body.rolesAnalysed).toBe(2); // J3 was declined
    expect(body.pool).toBe(3);
    expect(body.poolBasis).toBe('drive batches');

    const bySkill = Object.fromEntries(body.skills.map((s: { skill: string }) => [s.skill, s]));
    expect(bySkill.Java).toMatchObject({ roles: 2, required: 2, niceToHave: 0, openings: 11, demandPct: 100, students: 2, coveragePct: 66.7, gap: 33 });
    expect(bySkill.SQL).toMatchObject({ roles: 1, required: 0, niceToHave: 1, demandPct: 50, students: 1, coveragePct: 33.3, gap: 33 });
    expect(bySkill.Python).toMatchObject({ roles: 1, demandPct: 50, students: 0, coveragePct: 0, gap: 50 });

    // Biggest gap first; a tie goes to the skill more roles asked for.
    expect(body.skills.map((s: { skill: string }) => s.skill)).toEqual(['Python', 'Java', 'SQL']);
  });

  it('draws the grid by branch and names what is rising', async () => {
    const w = await world();
    await on(w.t.id, 'ops.skillHeatmap');
    const { body } = await (await officerOf(w.a.id, w.t.id))('/insights/skills/college?year=2026');

    const branches = body.grid.branches.map((b: { branch: string; students: number }) => [b.branch, b.students]);
    expect(branches).toEqual([
      ['Computer', 2],
      ['Mechanical', 1],
    ]);
    const java = body.grid.rows.find((r: { skill: string }) => r.skill === 'Java');
    expect(java.cells).toEqual([100, 0]);

    // 2025 had one Java role; 2026 has two, plus new Python and SQL.
    expect(body.rising).toEqual([
      { skill: 'Java', now: 2, before: 1, change: 1 },
      { skill: 'Python', now: 1, before: 0, change: 1 },
      { skill: 'SQL', now: 1, before: 0, change: 1 },
    ]);
  });

  it('never lets another college - or institution - in', async () => {
    const w = await world();
    await on(w.t.id, 'ops.skillHeatmap');
    const { body } = await (await officerOf(w.b.id, w.t.id))('/insights/skills/college?year=2026');
    expect(body.rolesAnalysed).toBe(1);
    expect(body.pool).toBe(1);
    expect(body.skills.map((s: { skill: string }) => s.skill)).toEqual(['Java']);
    expect(JSON.stringify(body)).not.toContain(w.s1.candidate.id);
  });

  it('adds up an institution, college by college', async () => {
    const w = await world();
    await on(w.t.id, 'ops.skillHeatmap');
    const { status, body } = await (await adminOf(w.t.id))('/insights/skills/tenant?year=2026');
    expect(status).toBe(200);
    expect(body.rolesAnalysed).toBe(3); // J1, J2, J4 - never C's J5
    expect(body.pool).toBe(4);
    expect(body.perCollege).toEqual([
      { collegeId: w.a.id, name: 'College A', students: 3, roles: 2 },
      { collegeId: w.b.id, name: 'College B', students: 1, roles: 1 },
    ]);
    const python = body.skills.find((s: { skill: string }) => s.skill === 'Python');
    expect(python).toMatchObject({ roles: 1, students: 1, coveragePct: 25 });
  });

  it('is refused where the institution has it switched off', async () => {
    const w = await world();
    expect((await (await officerOf(w.a.id, w.t.id))('/insights/skills/college')).status).toBe(403);
    expect((await (await adminOf(w.t.id))('/insights/skills/tenant')).status).toBe(403);
  });

  it('says so plainly when there are no drives yet', async () => {
    const t = await makeTenant('Empty University');
    const college = await makeCollege('Empty College', t.id);
    await on(t.id, 'ops.skillHeatmap');
    const { body } = await (await officerOf(college.id, t.id))('/insights/skills/college');
    expect(body).toMatchObject({ year: null, rolesAnalysed: 0, pool: 0, skills: [] });
  });
});

describe('the WhatsApp message log', () => {
  it('shows a college its own students only, masked, with counts', async () => {
    const w = await world();
    await on(w.t.id, 'channel.whatsapp');
    const stranger = await db.candidate.findFirstOrThrow({ where: { collegeId: w.c.id } });
    await db.whatsAppMessage.createMany({
      data: [
        { candidateId: w.s1.candidate.id, tenantId: w.t.id, template: 'apli_offer_update', toMasked: '••••••0001', status: 'SENT' },
        { candidateId: w.s3.candidate.id, tenantId: w.t.id, template: 'apli_application_update', toMasked: '—', status: 'SKIPPED', error: 'No mobile number on the student’s record.' },
        { candidateId: w.s4.candidate.id, tenantId: w.t.id, template: 'apli_offer_update', toMasked: '••••••0004', status: 'SENT' },
        { candidateId: stranger.id, tenantId: w.other.id, template: 'apli_offer_update', toMasked: '••••••0009', status: 'FAILED' },
      ],
    });

    const { status, body } = await (await officerOf(w.a.id, w.t.id))('/insights/whatsapp/college');
    expect(status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.counts).toMatchObject({ SENT: 1, SKIPPED: 1, FAILED: 0 });
    expect(body.messages).toHaveLength(2);
    expect(body.messages.every((m: { toMasked: string }) => !/\d{5,}/.test(m.toMasked))).toBe(true);
    expect(body.types).toContain('application.offered');
  });

  it('is refused without the module', async () => {
    const w = await world();
    expect((await (await officerOf(w.a.id, w.t.id))('/insights/whatsapp/college')).status).toBe(403);
  });
});
