import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { rm } from 'node:fs/promises';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeCompany, makeRecruiter, makeStudent, makeTenant, systemRole } from './factories.js';
import { companyPostsRouter } from '../src/modules/showcase/companyPosts.routes.js';
import { companyPageRouter } from '../src/modules/showcase/companyPage.routes.js';
import { uploadDir } from '../src/modules/tenants/assets.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

/**
 * A company's posts.
 *
 * This is the one place where one account's HTML is rendered in another
 * account's browser, so most of what is worth pinning is about what does not
 * survive the journey: scripts, event handlers, javascript: links, frames.
 * The rest is about who can see what - a draft is nobody's business but the
 * company's, and an unverified company has no page for a post to appear on.
 */

const servers: Server[] = [];
const written: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const name of written.splice(0)) await rm(`${uploadDir()}/${name}`, { force: true });
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/company/posts', companyPostsRouter);
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
    async upload(kind: string, file: Buffer, filename = 'clip.mp4') {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file)]), filename);
      const res = await fetch(`http://127.0.0.1:${port}/company/posts/media?kind=${kind}`, {
        method: 'POST',
        body: form,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json = (await res.json().catch(() => null)) as any;
      if (json?.url) written.push(String(json.url).split('/').pop()!);
      return { status: res.status, body: json };
    },
  };
}

/** The smallest real PNG - the bytes are what the server judges. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fea7e3bd2f0000000049454e44ae426082',
  'hex',
);

/** An MP4 header: a box size, "ftyp", then the brand it was written as. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(32, 0),
]);

async function ownerOf(companyId: string) {
  const user = await makeRecruiter(companyId);
  return appFor({ userId: user.id, role: Role.COMPANY, companyId });
}

/** A student whose institution has company pages switched on. */
async function studentReader() {
  const tenant = await makeTenant('Reading University');
  await db.tenantModule.create({
    data: { tenantId: tenant.id, moduleKey: 'showcase.company', enabled: true },
  });
  const college = await makeCollege('Reading College', tenant.id);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  return appFor({
    userId: user.id,
    role: Role.CANDIDATE,
    candidateId: candidate.id,
    tenantId: tenant.id,
  });
}

async function post(companyId: string, data: Partial<{ bodyHtml: string; publishedAt: Date | null; pinned: boolean }>) {
  return db.companyPost.create({
    data: {
      companyId,
      bodyHtml: data.bodyHtml ?? '<p>An update.</p>',
      media: [],
      publishedAt: data.publishedAt === undefined ? new Date() : data.publishedAt,
      pinned: data.pinned ?? false,
    },
  });
}

describe('what a post may contain', () => {
  it('keeps the formatting a company uses and discards the rest', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('POST', '/company/posts', {
      bodyHtml:
        '<h3>Hiring</h3><p style="position:fixed">Twelve <strong>graduates</strong></p>' +
        '<script>alert(1)</script><iframe src="https://evil.example"></iframe>' +
        '<p><img src=x onerror="alert(1)">and a picture</p><ul><li>Pune</li></ul>',
    });

    expect(res.status).toBe(201);
    const html = res.body.post.bodyHtml;
    expect(html).toContain('<h3>Hiring</h3>');
    expect(html).toContain('<strong>graduates</strong>');
    expect(html).toContain('<li>Pune</li>');
    expect(html).not.toMatch(/script|iframe|onerror|style=/i);
  });

  it('keeps the words of a javascript: link but never the link', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('POST', '/company/posts', {
      bodyHtml: '<p><a href="javascript:alert(1)">tap here</a></p>',
    });

    expect(res.status).toBe(201);
    expect(res.body.post.bodyHtml).toContain('tap here');
    expect(res.body.post.bodyHtml).not.toMatch(/javascript:/i);
  });

  it('drops an http link and marks the ones it keeps', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('POST', '/company/posts', {
      bodyHtml: '<p><a href="http://demo-company.example">plain</a> <a href="https://demo-company.example">safe</a></p>',
    });

    const html = res.body.post.bodyHtml;
    expect(html).not.toContain('http://demo-company.example');
    expect(html).toContain('href="https://demo-company.example"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
  });

  it('refuses a post that is empty once the markup is stripped', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('POST', '/company/posts', { bodyHtml: '<script>alert(1)</script><p>   </p>' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/write something/i);
  });

  it('refuses a post longer than a page of anybody', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const res = await call('POST', '/company/posts', { bodyHtml: `<p>${'a'.repeat(20_001)}</p>` });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/too long/i);
  });

  it('refuses a fifth attachment', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    const media = Array.from({ length: 5 }, (_, i) => ({
      kind: 'image' as const,
      url: `https://demo-company.example/${i}.png`,
    }));
    const res = await call('POST', '/company/posts', { bodyHtml: '<p>Five pictures</p>', media });

    expect(res.status).toBe(400);
  });

  it('refuses an attachment from somewhere we would not load', async () => {
    const company = await makeCompany('Demo Tech');
    const { call } = await ownerOf(company.id);

    for (const url of ['javascript:alert(1)', 'http://demo-company.example/x.png', '../../etc/passwd']) {
      const res = await call('POST', '/company/posts', {
        bodyHtml: '<p>Look</p>',
        media: [{ kind: 'image', url }],
      });
      expect(res.status, url).toBe(400);
    }
  });
});

