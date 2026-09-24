import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent, makeTenant, systemRole } from './factories.js';
import { internshipRouter } from '../src/modules/internships/internship.routes.js';
import { suggestCredits, weekStartOf } from '../src/modules/internships/internship.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * NEP internships, through the real router.
 *
 * What matters is what a demo would not show: a week cannot be logged twice,
 * the mentor's link is stored only as a hash and works once, and a college
 * never sees - let alone decides on - another college's internship.
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
  app.use('/internships', internshipRouter);
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

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A tenant with (or without) the internships module, one college in it, and a student. */
async function world(withModule = true) {
  const tenant = await makeTenant();
  if (withModule) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'compliance.internships', enabled: true } });
  }
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  const student = appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id });
  return { tenant, college, candidate, student };
}

async function officerFor(collegeId: string, tenantId: string) {
  const user = await db.user.create({
    data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
  });
  await db.campusMember.create({
    data: { userId: user.id, collegeId, roleId: (await systemRole('campus.officer')).id },
  });
  return appFor({ userId: user.id, role: Role.CAMPUS, collegeId, tenantId });
}

const proposal = (start: Date, end: Date) => ({
  organisation: 'Demo Labs',
  role: 'Data analyst intern',
  mode: 'On site',
  startDate: iso(start),
  endDate: iso(end),
  hoursPerWeek: 10,
  mentorName: 'Demo Mentor',
  mentorEmail: 'mentor@demo-company.example',
});

describe('the credit and week maths', () => {
  it('suggests credits at 30 hours each, to the nearest half', () => {
    const start = new Date('2026-06-01T00:00:00Z');
    // 8 weeks x 10 h = 80 h → 2.67 → 2.5
    expect(suggestCredits(10, start, new Date('2026-07-26T00:00:00Z'))).toBe(2.5);
    // 4 weeks x 40 h = 160 h → 5.33 → 5.5
    expect(suggestCredits(40, start, new Date('2026-06-28T00:00:00Z'))).toBe(5.5);
    // Never less than half a credit, and nothing without hours.
    expect(suggestCredits(1, start, start)).toBe(0.5);
    expect(suggestCredits(null, start, start)).toBeNull();
  });

  it('keys a week on its Monday', () => {
    expect(iso(weekStartOf(new Date('2026-09-17T15:00:00Z')))).toBe('2026-09-14'); // Thursday
    expect(iso(weekStartOf(new Date('2026-09-20T23:00:00Z')))).toBe('2026-09-14'); // Sunday
    expect(iso(weekStartOf(new Date('2026-09-21T00:00:00Z')))).toBe('2026-09-21'); // Monday
  });
});

