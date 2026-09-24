import { TenantStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { sendMail, type MailResult } from '../../lib/mailer.js';

/**
 * The invitation email.
 *
 * It carries a bearer token in a URL, so it is written as a plain, boring
 * message: who it is from, what it is for, what it lets you do, and when it
 * stops working. Nothing about it should read like the phishing mail it
 * unavoidably resembles - no urgency, no branding tricks, no shortened link,
 * and the address the recipient can check is the one they already know.
 */

export interface InviteEmail {
  to: string;
  /** Empty for an invitation that went out with no name attached. */
  name: string;
  link: string;
  /** The role they are being given, in the words the admin chose. */
  role: string;
  /** The college, the company, or the university as a whole. */
  where: string;
  expiresAt: Date;
  /** Who sent it, so the recipient knows who to ask. */
  invitedBy: string;
  /**
   * Whose portal this is - the institution's name, or "Apli.ai" for a company.
   * Falls back to HOME_UNIVERSITY for the rare invitation that belongs to no
   * institution at all.
   */
  portalName?: string;
  /** The institution's own sign-in address, /t/<slug>, once it is live. */
  portalUrl?: string;
}

/** What a company's invitation is signed as: it belongs to the platform, not one institution. */
export const PLATFORM_PORTAL = { portalName: 'Apli.ai' } as const;

/**
 * The name and address an invitation should carry for an institution.
 *
 * The address is only offered for a live institution: a draft one's page
 * does not exist yet, and a suspended one's is closed.
 */
export async function portalFor(
  tenantId: string | null | undefined,
): Promise<{ portalName?: string; portalUrl?: string }> {
  if (!tenantId) return {};
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, slug: true, status: true },
  });
  if (!tenant) return {};
  return {
    portalName: tenant.name,
    portalUrl:
      tenant.status === TenantStatus.ACTIVE
        ? `${env.CLIENT_ORIGIN.replace(/\/+$/, '')}/t/${tenant.slug}`
        : undefined,
  };
}

const DAY = 24 * 60 * 60 * 1000;

function daysLeft(expiresAt: Date): string {
  const days = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / DAY));
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function buildInviteEmail(invite: InviteEmail) {
  const greeting = invite.name ? `Hello ${invite.name},` : 'Hello,';
  const expiry = daysLeft(invite.expiresAt);
  const replyTo = env.MAIL_REPLY_TO;
  const portal = invite.portalName || env.HOME_UNIVERSITY;
  // "Apli.ai placement portal login" reads fine; so does "SPPU placement
  // portal login". The same sentence serves both.
  const subject = `Your ${portal} placement portal login`;

  const text = [
    greeting,
    '',
    `${invite.invitedBy} has set up an account for you on the ${portal} placement portal.`,
    '',
    `  Your role:  ${invite.role}`,
    `  Working in: ${invite.where}`,
    '',
    'Open this link to choose your password and sign in:',
    '',
    invite.link,
    '',
    `The link works once and stops working ${expiry}. Nobody, including the person who invited you, can see the password you choose.`,
    '',
    replyTo
      ? `If you were not expecting this, reply to ${replyTo} and the invitation will be cancelled.`
      : 'If you were not expecting this, tell whoever sent it and the invitation will be cancelled.',
    '',
    ...(invite.portalUrl ? ['', `Your portal, for signing in from now on: ${invite.portalUrl}`] : []),
    '',
    `— ${portal} placement portal`,
  ].join('\n');

  // Deliberately plain HTML: inline styles, a real anchor showing its own URL,
  // and a table nobody needs a wide screen to read. Mail clients strip almost
  // everything else, and a link that hides where it goes teaches exactly the
  // habit that gets people phished.
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f4f0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#14161c;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ec;border-radius:10px;padding:28px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">${escape(greeting)}</p>

      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        ${escape(invite.invitedBy)} has set up an account for you on the
        ${escape(portal)} placement portal.
      </p>

      <table style="width:100%;border-collapse:collapse;margin:0 0 24px;font-size:14px;">
        <tr>
          <td style="padding:8px 0;color:#52596a;width:110px;">Your role</td>
          <td style="padding:8px 0;font-weight:600;">${escape(invite.role)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#52596a;">Working in</td>
          <td style="padding:8px 0;font-weight:600;">${escape(invite.where)}</td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">
        Open this link to choose your password and sign in:
      </p>

      <p style="margin:0 0 20px;">
        <a href="${escape(invite.link)}"
           style="display:inline-block;background:#1d3b8b;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:7px;font-size:15px;font-weight:600;">
          Set your password
        </a>
      </p>

      <p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#52596a;word-break:break-all;">
        Or paste this into your browser:<br />
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escape(invite.link)}</span>
      </p>

      <p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#52596a;">
        The link works once and stops working ${escape(expiry)}. Nobody &mdash; including the
        person who invited you &mdash; can see the password you choose.
      </p>

      ${
        invite.portalUrl
          ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#52596a;">Your portal, for signing in from now on: <a href="${escape(invite.portalUrl)}" style="color:#1d3b8b;">${escape(invite.portalUrl)}</a></p>`
          : ''
      }

      <p style="margin:0;font-size:13px;line-height:1.55;color:#52596a;">
        ${
          replyTo
            ? `If you were not expecting this, reply to <a href="mailto:${escape(replyTo)}" style="color:#1d3b8b;">${escape(replyTo)}</a> and the invitation will be cancelled.`
            : 'If you were not expecting this, tell whoever sent it and the invitation will be cancelled.'
        }
      </p>
    </div>

    <p style="max-width:560px;margin:14px auto 0;font-size:12px;color:#858da0;text-align:center;">
      ${escape(portal)} placement portal
    </p>
  </body>
</html>`;

  return { to: invite.to, subject, text, html };
}

/** Builds and sends one invitation. Never throws; the reason comes back. */
export function sendInviteEmail(invite: InviteEmail): Promise<MailResult> {
  return sendMail(buildInviteEmail(invite));
}
