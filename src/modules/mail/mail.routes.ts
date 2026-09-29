import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { mailFrom, mailIsConfigured, mailTransportName, sendMail } from '../../lib/mailer.js';
import { attachmentsAreConfigured } from '../../lib/mailSns.js';
import { leaveNotApproved } from './mail.templates.js';

/**
 * Sending a message directly.
 *
 * Everywhere else, mail is a consequence of something - an invitation was
 * created, an offer was accepted - and the message is built from that record.
 * This route has no record behind it: the caller says what to send and it is
 * sent. That makes it useful for checking SMTP settings from Postman, and it
 * makes it the one route on the portal that would happily relay anything for
 * anybody.
 *
 * These routes are deliberately OPEN - no session, no role - so they can be
 * driven straight from Postman. That means anything able to reach this API can
 * send mail through this server. It is a testing arrangement for a VM that is
 * not on the public internet; see the note beside the entries in
 * PUBLIC_ROUTES in middleware/auth.ts, and put `requireRole('ADMIN')` back on
 * each route before this deployment is reachable from outside.
 *
 * `from` may be set per request, for messages sent on behalf of a department
 * rather than the portal - HR writing to a colleague, say. Left out it is
 * MAIL_FROM. Note that most relays only accept senders on a domain they are
 * authorised for, so an unrelated address is usually refused by the mail
 * server rather than delivered.
 */
export const mailRouter = Router();

/**
 * GET /api/mail/status - can this deployment send at all, and as whom.
 *
 * Worth calling first. A 200 saying `configured: false` means the SMTP
 * settings are missing, which is a different problem from a message the mail
 * server rejected, and the two are easy to confuse from a failed send alone.
 */
mailRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({
      configured: mailIsConfigured(),
      from: mailFrom(),
      transport: mailTransportName(),
      attachments: attachmentsAreConfigured(),
    });
  }),
);

/** Shared by every route here: who it goes to, and who it claims to be from. */
const addressing = {
  to: z.string().trim().email('Give a valid address to send to.'),
  from: z.string().trim().email('The sender must be a valid address.').optional(),
};

const sendSchema = z
  .object({
    ...addressing,
    subject: z.string().trim().min(1, 'A message needs a subject.'),
    text: z.string().optional(),
    html: z.string().optional(),
  })
  // Both bodies are optional individually, but a message with neither is an
  // empty envelope. Nodemailer would send it quite happily.
  .refine((m) => Boolean(m.text?.trim() || m.html?.trim()), {
    message: 'A message needs a body - send text, html, or both.',
    path: ['text'],
  });

/** Crude, and only ever a fallback for a caller who sent html and no text. */
const toPlainText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * POST /api/mail/send - one message, to one address.
 *
 * Sending never throws (see lib/mailer.ts), so a refusal by the mail server
 * comes back as a reason rather than a stack trace. That reason is reported as
 * 502: the request was fine, the thing downstream of us was not.
 */
mailRouter.post(
  '/send',
  asyncHandler(async (req, res) => {
    const { to, from, subject, text, html } = sendSchema.parse(req.body);

    // Both parts are always filled. A text/plain alternative is what stops a
    // message looking like spam to half the filters that will see it.
    const result = await sendMail({
      to,
      from,
      subject,
      text: text?.trim() || toPlainText(html ?? ''),
      html: html?.trim() || `<p>${escapeHtml(text ?? '').replace(/\n/g, '<br />')}</p>`,
    });

    if (!result.sent) {
      res.status(502).json({ sent: false, to, reason: result.reason });
      return;
    }

    res.json({ sent: true, to, from: from ?? mailFrom() });
  }),
);

const leaveSchema = z.object({
  ...addressing,
  name: z.string().trim().min(1, 'Say who the message is addressed to.'),
  dates: z
    .array(z.string().trim().min(1))
    .min(1, 'Give at least one date, as it should read in the message.'),
  /** Overrides the subject the template builds from the dates. */
  subject: z.string().trim().min(1).optional(),
  /** Who signs it off, under "Best regards,". */
  signOff: z.string().trim().min(1).optional(),
  /** Branding, when this message is not from the portal itself. */
  logoUrl: z.string().trim().url('The logo must be a full public URL.').optional(),
  orgName: z.string().trim().min(1).optional(),
});

/**
 * POST /api/mail/templates/leave-not-approved - HR declining a leave request.
 *
 * The wording lives in mail.templates.ts and is not accepted from the request.
 * Only the salutation and the dates change, so only those are parameters -
 * which means the message a colleague receives is the one HR signed off on,
 * whoever pressed send.
 */
mailRouter.post(
  '/templates/leave-not-approved',
  asyncHandler(async (req, res) => {
    const { to, from, name, dates, subject, signOff, logoUrl, orgName } = leaveSchema.parse(
      req.body,
    );
    const message = leaveNotApproved({ name, dates, signOff, logoUrl, orgName });

    const result = await sendMail({
      to,
      from,
      subject: subject ?? message.subject,
      text: message.text,
      html: message.html,
    });

    if (!result.sent) {
      res.status(502).json({ sent: false, to, reason: result.reason });
      return;
    }

    res.json({ sent: true, to, from: from ?? mailFrom(), subject: subject ?? message.subject });
  }),
);

/**
 * GET /api/mail/templates/leave-not-approved/preview - the rendered message,
 * without sending it. Worth a look before mailing a colleague.
 */
mailRouter.get(
  '/templates/leave-not-approved/preview',
  asyncHandler(async (req, res) => {
    const { name, dates, signOff, logoUrl, orgName, format } = z
      .object({
        name: z.string().trim().min(1, 'Say who the message is addressed to.'),
        dates: z
          .string()
          .trim()
          .min(1, 'Give at least one date, comma separated.')
          .transform((d) => d.split(',').map((s) => s.trim()).filter(Boolean)),
        signOff: z.string().trim().min(1).optional(),
        logoUrl: z.string().trim().url().optional(),
        orgName: z.string().trim().min(1).optional(),
        /** `html` renders it in the browser; anything else returns all parts. */
        format: z.enum(['json', 'html']).default('json'),
      })
      .parse(req.query);

    const message = leaveNotApproved({ name, dates, signOff, logoUrl, orgName });

    if (format === 'html') {
      // Rendered rather than described: a layout is far easier to judge as a
      // page than as an escaped string in a JSON field.
      res.type('html').send(message.html);
      return;
    }

    res.json(message);
  }),
);
