import { describe, expect, it, vi } from 'vitest';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeBatch, makeCollege, makeStudent, makeTenant } from './factories.js';
import { runOnce } from '../src/modules/whatsapp/dispatcher.js';
import { maskNumber, normaliseIndianMobile } from '../src/modules/whatsapp/phone.js';
import { cloudProvider, logProvider, NOT_SET_UP, type WhatsAppProvider } from '../src/modules/whatsapp/provider.js';

/**
 * WhatsApp copies of important notifications.
 *
 * The rules that matter are the refusals - no consent, no number, no module,
 * not an important type - and the promise that one notification is never
 * sent twice, however many times the dispatcher runs.
 */

function fakeProvider(result: { ok: true; id: string | null } | { ok: false; error: string } = { ok: true, id: 'wamid.demo' }) {
  const send = vi.fn(async () => result);
  const provider: WhatsAppProvider = { name: 'cloud', configured: true, send };
  return { provider, send };
}

async function student(opts: { phone?: string | null; consent?: boolean; module?: boolean } = {}) {
  const tenant = await makeTenant();
  if (opts.module !== false) {
    await db.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'channel.whatsapp', enabled: true } });
  }
  const college = await makeCollege('Demo College', tenant.id);
  const batch = await makeBatch(college.id);
  const { user, candidate } = await makeStudent(batch.id, { collegeId: college.id });
  await db.candidate.update({
    where: { id: candidate.id },
    data: { phone: opts.phone === undefined ? '+91 90000 00001' : opts.phone },
  });
  if (opts.consent !== false) {
    await db.consentRecord.create({ data: { candidateId: candidate.id, purpose: 'contact_on_whatsapp', granted: true } });
  }
  return { tenant, user, candidate };
}

async function notify(userId: string, type = 'application.offered', createdAt?: Date) {
  return db.notification.create({
    data: { userId, type, title: 'You have an offer', body: 'Demo Company made you an offer for Demo Role.', ...(createdAt ? { createdAt } : {}) },
  });
}

describe('Indian mobile numbers', () => {
  it('reduces the ways rosters write them to one form', () => {
    for (const raw of ['9000000001', '+91 90000 00001', '+91-90000-00001', '090000 00001', '0091 9000000001', '919000000001', '(+91) 90000.00001']) {
      expect(normaliseIndianMobile(raw)).toEqual({ ok: true, e164: '+919000000001' });
    }
  });

  it('refuses what cannot be a mobile, with a reason', () => {
    expect(normaliseIndianMobile('')).toMatchObject({ ok: false });
    expect(normaliseIndianMobile('020 0000 0000')).toMatchObject({ ok: false, reason: expect.stringMatching(/landline/) });
    expect(normaliseIndianMobile('+44 7000 000000')).toMatchObject({ ok: false, reason: expect.stringMatching(/Indian/) });
    expect(normaliseIndianMobile('90000')).toMatchObject({ ok: false, reason: expect.stringMatching(/10 digits/) });
    expect(normaliseIndianMobile('call me')).toMatchObject({ ok: false });
  });

  it('masks to the last four digits', () => {
    expect(maskNumber('+919000000001')).toBe('••••••0001');
    expect(maskNumber('')).toBe('—');
  });
});

