import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { currentConsents } from '../consent/consent.service.js';
import { maskNumber, normaliseIndianMobile } from './phone.js';
import { currentProvider, NOT_SET_UP, type WhatsAppProvider } from './provider.js';
import { ALLOWED_TYPES, templateFor, templateParams } from './templates.js';

/**
 * Copies important in-app notifications to WhatsApp.
 *
 * Notifications are created in many places - the hiring pipeline, recruiter
 * invites, nudges from the placement cell - and none of them should have to
 * know WhatsApp exists. So instead of a hook in each, this runs on a timer and
 * looks back over what was created recently. The unique notificationId on
 * WhatsAppMessage is what makes that safe: a restart, an overlapping run or a
 * second server can never send the same notification twice.
 *
 * A message goes only when all of these hold, checked in this order:
 *   the notification type is on the allowlist (templates.ts);
 *   the student's institution has channel.whatsapp switched on;
 *   the student has allowed WhatsApp updates (consent 'contact_on_whatsapp');
 *   the student has a valid Indian mobile number.
 * A student who fails the last two is logged as SKIPPED with the reason, so
 * their college can see why; an institution without the module is simply not
 * looked at.
 */

const MODULE = 'channel.whatsapp';
const CONSENT = 'contact_on_whatsapp';

/** How far back a run looks. Old news is not worth a message. */
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const BATCH = 200;

export interface RunSummary {
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** The institutions that have WhatsApp on - nothing else is ever read. */
async function enabledTenants(): Promise<string[]> {
  const rows = await prisma.tenantModule.findMany({
    where: { moduleKey: MODULE, enabled: true },
    select: { tenantId: true },
  });
  return rows.map((r) => r.tenantId);
}

export async function runOnce(
  opts: { provider?: WhatsAppProvider; now?: Date; lookbackMs?: number } = {},
): Promise<RunSummary> {
  const summary: RunSummary = { considered: 0, sent: 0, failed: 0, skipped: 0 };
  const tenants = await enabledTenants();
  if (tenants.length === 0) return summary;

  const provider = opts.provider ?? currentProvider();
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.lookbackMs ?? LOOKBACK_MS));

  const notifications = await prisma.notification.findMany({
    where: {
      type: { in: ALLOWED_TYPES },
      createdAt: { gte: since, lte: now },
      user: {
        role: Role.CANDIDATE,
        candidate: {
          is: {
            OR: [
              { college: { tenantId: { in: tenants } } },
              { collegeId: null, batchMemberships: { some: { batch: { tenantId: { in: tenants } } } } },
            ],
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH * 2,
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      user: {
        select: {
          candidate: {
            select: {
              id: true,
              phone: true,
              college: { select: { tenantId: true } },
              batchMemberships: { select: { batch: { select: { tenantId: true } } }, take: 1 },
            },
          },
        },
      },
    },
  });

  if (notifications.length === 0) return summary;

  // Already handled - sent, failed or skipped - by an earlier run.
  const done = new Set(
    (
      await prisma.whatsAppMessage.findMany({
        where: { notificationId: { in: notifications.map((n) => n.id) } },
        select: { notificationId: true },
      })
    ).map((m) => m.notificationId),
  );

  const pending = notifications.filter((n) => !done.has(n.id)).slice(0, BATCH);
  const consentCache = new Map<string, boolean>();

  for (const n of pending) {
    const candidate = n.user.candidate;
    const template = templateFor(n.type);
    if (!candidate || !template) continue;
    summary.considered += 1;

    const tenantId = candidate.college?.tenantId ?? candidate.batchMemberships[0]?.batch.tenantId ?? null;

    let consented = consentCache.get(candidate.id);
    if (consented === undefined) {
      consented = (await currentConsents(candidate.id))[CONSENT]?.granted === true;
      consentCache.set(candidate.id, consented);
    }

    const number = normaliseIndianMobile(candidate.phone);
    const toMasked = maskNumber(number.ok ? number.e164 : candidate.phone);

    const skipReason = !consented
      ? 'The student has not allowed WhatsApp updates.'
      : !number.ok
        ? number.reason
        : !provider.configured
          ? NOT_SET_UP
          : null;

    // The row is claimed first. If another run got there a moment earlier,
    // the unique notificationId refuses this insert and we move on.
    let record;
    try {
      record = await prisma.whatsAppMessage.create({
        data: {
          candidateId: candidate.id,
          tenantId,
          notificationId: n.id,
          template,
          toMasked,
          status: skipReason ? 'SKIPPED' : 'QUEUED',
          error: skipReason,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }

    if (skipReason || !number.ok) {
      summary.skipped += 1;
      continue;
    }

    const result = await provider.send({
      to: number.e164,
      template,
      lang: env.WHATSAPP_TEMPLATE_LANG,
      params: templateParams(n.title, n.body),
    });

    await prisma.whatsAppMessage.update({
      where: { id: record.id },
      data: result.ok ? { status: 'SENT', error: null } : { status: 'FAILED', error: result.error.slice(0, 1000) },
    });
    if (result.ok) summary.sent += 1;
    else summary.failed += 1;
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* The timer                                                                   */
/* -------------------------------------------------------------------------- */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Starts the minute-by-minute dispatcher. One run at a time: a slow run is
 * never overlapped by the next tick. Errors are logged and the next tick
 * tries again - a WhatsApp outage must never take the portal down.
 */
export function startWhatsAppDispatcher(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const s = await runOnce();
      if (s.sent || s.failed) console.log(`[whatsapp] sent ${s.sent}, failed ${s.failed}, skipped ${s.skipped}`);
    } catch (err) {
      console.error('[whatsapp] dispatcher run failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, intervalMs);
  // The timer alone should never keep the process alive.
  timer.unref();
}

export function stopWhatsAppDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
