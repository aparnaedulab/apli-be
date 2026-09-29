import { env } from '../config/env.js';
import type { MailMessage, MailResult } from './mailer.js';

/**
 * Sending mail through the notification service rather than a mail server.
 *
 * The same contract as lib/mailer.ts: never throws, and every failure comes
 * back as a reason the caller can show. A request that leaves this file has
 * already been decided on - whether to use this path at all is mailer.ts's
 * job, not this one's.
 *
 * ---------------------------------------------------------------------------
 * ASSUMED WIRE FORMAT. The service's own contract has not been supplied yet,
 * so this sends what such an endpoint almost always takes:
 *
 *   POST <EMAIL_SNS_URL>
 *   Authorization: Bearer <EMAIL_SNS_TOKEN>
 *   Content-Type: application/json
 *   { from, to, subject, text, html, attachments? }
 *
 * If the real service differs, the two places to change are `headers()` and
 * the body built in `sendViaSns` - nothing else here or in the routes depends
 * on the shape.
 * ---------------------------------------------------------------------------
 */

/** Both halves, or nothing: a URL with no token cannot authenticate. */
export function snsIsConfigured(): boolean {
  return Boolean(env.EMAIL_SNS_URL && env.EMAIL_SNS_TOKEN);
}

export function attachmentsAreConfigured(): boolean {
  return Boolean(env.EMAIL_ATTACHMENT_URL && env.EMAIL_ATTACHMENT_TOKEN);
}

const headers = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

/** A reference the service gave us, to be named in a later send. */
export interface AttachmentRef {
  id: string;
  name: string;
}

/** The send request, as this module builds it. */
export interface SnsMessage extends MailMessage {
  attachments?: AttachmentRef[];
}

/**
 * Whatever the service said, in a form worth showing someone.
 *
 * A failing HTTP call reports its status and body rather than "request
 * failed": a 401 and a 422 need completely different fixes, and the body
 * usually names which field it objected to.
 */
async function describe(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  const trimmed = body.trim().slice(0, 500);
  return trimmed ? `${res.status} ${res.statusText}: ${trimmed}` : `${res.status} ${res.statusText}`;
}

export async function sendViaSns(message: SnsMessage): Promise<MailResult> {
  if (!env.EMAIL_SNS_URL || !env.EMAIL_SNS_TOKEN) {
    return { sent: false, reason: 'The notification service is not configured on this portal.' };
  }

  const field = env.EMAIL_SNS_HTML_FIELD;

  /*
   * Where the HTML goes.
   *
   * Normally `html`, with the plain text alongside it as the alternative part
   * every mail client expects. When the service has no `html` field and
   * renders its body field as HTML instead, the two would fight: whichever it
   * reads wins, and sending plain text there is what produces a message with
   * its paragraphs run together. So in that case the HTML goes in that field
   * and no separate text part is sent - there is nowhere for it to go.
   */
  const body =
    field === 'html'
      ? { text: message.text, html: message.html }
      : { [field]: message.html };

  const payload = {
    from: message.from ?? env.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    ...body,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  } as Record<string, unknown>;

  /*
   * What we sent, by field and size.
   *
   * A service that ignores a field it does not recognise looks exactly like
   * one that received nothing: the send succeeds and the message arrives
   * wrong. Logging the html length here is what distinguishes "we never built
   * the html" from "we sent 3 KB of html and the service dropped it".
   */
  console.log(
    `[mail:sns] -> ${env.EMAIL_SNS_URL} fields=${Object.keys(payload).join(',')} ` +
      `htmlField=${field} html=${message.html.length}b`,
  );

  try {
    const res = await fetch(env.EMAIL_SNS_URL, {
      method: 'POST',
      headers: headers(env.EMAIL_SNS_TOKEN),
      body: JSON.stringify(payload),
      // A send that has not answered in 30s is not going to. Without this the
      // request can hang until Node gives up, holding the HTTP handler open.
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const reason = await describe(res);
      console.error(`[mail:sns] ${message.to}: ${reason}`);
      return { sent: false, reason: `The notification service refused it: ${reason}` };
    }

    /*
     * The service's own answer, logged on every send.
     *
     * A 2xx here usually means "queued", not "delivered" - the actual send
     * happens later and its outcome never reaches this process. When a
     * message is accepted and then never arrives, this line and the id in it
     * are the only things that can be traced in the service's own logs.
     */
    const body = (await res.text().catch(() => '')).trim().slice(0, 500);
    console.log(`[mail:sns] ${message.to}: ${res.status} ${body}`);

    return { sent: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'The notification service could not be reached.';
    console.error(`[mail:sns] ${message.to}: ${reason}`);
    return { sent: false, reason: `The notification service could not be reached: ${reason}` };
  }
}

export type UploadResult =
  | { uploaded: true; attachment: AttachmentRef }
  | { uploaded: false; reason: string };

/**
 * Puts a file where the service can reach it and returns the reference to name
 * in a send. Sent as multipart, because that is what a file endpoint takes;
 * the token goes in the header either way.
 */
export async function uploadAttachment(
  file: { buffer: Buffer; name: string; contentType: string },
): Promise<UploadResult> {
  if (!env.EMAIL_ATTACHMENT_URL || !env.EMAIL_ATTACHMENT_TOKEN) {
    return { uploaded: false, reason: 'Attachments are not configured on this portal.' };
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.contentType }), file.name);

    const res = await fetch(env.EMAIL_ATTACHMENT_URL, {
      method: 'POST',
      // No Content-Type: fetch sets it, with the multipart boundary, which
      // cannot be written by hand.
      headers: { Authorization: `Bearer ${env.EMAIL_ATTACHMENT_TOKEN}`, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const reason = await describe(res);
      console.error(`[mail:attachment] ${file.name}: ${reason}`);
      return { uploaded: false, reason: `The attachment service refused it: ${reason}` };
    }

    // The field naming the reference is the other thing the real contract may
    // spell differently; the usual candidates are covered.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const id = body.id ?? body.attachmentId ?? body.fileId ?? body.key ?? body.url;

    if (typeof id !== 'string' || !id) {
      return {
        uploaded: false,
        reason: 'The attachment service accepted the file but returned no reference to it.',
      };
    }

    return { uploaded: true, attachment: { id, name: file.name } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'The attachment service could not be reached.';
    console.error(`[mail:attachment] ${file.name}: ${reason}`);
    return { uploaded: false, reason: `The attachment service could not be reached: ${reason}` };
  }
}
