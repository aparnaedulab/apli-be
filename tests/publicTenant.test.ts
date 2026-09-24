import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import ExcelJS from 'exceljs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { db } from './setup.js';
import { makeTenant } from './factories.js';
import { publicTenantRouter } from '../src/modules/publicTenant/publicTenant.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import {
  PLATFORM_PORTAL,
  buildInviteEmail,
  portalFor,
} from '../src/modules/invites/invite.mail.js';
import { addColleges, homeUniversityOf } from '../src/modules/admin/colleges.bulk.js';
import { buildCollegeTemplate } from '../src/modules/admin/colleges.template.js';
import { env } from '../src/config/env.js';

/**
 * An institution's own address, /t/<slug>, and its own name everywhere the
 * portal used to say HOME_UNIVERSITY.
 *
 * The endpoint needs no session, so the rule that matters most is what it
 * leaves out: the onboarding contact is private, and a draft institution does
 * not exist as far as the public is concerned.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function publicApp() {
  const app = express();
  app.use('/public', publicTenantRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function demoTenant(status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const t = await makeTenant(`Demo University ${Math.random()}`, { status });
  return db.tenant.update({
    where: { id: t.id },
    data: {
      shortName: 'DU',
      tagline: 'Placements, in one place.',
      brandColor: '#1d3b8b',
      supportEmail: 'placements@demo-university.example',
      supportPhone: '+91 90000 00000',
      supportWhatsapp: '+91 90000 00001',
      officeHours: 'Mon–Fri, 10:00–17:00',
      address: 'Demo Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '000000',
      contactName: 'Private Person',
      contactEmail: 'private@demo-university.example',
      contactPhone: '+91 90000 00009',
    },
  });
}

describe('GET /public/tenants/:slug', () => {
  it('returns the branding and Contact us of a live institution', async () => {
    const t = await demoTenant();
    const res = await fetch(`${publicApp()}/public/tenants/${t.slug}`);
    expect(res.status).toBe(200);
    const { tenant } = (await res.json()) as { tenant: Record<string, unknown> };

    expect(tenant.name).toBe(t.name);
    expect(tenant.slug).toBe(t.slug);
    expect(tenant.brandColor).toBe('#1d3b8b');
    expect(tenant.supportEmail).toBe('placements@demo-university.example');
    expect(tenant.officeHours).toBe('Mon–Fri, 10:00–17:00');
  });

  it('never returns the private onboarding contact, the id or the status', async () => {
    const t = await demoTenant();
    const res = await fetch(`${publicApp()}/public/tenants/${t.slug}`);
    const body = JSON.stringify(await res.json());

    for (const key of ['contactName', 'contactEmail', 'contactPhone', '"id"', '"status"', 'completedSteps']) {
      expect(body).not.toContain(key);
    }
    expect(body).not.toContain('private@demo-university.example');
    expect(body).not.toContain(t.id);
  });

  it('answers a draft institution exactly like an unknown address', async () => {
    const draft = await demoTenant('DRAFT');
    const base = publicApp();

    const a = await fetch(`${base}/public/tenants/${draft.slug}`);
    const b = await fetch(`${base}/public/tenants/no-such-place`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
  });

  it('says a suspended institution is temporarily unavailable, without its details', async () => {
    const t = await demoTenant('SUSPENDED');
    const res = await fetch(`${publicApp()}/public/tenants/${t.slug}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('TENANT_UNAVAILABLE');
    expect(body.error.message).toMatch(/temporarily unavailable/);
    expect(JSON.stringify(body)).not.toContain('placements@demo-university.example');
  });

  it('matches the address case-insensitively and refuses odd shapes', async () => {
    const t = await demoTenant();
    const base = publicApp();
    expect((await fetch(`${base}/public/tenants/${t.slug.toUpperCase()}`)).status).toBe(200);
    expect((await fetch(`${base}/public/tenants/${'a'.repeat(80)}`)).status).toBe(404);
  });
});

describe('invitation emails carry the institution', () => {
  const base = {
    to: 'officer@demo-college.example',
    name: 'Demo Officer',
    link: 'http://localhost:5180/invite/abc123',
    role: 'Coordinator',
    where: 'Demo College',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    invitedBy: 'Demo Admin',
  };

  it("names the institution and links its own sign-in page once it is live", async () => {
    const t = await demoTenant();
    const portal = await portalFor(t.id);
    expect(portal.portalName).toBe(t.name);
    expect(portal.portalUrl).toBe(`${env.CLIENT_ORIGIN.replace(/\/+$/, '')}/t/${t.slug}`);

    const mail = buildInviteEmail({ ...base, ...portal });
    expect(mail.subject).toBe(`Your ${t.name} placement portal login`);
    expect(mail.text).toContain(t.name);
    expect(mail.text).toContain(portal.portalUrl!);
    expect(mail.html).toContain(`/t/${t.slug}`);
  });

  it('offers no address for an institution that is not live', async () => {
    const draft = await demoTenant('DRAFT');
    const portal = await portalFor(draft.id);
    expect(portal.portalName).toBe(draft.name);
    expect(portal.portalUrl).toBeUndefined();

    const mail = buildInviteEmail({ ...base, ...portal });
    expect(mail.text).not.toContain('/t/');
  });

  it("signs a company's invitation as Apli.ai", () => {
    const mail = buildInviteEmail({ ...base, ...PLATFORM_PORTAL });
    expect(mail.subject).toBe('Your Apli.ai placement portal login');
  });

  it('falls back to HOME_UNIVERSITY when there is no institution', async () => {
    expect(await portalFor(null)).toEqual({});
    const mail = buildInviteEmail(base);
    expect(mail.subject).toBe(`Your ${env.HOME_UNIVERSITY} placement portal login`);
  });
});

describe('colleges affiliated to "this university"', () => {
  it('means the importing institution in a bulk import', async () => {
    const t = await demoTenant();
    const result = await addColleges(
      [{ name: 'Demo College', code: `DC${Math.floor(Math.random() * 1e6)}`, city: 'Pune', state: 'Maharashtra', affiliation: 'Yes' }],
      { tenantId: t.id },
    );
    expect(result.created[0]!.affiliation).toBe(t.name);
  });

  it('names the institution in the template', async () => {
    const t = await demoTenant();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCollegeTemplate(await homeUniversityOf(t.id))) as ArrayBuffer);

    const values = wb.getWorksheet('Valid values')!;
    const cells: string[] = [];
    values.eachRow((row) => row.eachCell((c) => cells.push(String(c.value))));
    expect(cells.some((c) => c.includes(t.name))).toBe(true);
    expect(cells.some((c) => c.includes(env.HOME_UNIVERSITY) && env.HOME_UNIVERSITY !== t.name)).toBe(false);
  });
});
