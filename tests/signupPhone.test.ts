import { afterEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { signupRouter } from '../src/modules/students/signup.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { db } from './setup.js';

/**
 * The mobile number at sign-up: a country code picked from a list and the
 * number on its own, checked against that country's numbering and kept in
 * one international form. Also the rest of "You" and "Your studies": date
 * of birth, batch, CGPA and the course's level. Its own file, so these sign-ups do not run into
 * the per-minute limit the other sign-up tests share.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {};
    next();
  });
  a.use('/public', signupRouter);
  a.use((err: unknown, req: Request, res: Response, next: NextFunction) => errorHandler(err, req, res, next));
  const server = a.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return async function signup(overrides: Record<string, unknown>) {
    const res = await fetch(`http://127.0.0.1:${port}/public/signup/student`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Sample Student',
        email: `p${Math.random().toString(36).slice(2, 8)}@demo-student.example`,
        password: 'DemoPass2026!',
        startYear: new Date().getFullYear() - 3,
        graduationYear: new Date().getFullYear() + 1,
        degreeLevel: 'UG',
        course: 'B.Tech',
        city: 'Pune',
        gender: 'Female',
        dateOfBirth: '2004-06-15',
        otherCollege: 'Sample Unlisted College',
        agree: true,
        ...overrides,
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

describe('the rest of the sign-up', () => {
  it('keeps date of birth, batch and CGPA, and takes the level from the course', async () => {
    await db.course.create({ data: { name: 'MBA', level: 'PG', years: 2 } });
    const year = new Date().getFullYear();
    const res = await app()({
      email: 'batch@demo-student.example',
      phone: '90000 00001',
      course: 'MBA',
      degreeLevel: 'UG', // the course says otherwise, and the course wins
      startYear: year - 1,
      graduationYear: year + 1,
      cgpa: '8.456',
    });
    expect(res.status).toBe(201);
    const c = await db.candidate.findFirstOrThrow({ where: { user: { email: 'batch@demo-student.example' } } });
    expect(c.degreeLevel).toBe('PG');
    expect([c.startYear, c.graduationYear]).toEqual([year - 1, year + 1]);
    expect(c.dateOfBirth?.toISOString().slice(0, 10)).toBe('2004-06-15');
    expect(Number(c.cgpa)).toBe(8.46);
    expect(c.gender).toBe('Female');
  });

  it('refuses a batch that ends before it starts, a CGPA over 10, a child, and no gender', async () => {
    const year = new Date().getFullYear();
    const res = await app()({
      phone: '90000 00002',
      startYear: year,
      graduationYear: year - 1,
      cgpa: 11,
      dateOfBirth: `${year - 5}-01-01`,
      gender: '',
    });
    expect(res.status).toBe(400);
    const paths = (res.body.error.fields as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['cgpa', 'dateOfBirth', 'gender']));
  });
});

const phoneOf = async (email: string) =>
  (await db.candidate.findFirstOrThrow({ where: { user: { email } } })).phone;

describe('mobile number at sign-up', () => {
  it('keeps the number in one form, whatever spacing it was typed with', async () => {
    const res = await app()({ email: 'india@demo-student.example', phoneCountry: 'IN', phone: '90000 00000' });
    expect(res.status).toBe(201);
    expect(await phoneOf('india@demo-student.example')).toBe('+91 90000 00000');
  });

  it('checks the number against the country picked', async () => {
    const signup = app();
    const us = await signup({ email: 'abroad@demo-student.example', phoneCountry: 'US', phone: '(201) 555-0123' });
    expect(us.status).toBe(201);
    expect(await phoneOf('abroad@demo-student.example')).toBe('+1 201 555 0123');

    const short = await signup({ phoneCountry: 'IN', phone: '12345' });
    expect(short.status).toBe(400);
    expect((short.body.error.fields as { path: string }[]).map((f) => f.path)).toContain('phone');

    const unknown = await signup({ phoneCountry: 'ZZ', phone: '9000000000' });
    expect(unknown.status).toBe(400);
  });

  it('asks for a number - it is not optional', async () => {
    const res = await app()({ phoneCountry: 'IN', phone: '' });
    expect(res.status).toBe(400);
    expect((res.body.error.fields as { path: string }[]).map((f) => f.path)).toContain('phone');
  });
});
