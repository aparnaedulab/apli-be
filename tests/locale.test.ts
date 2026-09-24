import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { localeRouter } from '../src/modules/locale/locale.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * The reading language. Small, but it is the one setting a student makes
 * that has to survive a change of device, so it is saved and read back.
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
  app.use('/locale', localeRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (method: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/locale`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function student() {
  return db.user.create({
    data: { email: `student-${Math.random()}@demo-college.example`, fullName: 'Demo Student', passwordHash: 'x', role: Role.CANDIDATE },
  });
}

describe('the reading language', () => {
  it('starts unset, then saves and reads back a choice', async () => {
    const user = await student();
    const call = appFor({ userId: user.id, role: Role.CANDIDATE });

    const first = await call('GET');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ locale: null, available: ['en', 'hi', 'mr'] });

    const saved = await call('PUT', { locale: 'mr' });
    expect(saved.status).toBe(200);
    expect((await call('GET')).body.locale).toBe('mr');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).locale).toBe('mr');
  });

  it('refuses a language the portal does not have', async () => {
    const user = await student();
    const call = appFor({ userId: user.id, role: Role.CANDIDATE });
    expect((await call('PUT', { locale: 'fr' })).status).toBe(400);
    expect((await call('PUT', {})).status).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).locale).toBeNull();
  });

  it('needs a session', async () => {
    const call = appFor({});
    expect((await call('GET')).status).toBe(401);
    expect((await call('PUT', { locale: 'hi' })).status).toBe(401);
  });

  it('ignores a stored value it does not recognise', async () => {
    const user = await student();
    await db.user.update({ where: { id: user.id }, data: { locale: 'xx' } });
    const call = appFor({ userId: user.id, role: Role.CANDIDATE });
    expect((await call('GET')).body.locale).toBeNull();
  });
});
