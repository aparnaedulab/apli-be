import { env } from '../../config/env.js';

/**
 * Written messages that are sent by hand rather than by an event.
 *
 * Each one is a function of the few things that change - a name, some dates -
 * and nothing else. The wording is fixed here rather than passed in, so that
 * what went out can be read from the repository months later, and so that two
 * people sending the same message send the same message.
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** ["1st October", "5th October"] -> "1st October and 5th October". */
const readableList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// ---------------------------------------------------------------------------
// The shell
//
// Tables, widths as attributes, styles inline. Not because it is 2005, but
// because Outlook still renders mail through Word: it ignores <style> blocks,
// float, flexbox and grid, and collapses divs it does not understand. Tables
// with explicit widths are the one layout every client agrees on.
//
// 600px is the conventional body width - it fits the preview pane of every
// desktop client without a horizontal scrollbar.
// ---------------------------------------------------------------------------

const C = {
  page: '#eef0f4',
  card: '#ffffff',
  rule: '#e4e7ec',
  ink: '#101828',
  body: '#344054',
  muted: '#667085',
  faint: '#98a2b3',
  accent: '#5b2a86',
} as const;

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface ShellOptions {
  /** Preheader: the grey line a client shows after the subject in the list. */
  preview: string;
  /** Sits above the greeting, as the message's own heading. */
  heading: string;
  /** The message body, already escaped, as block-level HTML. */
  body: string;
  /** Overrides MAIL_LOGO_URL for this one message. */
  logoUrl?: string;
  /** Overrides MAIL_ORG_NAME for this one message. */
  orgName?: string;
}

/** Reusable paragraph, so every block in a body has the same rhythm. */
export const p = (html: string): string =>
  `<p style="margin: 0 0 16px; font-family: ${FONT}; font-size: 15px; line-height: 1.65; color: ${C.body};">${html}</p>`;

/**
 * The logo, or the organisation's name set as text when there is no logo URL.
 *
 * An email client will not load a file path, and most block remote images
 * until the reader allows them - so the name is also the alt text, and a
 * message with images turned off still says who it is from.
 */
