import { describe, expect, it } from 'vitest';
import { buildInviteEmail } from '../src/modules/invites/invite.mail.js';
import { mailIsConfigured, sendMail } from '../src/lib/mailer.js';
import { wantsEmail } from '../src/modules/roles/logins.template.js';

/**
 * The invitation email.
 *
 * It carries a bearer token in a URL, which makes it both the most useful and
 * the most dangerous message this portal sends. These tests hold the two
 * things that keep it honest: the link is shown in full rather than hidden
 * behind friendly text, and a name typed by an admin cannot smuggle markup
 * into somebody else's inbox.
 */

const base = {
  to: 'rakesh@pict.demo-college.example',
  name: 'Rakesh Pawar',
  link: 'http://localhost:5180/invite/abc123',
  role: 'Coordinator',
  where: 'Pune Institute (PICT)',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  invitedBy: 'Sujata Bhide',
};

describe('the invitation email', () => {
  it('shows the link in full, in both the text and the HTML', () => {
    const mail = buildInviteEmail(base);

    // A shortened or hidden link teaches exactly the habit that gets people
    // phished, so the URL appears as itself in both parts.
    expect(mail.text).toContain(base.link);
    expect(mail.html).toContain(base.link);
    expect(mail.to).toBe(base.to);
  });

  it('says what the account is for and who set it up', () => {
    const mail = buildInviteEmail(base);

    expect(mail.text).toContain('Coordinator');
    expect(mail.text).toContain('Pune Institute (PICT)');
    expect(mail.text).toContain('Sujata Bhide');
    expect(mail.subject).toContain('placement portal');
  });

  it('says when the link stops working', () => {
    const mail = buildInviteEmail(base);
    expect(mail.text).toContain('in 7 days');

    const tomorrow = buildInviteEmail({
      ...base,
      expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000),
    });
    expect(tomorrow.text).toContain('tomorrow');
  });

  it('escapes a name, so nothing typed on the form becomes markup', () => {
    const mail = buildInviteEmail({
      ...base,
      name: '<script>alert(1)</script>',
      invitedBy: 'A & B "Ops"',
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('A &amp; B &quot;Ops&quot;');
  });

  it('greets somebody whose name was never captured, without an empty gap', () => {
    const mail = buildInviteEmail({ ...base, name: '' });

    expect(mail.text.startsWith('Hello,')).toBe(true);
    expect(mail.text).not.toContain('Hello ,');
  });
});

describe('a deployment with no mail server', () => {
  it('reports that it cannot send, rather than pretending to', async () => {
    // The test environment has no SMTP settings, which is also how the portal
    // ships. Silently dropping messages would leave thirty people waiting for
    // a link that was never coming.
    expect(mailIsConfigured()).toBe(false);

    const result = await sendMail({
      to: 'nobody@test.local',
      subject: 'x',
      text: 'x',
      html: '<p>x</p>',
    });

    expect(result.sent).toBe(false);
    expect(result.sent === false && result.reason).toContain('No mail server is set up');
  });
});

describe('the Send email column', () => {
  it('treats blank as No, so a file nobody filled in sends nothing', () => {
    expect(wantsEmail(undefined)).toBe(false);
    expect(wantsEmail('')).toBe(false);
    expect(wantsEmail('   ')).toBe(false);
    expect(wantsEmail('No')).toBe(false);
    expect(wantsEmail('n')).toBe(false);
  });

  it('accepts the ways somebody actually writes yes', () => {
    for (const yes of ['Yes', 'yes', 'YES', ' y ', 'true', '1', 'Send']) {
      expect(wantsEmail(yes), `${yes} should mean yes`).toBe(true);
    }
  });

  it('treats anything it does not recognise as No', () => {
    // Refusing to guess: "maybe" must not become two hundred emails.
    expect(wantsEmail('maybe')).toBe(false);
    expect(wantsEmail('later')).toBe(false);
  });
});