describe('uploading what goes inside a post', () => {
  it('stores a video and hands back an address we minted', async () => {
    const company = await makeCompany('Demo Tech');
    const { upload } = await ownerOf(company.id);

    const res = await upload('video', MP4);

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/api\/files\/video-[a-f0-9]{24}\.mp4$/);
  });

  it('refuses a picture renamed as a video', async () => {
    const company = await makeCompany('Demo Tech');
    const { upload } = await ownerOf(company.id);

    const res = await upload('video', PNG, 'clip.mp4');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/MP4, WebM or MOV/i);
  });

  it('is closed to a role that cannot edit the page', async () => {
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
    const { call } = appFor({ userId: user.id, role: Role.COMPANY, companyId: company.id });

    const res = await call('POST', '/company/posts', { bodyHtml: '<p>Not mine to write</p>' });

    expect(res.status).toBe(403);
  });
});

describe('who sees a post', () => {
  it('keeps a draft to the company that wrote it', async () => {
    const company = await makeCompany('Demo Tech');
    await post(company.id, { bodyHtml: '<p>Still writing</p>', publishedAt: null });
    await post(company.id, { bodyHtml: '<p>Out in the world</p>' });

    const { call: asCompany } = await ownerOf(company.id);
    const mine = await asCompany('GET', '/company/posts');
    expect(mine.body.posts).toHaveLength(2);

    const { call: asStudent } = await studentReader();
    const theirs = await asStudent('GET', `/showcase/companies/${company.id}/posts`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.posts).toHaveLength(1);
    expect(theirs.body.posts[0].bodyHtml).toContain('Out in the world');
  });

  it('shows nothing from a company that is not verified yet', async () => {
    const company = await makeCompany('Demo Tech', false);
    await post(company.id, {});

    const { call } = await studentReader();
    const res = await call('GET', `/showcase/companies/${company.id}/posts`);

    expect(res.status).toBe(404);
  });

  it('lets a placement cell read what a company has been saying', async () => {
    const tenant = await makeTenant('Reading University');
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'showcase.company', enabled: true } });
    const college = await makeCollege('Reading College', tenant.id);
    const company = await makeCompany('Demo Tech');
    await post(company.id, { bodyHtml: '<p>Twelve graduates this season</p>' });

    const officer = await db.user.create({
      data: {
        email: `tpo-${Math.random()}@demo-college.example`,
        fullName: 'Demo Officer',
        passwordHash: 'x',
        role: Role.CAMPUS,
      },
    });
    await db.campusMember.create({
      data: { userId: officer.id, collegeId: college.id, roleId: (await systemRole('campus.officer')).id },
    });

    const { call } = appFor({
      userId: officer.id,
      role: Role.CAMPUS,
      collegeId: college.id,
      tenantId: tenant.id,
    });
    const res = await call('GET', `/showcase/companies/${company.id}/posts`);

    expect(res.status).toBe(200);
    expect(res.body.posts[0].bodyHtml).toContain('Twelve graduates');
  });

  it('carries the newest three with the page itself', async () => {
    const company = await makeCompany('Demo Tech');
    for (let i = 0; i < 5; i++) {
      await post(company.id, { bodyHtml: `<p>Update ${i}</p>`, publishedAt: new Date(2026, 0, i + 1) });
    }

    const { call } = await studentReader();
    const res = await call('GET', `/showcase/companies/${company.id}`);

    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(3);
    expect(res.body.posts[0].bodyHtml).toContain('Update 4');
    expect(res.body.postsCursor).not.toBeNull();
  });

  it('forgets a deleted post on both sides', async () => {
    const company = await makeCompany('Demo Tech');
    const written = await post(company.id, { bodyHtml: '<p>Said in error</p>' });
    const { call } = await ownerOf(company.id);

    expect((await call('DELETE', `/company/posts/${written.id}`)).status).toBe(204);

    expect((await call('GET', '/company/posts')).body.posts).toHaveLength(0);
    const { call: asStudent } = await studentReader();
    expect((await asStudent('GET', `/showcase/companies/${company.id}/posts`)).body.posts).toHaveLength(0);
    // Kept in the table, so a company can still be asked what it posted.
    expect(await db.companyPost.findUnique({ where: { id: written.id } })).not.toBeNull();
  });
});

