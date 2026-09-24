import { afterAll, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { systemRole } from './factories.js';
import { platformRouter } from '../src/modules/tenants/platform.routes.js';
import { filesRouter, sniffImage, uploadDir } from '../src/modules/tenants/assets.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * Logos and favicons. An upload is the one place a stranger's bytes land on
 * our disk and are served back from our origin, so the rules that matter are
 * about what gets refused.
 */

const servers: Server[] = [];
const written: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
afterAll(async () => {
  for (const url of written) await rm(path.join(uploadDir(), path.basename(url)), { force: true });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function platformApp() {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@test.local`, fullName: 'Ops', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({ data: { userId: user.id, roleId: (await systemRole('admin.super')).id } });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: object }).session = { userId: user.id, role: Role.ADMIN, isPlatform: true };
    next();
  });
  app.use('/platform', platformRouter);
  app.use('/files', filesRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const upload = async (kind: string, bytes: Buffer, name: string) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    const res = await fetch(`${base}/platform/uploads/${kind}`, { method: 'POST', body: form });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    if (body.url) written.push(body.url);
    return { status: res.status, body };
  };
  return { base, upload };
}

describe('image uploads', () => {
  it('knows an image by its bytes, not its name', () => {
    expect(sniffImage(PNG)?.ext).toBe('png');
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))?.ext).toBe('svg');
  });

  it('stores a logo and serves it back, locked down', async () => {
    const { base, upload } = await platformApp();
    const res = await upload('logo', PNG, 'anything.txt');
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/api\/files\/logo-[a-f0-9]{24}\.png$/);

    const served = await fetch(`${base}/files/${path.basename(res.body.url)}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('refuses a file that only pretends to be an image', async () => {
    const { upload } = await platformApp();
    const res = await upload('logo', Buffer.from('<html><body>hi</body></html>'), 'logo.png');
    expect(res.status).toBe(400);
  });

  it('refuses an SVG that carries script', async () => {
    const { upload } = await platformApp();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
    expect((await upload('favicon', svg, 'icon.svg')).status).toBe(400);
  });

  it('serves nothing it did not mint', async () => {
    const { base } = await platformApp();
    expect((await fetch(`${base}/files/..%2F.env`)).status).toBe(404);
    expect((await fetch(`${base}/files/logo-${'0'.repeat(24)}.png`)).status).toBe(404);
  });
});
