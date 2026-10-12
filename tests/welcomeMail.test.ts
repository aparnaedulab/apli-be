import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './setup.js';
import { makeCollege, makeTenant } from './factories.js';

/**
 * The welcome email at student sign-up: sent only when the student's
 * institution switched it on in onboarding, and never for a student whose
 * college is not on Apli.ai. Nothing is really sent - the mailer is a stand-in.
 */

const sendMail = vi.fn(async () => ({ sent: true as const }));
vi.mock('../src/lib/mailer.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));

const { welcomeStudent, buildWelcomeEmail } = await import('../src/modules/students/welcome.mail.js');

beforeEach(() => {
  sendMail.mockClear();
});

describe('welcome email at student sign-up', () => {
  it('is not sent while the institution has it off - the default', async () => {
    const tenant = await makeTenant();
    expect(await welcomeStudent({ email: 'a@demo-student.example', name: 'Sample Student', tenantId: tenant.id })).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('is sent once the institution switches it on', async () => {
    const tenant = await makeTenant();
    await makeCollege('Sample College', tenant.id);
    await db.tenant.update({ where: { id: tenant.id }, data: { studentWelcomeEmail: true } });

    const result = await welcomeStudent({ email: 'b@demo-student.example', name: 'Sample Student', tenantId: tenant.id });
    expect(result).toEqual({ sent: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [message] = sendMail.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }];
    expect(message.to).toBe('b@demo-student.example');
    expect(message.subject).toContain(tenant.name);
    expect(message.text).toContain('Hello Sample,');
  });

  it('is never sent for a student with no institution', async () => {
    expect(await welcomeStudent({ email: 'c@demo-student.example', name: 'Sample', tenantId: null })).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('escapes the name in the email', () => {
    const { html } = buildWelcomeEmail({ name: '<b>x</b>', portalName: 'Sample University', link: 'http://localhost/login' });
    expect(html).not.toContain('<b>x</b>');
  });
});