function header(logoUrl: string | undefined, orgName: string): string {
  const mark = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(orgName)}" height="40"
             style="display: block; height: 40px; width: auto; border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic;" />`
    : `<span style="font-family: ${FONT}; font-size: 19px; font-weight: 700; color: ${C.ink}; letter-spacing: -0.3px;">${escapeHtml(orgName)}</span>`;

  return `        <tr>
          <td style="padding: 32px 40px 8px;">${mark}</td>
        </tr>`;
}

/**
 * The footer.
 *
 * Who sent it, how to reply, and the year - the three things a recipient looks
 * for when deciding whether a message is legitimate. Kept visually quieter
 * than the body so it reads as chrome rather than content.
 */
function footer(orgName: string): string {
  const year = new Date().getFullYear();
  const replyTo = env.MAIL_REPLY_TO;

  const reply = replyTo
    ? `Questions about this message? Write to <a href="mailto:${escapeHtml(replyTo)}" style="color: ${C.accent}; text-decoration: underline;">${escapeHtml(replyTo)}</a>.`
    : 'Questions about this message? Reply to this email and it will reach us.';

  return `        <tr>
          <td style="padding: 24px 40px 32px; background-color: #f7f8fa; border-radius: 0 0 10px 10px;">
            <p style="margin: 0 0 8px; font-family: ${FONT}; font-size: 13px; font-weight: 600; line-height: 1.5; color: ${C.body};">${escapeHtml(orgName)}</p>
            <p style="margin: 0 0 14px; font-family: ${FONT}; font-size: 12px; line-height: 1.6; color: ${C.muted};">${reply}</p>
            <p style="margin: 0; font-family: ${FONT}; font-size: 11px; line-height: 1.6; color: ${C.faint};">&copy; ${year} ${escapeHtml(orgName)}. This message and any attachments are confidential and intended for the named recipient only.</p>
          </td>
        </tr>`;
}

export function emailShell({
  preview,
  heading,
  body,
  logoUrl,
  orgName,
}: ShellOptions): string {
  const org = orgName ?? env.MAIL_ORG_NAME;
  const logo = logoUrl ?? env.MAIL_LOGO_URL;

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(preview)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
</head>
<body style="margin: 0; padding: 0; width: 100%; background-color: ${C.page}; -webkit-font-smoothing: antialiased;">

<!-- Shown in the inbox list beside the subject, never on the page itself. The
     spacer stops the client filling the rest of the line with body text. -->
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${escapeHtml(preview)}</div>
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${C.page};">
  <tr>
    <td align="center" style="padding: 32px 12px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; max-width: 600px; background-color: ${C.card}; border-radius: 10px;">
${header(logo, org)}
        <tr>
          <td style="padding: 36px 40px 32px;">
            <h1 style="margin: 0 0 20px; font-family: ${FONT}; font-size: 20px; font-weight: 600; line-height: 1.35; color: ${C.ink}; letter-spacing: -0.2px;">${escapeHtml(heading)}</h1>
${body}
          </td>
        </tr>
${footer(org)}
      </table>

      <p style="margin: 20px 0 0; font-family: ${FONT}; font-size: 11px; line-height: 1.5; color: ${C.faint};">This is an automated message from ${escapeHtml(org)}.</p>

    </td>
  </tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

export interface LeaveNotApproved {
  /** How the recipient is addressed: "Dear <name>,". */
  name: string;
  /** The dates as they should read in the message - "1st October", "5th October". */
  dates: string[];
  /** Who signs it off. */
  signOff?: string;
  logoUrl?: string;
  orgName?: string;
}

/**
 * HR declining a leave request.
 *
 * The paragraphs are the ones HR approved; only the salutation and the dates
 * move. `subject` is returned alongside the bodies because it carries the
 * dates too, and the two must agree.
 */
export function leaveNotApproved({
  name,
  dates,
  signOff = 'HR Team',
  logoUrl,
  orgName,
}: LeaveNotApproved): { subject: string; text: string; html: string } {
  const when = readableList(dates);

  const paragraphs = [
    `Thank you for submitting your leave request for ${when}.`,
    'After reviewing your request, we regret to inform you that we are unable to approve leave for these dates due to current work pressure. The projects currently assigned to you are top priority and need to be completed within the given timelines. Considering the criticality of these deliverables, we are unable to grant leave on the requested dates at this time.',
    'We understand this may be inconvenient, and we encourage you to plan your leave for a later date once the current workload eases. Please feel free to reach out if you would like to discuss this further or explore alternate dates.',
    'We appreciate your understanding and continued commitment to the team.',
  ];

  const text = [`Dear ${name},`, ...paragraphs, `Best regards,\n${signOff}`].join('\n\n');

  /*
   * The dates, called out of the prose.
   *
   * The one fact the recipient is looking for is which days were refused, and
   * in a wall of four paragraphs it is the hardest thing to find. Repeating it
   * as a panel costs nothing and answers the question before the prose does.
   */
  const panel = `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 24px;">
              <tr>
                <td style="padding: 16px 20px; background-color: #f5f3f9; border-radius: 6px;">
                  <p style="margin: 0 0 3px; font-family: ${FONT}; font-size: 11px; font-weight: 600; line-height: 1.4; color: ${C.muted}; text-transform: uppercase; letter-spacing: 0.6px;">Dates requested</p>
                  <p style="margin: 0; font-family: ${FONT}; font-size: 15px; font-weight: 600; line-height: 1.5; color: ${C.ink};">${escapeHtml(when)}</p>
                </td>
              </tr>
            </table>`;

  const body = [
    p(`Dear ${escapeHtml(name)},`),
    p(escapeHtml(paragraphs[0]!)),
    panel,
    ...paragraphs.slice(1).map((line) => p(escapeHtml(line))),
    `            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0 0;">
              <tr>
                <td style="padding: 20px 0 0;">
                  <p style="margin: 0 0 2px; font-family: ${FONT}; font-size: 15px; line-height: 1.6; color: ${C.body};">Best regards,</p>
                  <p style="margin: 0; font-family: ${FONT}; font-size: 15px; font-weight: 600; line-height: 1.6; color: ${C.ink};">${escapeHtml(signOff)}</p>
                </td>
              </tr>
            </table>`,
  ]
    .map((block) => (block.startsWith('  ') ? block : `            ${block}`))
    .join('\n');

  return {
    subject: `Leave Request - Not Approved (${when})`,
    text,
    html: emailShell({
      preview: `Your leave request for ${when} could not be approved.`,
      heading: 'Leave Request - Not Approved',
      body,
      logoUrl,
      orgName,
    }),
  };
}