describe('a post that belongs to somebody else', () => {
  it('answers as though they do not exist', async () => {
    const mine = await makeCompany('Demo Tech');
    const theirs = await makeCompany('Demo Rivals');
    const written = await post(theirs.id, {});
    const { call } = await ownerOf(mine.id);

    for (const [method, path, body] of [
      ['PATCH', `/company/posts/${written.id}`, { bodyHtml: '<p>Mine now</p>' }],
      ['DELETE', `/company/posts/${written.id}`, undefined],
      ['POST', `/company/posts/${written.id}/pin`, { pinned: true }],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // And nothing of theirs was touched.
    expect((await db.companyPost.findUniqueOrThrow({ where: { id: written.id } })).deletedAt).toBeNull();
  });
});

describe('pinning', () => {
  it('releases whatever was pinned before', async () => {
    const company = await makeCompany('Demo Tech');
    const first = await post(company.id, { bodyHtml: '<p>First</p>', pinned: true });
    const second = await post(company.id, { bodyHtml: '<p>Second</p>' });
    const { call } = await ownerOf(company.id);

    const res = await call('POST', `/company/posts/${second.id}/pin`, { pinned: true });

    expect(res.status).toBe(200);
    expect((await db.companyPost.findUniqueOrThrow({ where: { id: first.id } })).pinned).toBe(false);
    expect((await db.companyPost.findUniqueOrThrow({ where: { id: second.id } })).pinned).toBe(true);
  });

  it('refuses to pin a draft: there is no page for it to sit on', async () => {
    const company = await makeCompany('Demo Tech');
    const draft = await post(company.id, { publishedAt: null });
    const { call } = await ownerOf(company.id);

    const res = await call('POST', `/company/posts/${draft.id}/pin`, { pinned: true });

    expect(res.status).toBe(400);
  });

  it('puts the pinned post first, however old it is', async () => {
    const company = await makeCompany('Demo Tech');
    await post(company.id, { bodyHtml: '<p>Old and important</p>', publishedAt: new Date(2026, 0, 1), pinned: true });
    await post(company.id, { bodyHtml: '<p>Yesterday</p>', publishedAt: new Date(2026, 8, 19) });

    const { call } = await studentReader();
    const res = await call('GET', `/showcase/companies/${company.id}/posts`);

    expect(res.body.posts[0].bodyHtml).toContain('Old and important');
    expect(res.body.posts[1].bodyHtml).toContain('Yesterday');
  });
});

describe('editing', () => {
  it('keeps the moment it was published, not the moment it was corrected', async () => {
    const company = await makeCompany('Demo Tech');
    const published = new Date(2026, 0, 1);
    const written = await post(company.id, { bodyHtml: '<p>Twelve graduate</p>', publishedAt: published });
    const { call } = await ownerOf(company.id);

    const res = await call('PATCH', `/company/posts/${written.id}`, {
      bodyHtml: '<p>Twelve graduates</p>',
      publish: true,
    });

    expect(res.status).toBe(200);
    expect(new Date(res.body.post.publishedAt).toISOString()).toBe(published.toISOString());
  });

  it('takes a post off the page without losing what was written', async () => {
    const company = await makeCompany('Demo Tech');
    const written = await post(company.id, { pinned: true });
    const { call } = await ownerOf(company.id);

    const res = await call('PATCH', `/company/posts/${written.id}`, { publish: false });

    expect(res.body.post.publishedAt).toBeNull();
    expect(res.body.post.pinned).toBe(false);
    expect(res.body.post.bodyHtml).toContain('An update.');
  });
});
