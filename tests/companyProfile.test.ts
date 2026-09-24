import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { readdir, rm } from 'node:fs/promises';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeRecruiter, makeStudent, makeTenant, systemRole } from './factories.js';
import { companyRouter } from '../src/modules/company/company.routes.js';
import { companyPageRouter } from '../src/modules/showcase/companyPage.routes.js';
import { uploadDir } from '../src/modules/tenants/assets.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * A company's own profile: its pictures, its words, its facts.
 *
 * The things worth pinning are the ones a demo never shows. That an upload is
 * judged by its bytes rather than its name. That the page cannot be made to
 * carry an address we did not mint or a link that is not https - it is shown
 * to students, so it is exactly where a planted image would hurt. And that one
 * company cannot write on another's page.
 */

const servers: Server[] = [];
const written: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  // The uploads land on disk for real; a test that leaves files behind makes
  // the next run's failures harder to read.
  for (const name of written.splice(0)) {
    await rm(`${uploadDir()}/${name}`, { force: true });
  }
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/company', companyRouter);
  app.use('/showcase', companyPageRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return {
    async call(method: string, path: string, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    },
    async upload(kind: string, file: Buffer, filename = 'picture.png') {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file)]), filename);
      const res = await fetch(`http://127.0.0.1:${port}/company/uploads/${kind}`, { method: 'POST', body: form });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await res.json().catch(() => null)) as any;
      if (json?.url) written.push(String(json.url).split('/').pop()!);
      return { status: res.status, body: json };
    },
  };
}

/** The smallest real PNG: the bytes are what the server judges. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fea7e3bd2f0000000049454e44ae426082',
  'hex',
);

async function ownerOf(companyId: string) {
  const user = await makeRecruiter(companyId);
  return appFor({ userId: user.id, role: Role.COMPANY, companyId });
}

describe('uploading a picture', () => {
  it('stores a PNG and hands back an address we minted', async () => {
    const company = await makeCompany('Demo Tech');
    const { upload } = await ownerOf(company.id);

    const res = await upload('logo', PNG);

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/api\/files\/logo-[a-f0-9]{24}\.png$/);
    expect(await readdir(uploadDir())).toContain(res.body.url.split('/').pop());
  });

  it('refuses a file that is not an image, whatever it is called', async () => {
    const company = await makeCompany('Demo Tech');
    const { upload } = await ownerOf(company.id);

    const res = await upload('photo', Buffer.from('<html><script>alert(1)</script></html>'), 'office.png');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/PNG, JPG/i);
  });

  it('refuses a picture too big for a page', async () => {
    const company = await makeCompany('Demo Tech');
    const { upload } = await ownerOf(company.id);

    // Past the 2 MB a logo is allowed, but inside what the request will
    // carry - so the refusal is ours, with a sentence saying what to do.
    const huge = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 0x20)]);
    const res = await upload('logo', huge);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/under \d+ KB/i);
  });

  it('refuses a kind we do not store', async () => {
    const company = await makeCompany('Demo Tech');
    const { upload } = await ownerOf(company.id);

    const res = await upload('resume', PNG);

    expect(res.status).toBe(400);
  });

  it('is closed to a role that cannot edit the profile', async () => {
    const company = await makeCompany('Demo Tech');
    const user = await db.user.create({
      data: {
        email: `viewer-${Math.random()}@demo-company.example`,
        fullName: 'Demo Interviewer',
        passwordHash: 'x',
        role: Role.COMPANY,
      },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, roleId: (await systemRole('company.interviewer')).id },
    });

    const { upload } = appFor({ userId: user.id, role: Role.COMPANY, companyId: company.id });
    const res = await upload('logo', PNG);

    expect(res.status).toBe(403);
  });
});

describe('saving the profile', () => {
  it('keeps the pictures, the words and the facts', async () => {
    const company = await makeCompany('Demo Tech');
    const { call, upload } = await ownerOf(company.id);
    const cover = (await upload('cover', PNG)).body.url as string;
    const shot = (await upload('photo', PNG)).body.url as string;

    const res = await call('PATCH', '/company/profile', {
      coverUrl: cover,
      photos: [{ url: shot, caption: 'The Pune office' }],
      whyJoin: 'You ship in your first month.',
      city: 'Pune',
    });

    expect(res.status).toBe(200);
    expect(res.body.company.coverUrl).toBe(cover);
    expect(res.body.company.photos).toEqual([{ url: shot, caption: 'The Pune office' }]);

    const saved = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(saved.whyJoin).toBe('You ship in your first month.');
    expect(saved.photos).toEqual([{ url: shot, caption: 'The Pune office' }]);
  });

  /**
   * The logo was checked as a link for a while, so the one thing almost every
   * company does with it - upload a picture - came back "Some fields need
   * fixing." An address we minted is not a URL, and it is the usual answer.
   */
  it('keeps a logo they uploaded, not only one they linked', async () => {
    const company = await makeCompany('Demo Tech');
    const { call, upload } = await ownerOf(company.id);
    const logo = (await upload('logo', PNG)).body.url as string;

    const res = await call('PATCH', '/company/profile', { logoUrl: logo });

    expect(res.status).toBe(200);
    expect(res.body.company.logoUrl).toBe(logo);
  });

  it('still refuses a logo from anywhere we would not serve', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    for (const logoUrl of ['http://demo-company.example/logo.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
      const res = await call('PATCH', '/company/profile', { logoUrl });
      expect(res.status, logoUrl).toBe(400);
    }
  });

  it('drops a caption nobody typed rather than storing an empty one', async () => {
    const company = await makeCompany('Demo Tech');
    const { call, upload } = await ownerOf(company.id);
    const shot = (await upload('photo', PNG)).body.url as string;

    const res = await call('PATCH', '/company/profile', { photos: [{ url: shot, caption: '   ' }] });

    expect(res.status).toBe(200);
    expect(res.body.company.photos).toEqual([{ url: shot }]);
  });

  it('refuses more photographs than a page shows', async () => {
    const company = await makeCompany('Demo Tech');
    const { call, upload } = await ownerOf(company.id);
    const shot = (await upload('photo', PNG)).body.url as string;

    const res = await call('PATCH', '/company/profile', {
      photos: Array.from({ length: 7 }, () => ({ url: shot })),
    });

    expect(res.status).toBe(400);
  });

  it('refuses an address we did not mint, and anything not https', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    for (const url of [
      '/api/files/../../etc/passwd',
      'http://demo-company.example/logo.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
    ]) {
      const res = await call('PATCH', '/company/profile', { photos: [{ url }] });
      expect(res.status, url).toBe(400);
    }

    // An https picture hosted elsewhere is a fair answer, so it is kept.
    const ok = await call('PATCH', '/company/profile', {
      photos: [{ url: 'https://demo-company.example/office.png' }],
    });
    expect(ok.status).toBe(200);
  });

  it('refuses a caption longer than the space under a picture', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('PATCH', '/company/profile', {
      photos: [{ url: 'https://demo-company.example/office.png', caption: 'x'.repeat(121) }],
    });

    expect(res.status).toBe(400);
  });

  it('changes only the company the person belongs to', async () => {
    const mine = await makeCompany('Demo Tech');
    const theirs = await makeCompany('Demo Rivals');
    await db.company.update({ where: { id: theirs.id }, data: { about: 'Their own words.' } });
    const { call } = await ownerOf(mine.id);

    await call('PATCH', '/company/profile', { about: 'Ours.' });

    const untouched = await db.company.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched.about).toBe('Their own words.');
    expect((await db.company.findUniqueOrThrow({ where: { id: mine.id } })).about).toBe('Ours.');
  });
});

