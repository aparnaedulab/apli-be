import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { sendMail, type MailResult } from '../../lib/mailer.js';
import { emailShell, p } from '../mail/mail.templates.js';

/**
 * The email a student gets on signing up - only when their institution has
 * switched it on in onboarding (Features, Students). Students whose college
 * is not on Apli.ai belong to no institution and are not sent one.
 *
 * It asks nothing and carries no token: it says they are in, where to go,
 * and that their details stay private. Sending it never holds up, or fails,
 * the sign-up itself.
 */

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildWelcomeEmail({ name, portalName, link }: { name: string; portalName: string; link: string }) {
  const first = name.trim().split(/\s+/)[0] || 'there';
  const subject = `Welcome to ${portalName}`;
  const lines = [
    `Your student account is ready. You can start a work simulation whenever you like - each one is a few short tasks set by a real team, done at your own pace.`,
    `Your profile is private. No company sees your details until you choose to share them.`,
  ];
  const text = [`Hello ${first},`, ...lines, `Sign in: ${link}`, `- ${portalName}`].join('\n\n');
  const html = emailShell({
    preview: `Your ${portalName} account is ready.`,
    heading: `Welcome, ${first}`,
    orgName: portalName,
    body: [
      ...lines.map((l) => p(escape(l))),
      p(`<a href="${escape(link)}">Sign in to start</a>`),
    ].join('\n'),
  });
  return { subject, text, html };
}

/** Sends the welcome email if the student's institution wants one. Never throws. */
export async function welcomeStudent(input: {
  email: string;
  name: string;
  tenantId: string | null;
}): Promise<MailResult | null> {
  if (!input.tenantId) return null;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { name: true, studentWelcomeEmail: true },
    });
    if (!tenant?.studentWelcomeEmail) return null;

    const link = `${env.CLIENT_ORIGIN.replace(/\/+$/, '')}/login`;
    return await sendMail({ to: input.email, ...buildWelcomeEmail({ name: input.name, portalName: tenant.name, link }) });
  } catch {
    return { sent: false, reason: 'The welcome email could not be sent.' };
  }
}
