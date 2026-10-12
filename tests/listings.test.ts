import { afterEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { listingsRouter } from '../src/modules/students/listings.routes.js';
import { signupRouter } from '../src/modules/students/signup.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { db } from './setup.js';

/**
 * The directory of colleges behind "Where do you study?": only the platform
 * team keeps it, and what it keeps is what a student can pick.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Record<string, unknown>;

const TEAM = { userId: 'u', role: 'ADMIN', isPlatform: true };

function app(session: Session = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  a.use('/public', signupRouter);
  a.use('/platform/listings', listingsRouter);
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

const sample = { kind: 'COLLEGE', name: 'Sample Institute of Technology', city: 'Pune', affiliation: 'Sample University' };

describe('college directory', () => {
  it('is kept by the platform team only', async () => {
    expect((await app()('GET', '/platform/listings')).status).toBe(401);
    expect((await app({ userId: 'u', role: 'CANDIDATE' })('GET', '/platform/listings')).status).toBe(403);
    expect((await app({ userId: 'u', role: 'ADMIN', tenantId: 't' })('POST', '/platform/listings', sample)).status).toBe(403);

    const team = app(TEAM);
    expect((await team('POST', '/platform/listings', sample)).status).toBe(201);
    expect((await team('POST', '/platform/listings', sample)).status).toBe(409);
  });

  it('adds a pasted list, skipping what is already there', async () => {
    const team = app(TEAM);
    await team('POST', '/platform/listings', sample);

    const res = await team('POST', '/platform/listings/bulk', {
      rows: [
        sample,
        { kind: 'COLLEGE', name: 'Sample College of Commerce', city: 'Nashik' },
        { kind: 'COLLEGE', name: 'Sample College of Commerce', city: 'Nashik' },
        { kind: 'UNIVERSITY', name: 'Sample State University', city: 'Pune' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ added: 2, skipped: 2 });
    expect(await db.collegeListing.count()).toBe(3);
  });

  it('is what students pick from, and a hidden one leaves the dropdown', async () => {
    const team = app(TEAM);
    const { body } = await team('POST', '/platform/listings', sample);
    const id = body.listing.id as string;

    const pub = app();
    const found = await pub('GET', '/public/colleges?q=sample%20inst');
    expect(found.body.colleges).toEqual([
      expect.objectContaining({ id, source: 'listing', name: sample.name, institution: 'Sample University' }),
    ]);

    const signed = await app({})('POST', '/public/signup/student', {
      fullName: 'Sample Student',
      email: 'listed@demo-student.example',
      password: 'DemoPass2026!',
      listingId: id,
      startYear: new Date().getFullYear() - 2,
      graduationYear: new Date().getFullYear() + 2,
      degreeLevel: 'UG',
      course: 'B.Tech',
      city: 'Pune',
      phone: '90000 00000',
      gender: 'Female',
      dateOfBirth: '2004-06-15',
      agree: true,
    });
    expect(signed.status).toBe(201);
    const candidate = await db.candidate.findFirstOrThrow({ where: { user: { email: 'listed@demo-student.example' } } });
    expect(candidate.listingId).toBe(id);
    expect(candidate.otherCollege).toBeNull();

    await team('PATCH', `/platform/listings/${id}`, { isActive: false });
    expect((await pub('GET', '/public/colleges?q=sample%20inst')).body.colleges).toEqual([]);
  });
});