describe('the page a student reads', () => {
  /** A student whose institution has the company page switched on. */
  async function studentOf(companyId: string) {
    const tenant = await makeTenant();
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'showcase.company', enabled: true } });
    const college = await makeCollege('Demo College', tenant.id);
    const batch = await makeBatch(college.id);
    const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
    void companyId;
    return appFor({ userId: user.id, role: Role.CANDIDATE, candidateId: candidate.id, tenantId: tenant.id });
  }

  it('carries the pictures and the facts beside the words', async () => {
    const company = await makeCompany('Demo Tech');
    const industry = await db.industry.create({ data: { name: 'IT Services' } });
    await db.company.update({
      where: { id: company.id },
      data: {
        logoUrl: '/api/files/logo-aaaaaaaaaaaaaaaaaaaaaaaa.png',
        coverUrl: '/api/files/cover-bbbbbbbbbbbbbbbbbbbbbbbb.png',
        photos: [{ url: '/api/files/photo-cccccccccccccccccccccccc.png', caption: 'The Pune office' }],
        linkedinUrl: 'https://linkedin.com/company/demo-tech',
        industryId: industry.id,
        city: 'Pune',
      },
    });

    const { call } = await studentOf(company.id);
    const res = await call('GET', `/showcase/companies/${company.id}`);

    expect(res.status).toBe(200);
    expect(res.body.says).toMatchObject({
      logoUrl: '/api/files/logo-aaaaaaaaaaaaaaaaaaaaaaaa.png',
      coverUrl: '/api/files/cover-bbbbbbbbbbbbbbbbbbbbbbbb.png',
      linkedinUrl: 'https://linkedin.com/company/demo-tech',
      industry: 'IT Services',
      city: 'Pune',
    });
    expect(res.body.says.photos).toEqual([
      { url: '/api/files/photo-cccccccccccccccccccccccc.png', caption: 'The Pune office' },
    ]);
  });

  it('reads as a page, not a broken one, when a company has uploaded nothing', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await studentOf(company.id);

    const res = await call('GET', `/showcase/companies/${company.id}`);

    expect(res.status).toBe(200);
    expect(res.body.says.coverUrl).toBeNull();
    expect(res.body.says.photos).toEqual([]);
  });

  it('gives a company the same shape for its own preview', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('GET', '/showcase/mine');

    expect(res.status).toBe(200);
    expect(res.body.says.photos).toEqual([]);
    expect(res.body.measured.length).toBeGreaterThan(0);
  });
});
