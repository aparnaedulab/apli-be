import { afterEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { signupRouter } from '../src/modules/students/signup.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requireModule } from '../src/modules/tenants/tenant.context.js';
import { db } from './setup.js';
import { makeCollege, makeTenant } from './factories.js';

/**
 * Open sign-up: any student, from any college, with no code and no approval.
 *
 * What has to hold: a student can join with a college that is on the
 * platform (and lands on its roster) or with one that is not (and keeps the
 * name they typed); the college search finds only live colleges; and a
 * student with no institution behind them still reaches the open features.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Record<string, unknown>;

/** The public routes, plus one guarded route to see what a session can reach. */
function app(session: Session = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  a.use('/public', signupRouter);
  a.get('/internships', requireModule('proof.simulations'), (_req: Request, res: Response) => res.json({ ok: true }));
  a.get('/reports', requireModule('compliance.reports'), (_req: Request, res: Response) => res.json({ ok: true }));
  a.use((err: unknown, req: Request, res: Response, next: NextFunction) => errorHandler(err, req, res, next));
  const server = a.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

const year = new Date().getFullYear();

function student(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Sample Student',
    email: `s${Math.random().toString(36).slice(2, 8)}@demo-student.example`,
    password: 'DemoPass2026!',
    startYear: year - 3,
    graduationYear: year + 1,
    degreeLevel: 'UG',
    course: 'B.Tech',
    city: 'Pune',
    phone: '90000 00000',
    gender: 'Female',
    dateOfBirth: '2004-06-15',
    agree: true,
    ...overrides,
  };
}

describe('open student sign-up', () => {
  it('joins a listed college and lands on its roster, signed in', async () => {
    const tenant = await makeTenant();
    const college = await makeCollege('Sample Institute of Technology', tenant.id);
    const session: Session = {};
    const call = app(session);

    const res = await call('POST', '/public/signup/student', student({ collegeId: college.id, course: 'B.E.' }));
    expect(res.status).toBe(201);

    const candidate = await db.candidate.findFirstOrThrow({ where: { user: { email: res.body.user.email } } });
    expect(candidate.collegeId).toBe(college.id);
    expect(candidate.otherCollege).toBeNull();
    expect(candidate.course).toBe('B.E.');

    const membership = await db.batchMembership.findFirst({
      where: { candidateId: candidate.id },
      include: { batch: true },
    });
    expect(membership?.batch.name).toBe('Unassigned');
    expect(membership?.batch.collegeId).toBe(college.id);

    expect(session.candidateId).toBe(candidate.id);
    expect(session.tenantId).toBe(tenant.id);
  });

  it('joins with a college that is not listed, keeping the name typed', async () => {
    const session: Session = {};
    const call = app(session);

    const res = await call('POST', '/public/signup/student', student({ otherCollege: 'Sample College of Arts' }));
    expect(res.status).toBe(201);

    const candidate = await db.candidate.findFirstOrThrow({ where: { user: { email: res.body.user.email } } });
    expect(candidate.collegeId).toBeNull();
    expect(candidate.otherCollege).toBe('Sample College of Arts');
    expect(await db.batchMembership.count({ where: { candidateId: candidate.id } })).toBe(0);
    expect(session.tenantId).toBeUndefined();
  });

  it('refuses a second account on the same email, and asks where they study', async () => {
    const call = app();
    const first = student({ otherCollege: 'Sample College' });
    expect((await call('POST', '/public/signup/student', first)).status).toBe(201);
    expect((await call('POST', '/public/signup/student', first)).status).toBe(409);

    const nowhere = await call('POST', '/public/signup/student', student());
    expect(nowhere.status).toBe(400);
  });

  it('will not put a student in a college whose institution is not live', async () => {
    const draft = await makeTenant('Draft University', { status: 'DRAFT' });
    const college = await makeCollege('Draft College', draft.id);
    const call = app();

    const res = await call('POST', '/public/signup/student', student({ collegeId: college.id }));
    expect(res.status).toBe(400);
  });

  it('searches live colleges only, and only once two letters are typed', async () => {
    const live = await makeTenant();
    const draft = await makeTenant('Hidden University', { status: 'DRAFT' });
    await makeCollege('Zephyr Institute of Science', live.id);
    await makeCollege('Zephyr Hidden College', draft.id);
    const call = app();

    expect((await call('GET', '/public/colleges?q=z')).body.colleges).toEqual([]);
    const found = (await call('GET', '/public/colleges?q=zephyr')).body.colleges as { name: string }[];
    expect(found.map((c) => c.name)).toEqual(['Zephyr Institute of Science']);
  });
});

describe('a student with no institution behind them', () => {
  it('reaches the open features and nothing else', async () => {
    const call = app({ role: 'CANDIDATE', userId: 'u', candidateId: 'c' });
    expect((await call('GET', '/internships')).status).toBe(200);
    expect((await call('GET', '/reports')).status).toBe(403);
  });

  it('gives nobody else the open features without an institution', async () => {
    const call = app({ role: 'COMPANY', userId: 'u' });
    expect((await call('GET', '/internships')).status).toBe(403);
  });

  it('keeps what the student says about their studies and interests', async () => {
    await db.refValue.createMany({
      data: ['Software', 'Data', 'Design', 'Law'].map((value, position) => ({
        kind: 'CAREER_INTEREST' as const,
        value,
        position,
      })),
    });
    const res = await app()(
      'POST',
      '/public/signup/student',
      student({
        email: 'details@demo-student.example',
        otherCollege: 'Sample Unlisted College',
        degreeLevel: 'PG',
        specialisation: 'Computer Science',
        city: 'Nashik',
        phoneCountry: 'IN',
        phone: '9000000000',
        interests: ['Data', 'Design', 'Data'],
      }),
    );
    expect(res.status).toBe(201);
    const c = await db.candidate.findFirstOrThrow({ where: { user: { email: 'details@demo-student.example' } } });
    expect(c.degreeLevel).toBe('PG');
    expect(c.specialisation).toBe('Computer Science');
    expect(c.city).toBe('Nashik');
    expect(c.phone).toBe('+91 90000 00000');
    expect(c.interests).toEqual(['Data', 'Design']);

    const bad = await app()('POST', '/public/signup/student', student({ interests: ['Software', 'Data', 'Design', 'Law'] }));
    expect(bad.status).toBe(400);
    // Only what the platform team lists.
    const unlisted = await app()('POST', '/public/signup/student', student({ interests: ['Astrology'] }));
    expect(unlisted.status).toBe(400);
    const missing = await app()('POST', '/public/signup/student', student({ degreeLevel: undefined, city: undefined }));
    const paths = (missing.body.error.fields as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['degreeLevel', 'city']));
  });
});
