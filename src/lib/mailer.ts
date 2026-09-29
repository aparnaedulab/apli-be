import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { sendViaSns, snsIsConfigured } from './mailSns.js';

/**
 * Sending email.
 *
 * Two rules shape everything here.
 *
 * The first: sending never throws. An invitation that exists in the database
 * is real whether or not the message left the building, and a mail server
 * having a bad afternoon must not roll back thirty accounts that were created
 * successfully. Every failure comes back as a reason the caller can show.
 *
 * The second: a deployment with no mail settings says so, out loud, on every
 * attempt. Silently dropping messages would mean thirty people waiting for a
 * link that was never coming, and nobody finding out for a week.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Who it comes from, when it is not the portal itself. Left out, it is
   * MAIL_FROM - which is what every automatic message uses. Most relays will
   * only accept a sender on a domain they are authorised for, so setting this
   * to an unrelated address usually fails at the mail server, not here.
   */
  from?: string;
}

export type MailResult = { sent: true } | { sent: false; reason: string };

const NOT_CONFIGURED =
  'No mail server is set up on this portal, so nothing was sent. Copy the link and send it yourself, or ask whoever runs the server to fill in the SMTP settings.';

let transport: Transporter | null = null;

/** Whether this deployment can send anything at all, by any route. */
export function mailIsConfigured(): boolean {
  return Boolean(env.SMTP_URL || env.SMTP_HOST) || snsIsConfigured();
}

/**
 * Which way a message goes out. SMTP wins when both are set, so adding the
 * notification service to a working deployment changes nothing until the SMTP
 * settings come out.
 */
export function mailTransportName(): 'smtp' | 'sns' | null {
  if (env.SMTP_URL || env.SMTP_HOST) return 'smtp';
  return snsIsConfigured() ? 'sns' : null;
}

/** Who messages come from, for the UI to show before anybody commits to sending. */
export function mailFrom(): string | null {
  return mailIsConfigured() ? env.MAIL_FROM : null;
}

function transporter(): Transporter {
  if (transport) return transport;

  transport = env.SMTP_URL
    ? nodemailer.createTransport(env.SMTP_URL)
    : nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        // Implicit TLS on 465, STARTTLS on everything else - the split every
        // mail provider assumes, so it is not worth a separate setting.
        secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
        ...(env.SMTP_USER
          ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
          : {}),
      });

  return transport;
}

export async function sendMail(message: MailMessage): Promise<MailResult> {
  if (!mailIsConfigured()) return { sent: false, reason: NOT_CONFIGURED };

  // No SMTP settings but a notification service configured: out over HTTP.
  // Same contract either way, so nothing that calls sendMail has to know.
  if (mailTransportName() === 'sns') return sendViaSns(message);

  try {
    const info = await transporter().sendMail({
      from: message.from ?? env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    /*
     * What the relay actually said, logged on every send.
     *
     * "Accepted" is only ever the relay's word: it has taken responsibility
     * for the message, not delivered it. A recipient can still be in
     * `rejected`, and a queued-then-bounced message looks identical here to
     * one that arrived. Without this line, "the API returned 200 but nothing
     * came" has no evidence behind it at all.
     */
    console.log(
      `[mail] ${message.to}: id=${info.messageId} accepted=${JSON.stringify(info.accepted)} ` +
        `rejected=${JSON.stringify(info.rejected)} response=${String(info.response ?? '').trim()}`,
    );

    // The relay took it but named this recipient as refused - which is a
    // failure, however encouraging the rest of the response looks.
    if (info.rejected?.length) {
      return {
        sent: false,
        reason: `The mail server refused the recipient: ${info.rejected.join(', ')}. ${String(info.response ?? '').trim()}`,
      };
    }

    return { sent: true };
  } catch (err) {
    // The reason is shown to whoever pressed the button, so it says what the
    // server actually reported rather than "something went wrong".
    const reason = err instanceof Error ? err.message : 'The mail server refused the message.';
    console.error(`[mail] ${message.to}: ${reason}`);
    return { sent: false, reason: `The mail server refused it: ${reason}` };
  }
}

/** Sends to several addresses, one at a time, and never gives up on the rest. */
export async function sendEach<T>(
  items: T[],
  build: (item: T) => MailMessage,
): Promise<Map<T, MailResult>> {
  const results = new Map<T, MailResult>();

  // Deliberately sequential. A university SMTP relay will throttle or block a
  // burst of two hundred parallel connections, and a file of two hundred
  // invitations is not worth being rate-limited over.
  for (const item of items) {
    results.set(item, await sendMail(build(item)));
  }

  return results;
}

/** Drops the cached transport, so tests and settings changes start fresh. */
export function resetMailer(): void {
  transport = null;
}