describe('an internship, start to finish', () => {
  it('goes proposed → approved → logged → evaluated → completed → credited', async () => {
    const w = await world();
    const officer = await officerFor(w.college.id, w.tenant.id);
    const start = new Date(Date.now() - 21 * DAY);
    const end = new Date(Date.now() - 2 * DAY);

    const proposed = await w.student('POST', '/internships/mine', proposal(start, end));
    expect(proposed.status).toBe(201);
    const id = proposed.body.internship as string;

    // Nothing can be logged before the college says yes.
    const early = await w.student('POST', `/internships/mine/${id}/logs`, {
      weekOf: iso(start),
      hours: 10,
      summary: 'Cleaned the sales dataset and built a first dashboard.',
    });
    expect(early.status).toBe(409);

    const queue = await officer('GET', '/internships/college?queue=to_approve');
    expect(queue.body.internships.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(queue.body.summary.to_approve).toBe(1);

    const approved = await officer('POST', `/internships/college/${id}/decision`, { approve: true });
    expect(approved.status).toBe(200);
    // Started in the past, so it is under way straight away; credits default to the suggestion.
    expect(approved.body.internship.status).toBe('ONGOING');
    expect(approved.body.internship.credits).toBe(approved.body.internship.suggestedCredits);
    const link: string = approved.body.mentor.link;
    const token = link.split('/').pop()!;

    // Only the hash is kept.
    const row = await db.internship.findUniqueOrThrow({ where: { id } });
    expect(row.mentorTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row.mentorTokenHash).not.toContain(token);

    const log = { weekOf: iso(start), hours: 10, summary: 'Cleaned the sales dataset and built a first dashboard.' };
    expect((await w.student('POST', `/internships/mine/${id}/logs`, log)).status).toBe(201);
    // The same week again - even written on a different day of it - is refused.
    const again = await w.student('POST', `/internships/mine/${id}/logs`, { ...log, weekOf: iso(new Date(weekStartOf(start).getTime() + 4 * DAY)) });
    expect(again.status).toBe(409);

    const detail = await officer('GET', `/internships/college/${id}`);
    const logId = detail.body.internship.logs[0].id;
    expect(detail.body.internship.queue).toBe('to_evaluate');
    expect((await officer('POST', `/internships/college/${id}/logs/${logId}/review`, { note: 'Good start.' })).status).toBe(200);
    // A reviewed week cannot change underneath the college.
    expect((await w.student('PUT', `/internships/mine/${id}/logs/${logId}`, { hours: 12, summary: log.summary })).status).toBe(409);

    // The mentor, with no account.
    const mentor = appFor({});
    const preview = await mentor('GET', `/internships/review/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.internship).toMatchObject({ organisation: 'Demo Labs', weeksLogged: 1, hoursLogged: 10 });
    expect((await mentor('POST', `/internships/review/${token}`, { score: 4, note: 'Reliable and curious. Would take again.' })).status).toBe(201);
    // One evaluation per link.
    expect((await mentor('POST', `/internships/review/${token}`, { score: 5, note: 'Trying to change my answer.' })).status).toBe(404);
    expect((await mentor('GET', `/internships/review/${token}`)).status).toBe(404);

    // Credits cannot be marked as sent before the internship is complete.
    expect((await officer('POST', `/internships/college/${id}/abc`, {})).status).toBe(409);
    const done = await officer('POST', `/internships/college/${id}/complete`, { certificateUrl: 'https://demo-company.example/cert/1' });
    expect(done.body.internship).toMatchObject({ status: 'COMPLETED', evaluation: { score: 4 } });
    const credited = await officer('POST', `/internships/college/${id}/abc`, {});
    expect(credited.body.internship.abcSubmittedAt).toBeTruthy();
    // Once in ABC, the credits are settled.
    expect((await officer('PUT', `/internships/college/${id}/credits`, { credits: 4 })).status).toBe(409);

    const summary = (await officer('GET', '/internships/college')).body.summary;
    expect(summary).toMatchObject({ completed: 1, hoursLogged: 10 });
    expect(summary.creditsAwarded).toBeGreaterThan(0);
  });

  it('rejects only with a reason, and a rejected internship takes no logs', async () => {
    const w = await world();
    const officer = await officerFor(w.college.id, w.tenant.id);
    const { body } = await w.student('POST', '/internships/mine', proposal(new Date(Date.now() - 7 * DAY), new Date(Date.now() + 30 * DAY)));
    expect((await officer('POST', `/internships/college/${body.internship}/decision`, { approve: false })).status).toBe(400);
    const rejected = await officer('POST', `/internships/college/${body.internship}/decision`, { approve: false, note: 'Not a recognised organisation.' });
    expect(rejected.body.internship.status).toBe('REJECTED');
    const log = await w.student('POST', `/internships/mine/${body.internship}/logs`, {
      weekOf: iso(new Date()),
      hours: 5,
      summary: 'Should not be accepted on a rejected internship.',
    });
    expect(log.status).toBe(409);
  });
});

describe('the fences', () => {
  it('keeps each college to its own internships', async () => {
    const w = await world();
    const otherCollege = await makeCollege('Other Demo College', w.tenant.id);
    const stranger = await officerFor(otherCollege.id, w.tenant.id);
    const { body } = await w.student('POST', '/internships/mine', proposal(new Date(Date.now() - 7 * DAY), new Date(Date.now() + 30 * DAY)));

    expect((await stranger('GET', `/internships/college/${body.internship}`)).status).toBe(404);
    expect((await stranger('POST', `/internships/college/${body.internship}/decision`, { approve: true })).status).toBe(404);
    expect((await stranger('GET', '/internships/college')).body.internships).toHaveLength(0);
    expect((await db.internship.findUniqueOrThrow({ where: { id: body.internship } })).status).toBe('PROPOSED');
  });

  it('refuses a link past its window', async () => {
    const w = await world();
    const officer = await officerFor(w.college.id, w.tenant.id);
    const { body } = await w.student('POST', '/internships/mine', proposal(new Date(Date.now() - 120 * DAY), new Date(Date.now() - 90 * DAY)));
    const approved = await officer('POST', `/internships/college/${body.internship}/decision`, { approve: true });
    const token = (approved.body.mentor.link as string).split('/').pop()!;
    expect((await appFor({})('GET', `/internships/review/${token}`)).status).toBe(404);
  });

  it('is shut where the module is off', async () => {
    const w = await world(false);
    const officer = await officerFor(w.college.id, w.tenant.id);
    expect((await w.student('GET', '/internships/mine')).status).toBe(403);
    expect((await officer('GET', '/internships/college')).status).toBe(403);
  });
});