describe('the dispatcher', () => {
  it('sends an important notification once, and never again', async () => {
    const s = await student();
    const n = await notify(s.user.id);
    const { provider, send } = fakeProvider();

    expect(await runOnce({ provider })).toMatchObject({ considered: 1, sent: 1 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+919000000001', template: 'apli_offer_update', params: ['You have an offer', expect.stringContaining('Demo Company')] }),
    );

    const row = await db.whatsAppMessage.findUniqueOrThrow({ where: { notificationId: n.id } });
    expect(row).toMatchObject({ status: 'SENT', toMasked: '••••••0001', candidateId: s.candidate.id, tenantId: s.tenant.id });

    expect(await runOnce({ provider })).toMatchObject({ considered: 0, sent: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.whatsAppMessage.count()).toBe(1);
  });

  it('skips a student who has not allowed WhatsApp, and says why', async () => {
    const s = await student({ consent: false });
    await notify(s.user.id);
    const { provider, send } = fakeProvider();
    expect(await runOnce({ provider })).toMatchObject({ skipped: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    const row = await db.whatsAppMessage.findFirstOrThrow();
    expect(row.status).toBe('SKIPPED');
    expect(row.error).toMatch(/not allowed WhatsApp/);
  });

  it('respects a withdrawn consent', async () => {
    const s = await student();
    await db.consentRecord.create({
      data: { candidateId: s.candidate.id, purpose: 'contact_on_whatsapp', granted: false, createdAt: new Date(Date.now() + 1000) },
    });
    await notify(s.user.id);
    const { provider, send } = fakeProvider();
    await runOnce({ provider });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a student with no usable number', async () => {
    const s = await student({ phone: null });
    await notify(s.user.id);
    const { provider, send } = fakeProvider();
    await runOnce({ provider });
    expect(send).not.toHaveBeenCalled();
    expect(await db.whatsAppMessage.findFirstOrThrow()).toMatchObject({ status: 'SKIPPED', toMasked: '—' });
  });

  it('does not look at an institution without the module at all', async () => {
    const s = await student({ module: false });
    await notify(s.user.id);
    const { provider, send } = fakeProvider();
    expect(await runOnce({ provider })).toMatchObject({ considered: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await db.whatsAppMessage.count()).toBe(0);
  });

  it('leaves routine notifications, old news and non-students in the app', async () => {
    const s = await student();
    await notify(s.user.id, 'application.under_review');
    await notify(s.user.id, 'application.offered', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const officer = await db.user.create({
      data: { email: `tpo-${Math.random()}@demo-college.example`, fullName: 'Demo Officer', passwordHash: 'x', role: Role.CAMPUS },
    });
    await notify(officer.id);
    const { provider, send } = fakeProvider();
    expect(await runOnce({ provider })).toMatchObject({ considered: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('logs "not set up" when no provider is configured, and sends nothing', async () => {
    const s = await student();
    await notify(s.user.id);
    expect(await runOnce({ provider: logProvider })).toMatchObject({ skipped: 1, sent: 0 });
    expect(await db.whatsAppMessage.findFirstOrThrow()).toMatchObject({ status: 'SKIPPED', error: NOT_SET_UP });
  });

  it('records a failure from the provider', async () => {
    const s = await student();
    await notify(s.user.id);
    const { provider } = fakeProvider({ ok: false, error: 'Template not approved' });
    expect(await runOnce({ provider })).toMatchObject({ failed: 1 });
    expect(await db.whatsAppMessage.findFirstOrThrow()).toMatchObject({ status: 'FAILED', error: 'Template not approved' });
  });
});

describe('the Cloud API provider', () => {
  it('builds the template request Meta expects', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.demo' }] }) }));
    const provider = cloudProvider({ token: 'demo-token', phoneNumberId: '000000000000000', apiVersion: 'v21.0', fetchImpl });

    const result = await provider.send({ to: '+919000000001', template: 'apli_offer_update', lang: 'en', params: ['Title', 'Body'] });
    expect(result).toEqual({ ok: true, id: 'wamid.demo' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://graph.facebook.com/v21.0/000000000000000/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer demo-token');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '919000000001',
      type: 'template',
      template: {
        name: 'apli_offer_update',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Title' }, { type: 'text', text: 'Body' }] }],
      },
    });
  });

  it('turns an HTTP error into a failure with Meta’s own message', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: '(#132001) Template name does not exist in the translation' } }),
    }));
    const provider = cloudProvider({ token: 'demo-token', phoneNumberId: '000000000000000', apiVersion: 'v21.0', fetchImpl });
    const result = await provider.send({ to: '+919000000001', template: 'missing', lang: 'en', params: ['a', 'b'] });
    expect(result).toEqual({ ok: false, error: '(#132001) Template name does not exist in the translation' });
  });

  it('turns a network error into a failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const provider = cloudProvider({ token: 'demo-token', phoneNumberId: '000000000000000', apiVersion: 'v21.0', fetchImpl });
    expect(await provider.send({ to: '+919000000001', template: 't', lang: 'en', params: [] })).toEqual({
      ok: false,
      error: 'getaddrinfo ENOTFOUND',
    });
  });
});
