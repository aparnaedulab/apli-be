import { afterEach, describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { partnerAdminRouter, partnerPublicRouter } from '../src/modules/partners/partners.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { db } from './setup.js';

/**
 * Universities and colleges asking to partner: anyone may send a request,
 * only the platform team may read or move one.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Record<string, unknown>;

function app(session: Session = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  a.use('/public', partnerPublicRouter);
  a.use('/platform/partner-requests', partnerAdminRouter);
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

const request = {
  kind: 'COLLEGE',
  institutionName: 'Sample College of Engineering',
  city: 'Pune',
  contactName: 'Sample Officer',
  contactRole: 'Placement officer',
  email: 'officer@sample-college.example',
  students: 1800,
};

describe('partner requests', () => {
  it('records a request from anyone, as new', async () => {
    const res = await app()('POST', '/public/partner-requests', request);
    expect(res.status).toBe(201);
    const saved = await db.partnerRequest.findUniqueOrThrow({ where: { id: res.body.request.id } });
    expect(saved.status).toBe('NEW');
    expect(saved.institutionName).toBe('Sample College of Engineering');
    expect(saved.students).toBe(1800);
  });

  it('says which fields are missing', async () => {
    const res = await app()('POST', '/public/partner-requests', { kind: 'UNIVERSITY', institutionName: 'X' });
    expect(res.status).toBe(400);
    const paths = (res.body.error.fields as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['institutionName', 'city', 'contactName', 'email']));
  });

  it('lets the platform team list and move requests, and nobody else', async () => {
    const { body } = await app()('POST', '/public/partner-requests', request);
    const id = body.request.id as string;

    const team = app({ userId: 'u', role: 'ADMIN', isPlatform: true });
    const list = await team('GET', '/platform/partner-requests');
    expect(list.status).toBe(200);
    expect(list.body.requests.map((r: { id: string }) => r.id)).toContain(id);

    const moved = await team('PATCH', `/platform/partner-requests/${id}`, { status: 'CONTACTED' });
    expect(moved.body.request.status).toBe('CONTACTED');

    expect((await app({ userId: 'u', role: 'CANDIDATE' })('GET', '/platform/partner-requests')).status).toBe(403);
    expect((await app({ userId: 'u', role: 'ADMIN', tenantId: 't' })('GET', '/platform/partner-requests')).status).toBe(403);
  });
});
