import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { tenantHasModule } from '../tenants/tenant.context.js';

/**
 * The uses of a student's data they are asked about, one by one (DPDP Act:
 * consent must be specific to a purpose, and withdrawable).
 *
 * `neededToApply` purposes are the ones applying cannot work without - a
 * recruiter cannot consider an application it is not allowed to read - so
 * applying asks for them first. Everything else is a free choice.
 */
export interface ConsentPurpose {
  key: string;
  title: string;
  explain: string;
  neededToApply: boolean;
}

export const CONSENT_PURPOSES: ConsentPurpose[] = [
  {
    key: 'share_profile_with_recruiters',
    title: 'Share my profile with companies I apply to',
    explain: 'Your name, contact details, education and projects go to the company - only for roles you apply to.',
    neededToApply: true,
  },
  {
    key: 'share_marks_with_recruiters',
    title: 'Share my verified marks with those companies',
    explain: 'CGPA, percentages and backlogs as your college verified them, so a company can check you meet its bar.',
    neededToApply: true,
  },
  {
    key: 'placement_statistics',
    title: 'Count me in placement statistics',
    explain: 'Your placement result is included, without your name, in the reports your college files with NAAC and NIRF.',
    neededToApply: false,
  },
  {
    key: 'showcase_to_recruiters',
    title: 'Let verified recruiters find my profile',
    explain: 'Recruiters on the platform may see your profile and invite you to apply, even for roles you have not seen.',
    neededToApply: false,
  },
  {
    key: 'contact_on_whatsapp',
    title: 'Send me updates on WhatsApp',
    explain: 'Drive dates, deadlines and application updates on WhatsApp as well as in the app.',
    neededToApply: false,
  },
];

export const PURPOSE_KEYS = new Set(CONSENT_PURPOSES.map((p) => p.key));

/** The current answer per purpose: the latest record wins. */
export async function currentConsents(candidateId: string): Promise<Record<string, { granted: boolean; at: Date } | null>> {
  const rows = await prisma.consentRecord.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    select: { purpose: true, granted: true, createdAt: true },
  });
  const out: Record<string, { granted: boolean; at: Date } | null> = {};
  for (const p of CONSENT_PURPOSES) out[p.key] = null;
  for (const r of rows) {
    if (out[r.purpose] === null) out[r.purpose] = { granted: r.granted, at: r.createdAt };
  }
  return out;
}

/**
 * Refuses an application until the student has agreed to what applying
 * needs - but only where the institution has the consent centre switched on.
 * Elsewhere applying works exactly as it always has.
 *
 * The refusal names the purposes, so the screen can ask for exactly those.
 */
export async function assertApplyConsent(candidateId: string, tenantId: string | undefined): Promise<void> {
  if (!(await tenantHasModule(tenantId, 'compliance.consent'))) return;
  const current = await currentConsents(candidateId);
  const missing = CONSENT_PURPOSES.filter((p) => p.neededToApply && current[p.key]?.granted !== true);
  if (missing.length > 0) {
    throw new AppError(
      409,
      'CONSENT_REQUIRED',
      'Before you apply, allow your profile and verified marks to be shared with the companies you apply to.',
      { purposes: missing.map((p) => p.key) },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The consent centre's own reads and writes                                   */
/* -------------------------------------------------------------------------- */

/** Appends one record per answer, in one transaction, so a bulk grant is all-or-nothing. */
export async function recordConsents(candidateId: string, grants: Record<string, boolean>): Promise<void> {
  const rows = Object.entries(grants)
    .filter(([purpose]) => PURPOSE_KEYS.has(purpose))
    .map(([purpose, granted]) => ({ candidateId, purpose, granted }));
  if (rows.length === 0) return;
  await prisma.$transaction(rows.map((data) => prisma.consentRecord.create({ data })));
}

/** Every purpose, with the student's current answer and everything they said before it. */
export async function consentOverview(candidateId: string) {
  const rows = await prisma.consentRecord.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    select: { purpose: true, granted: true, createdAt: true },
  });

  return CONSENT_PURPOSES.map((p) => {
    const history = rows.filter((r) => r.purpose === p.key).map((r) => ({ granted: r.granted, at: r.createdAt }));
    return {
      ...p,
      granted: history[0]?.granted ?? null,
      changedAt: history[0]?.at ?? null,
      history,
    };
  });
}

/**
 * How a college's students have answered, per purpose - counts, never names.
 *
 * "Withdrew" is a student whose latest answer is no after an earlier yes: the
 * difference between somebody who changed their mind and somebody who was
 * never asked matters to a placement officer chasing a report.
 */
export async function collegeConsentCounts(collegeId: string) {
  const students = await prisma.candidate.findMany({ where: { collegeId }, select: { id: true } });
  const ids = students.map((s) => s.id);
  const rows = ids.length
    ? await prisma.consentRecord.findMany({
        where: { candidateId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: { candidateId: true, purpose: true, granted: true },
      })
    : [];

  return CONSENT_PURPOSES.map((p) => {
    const seen = new Map<string, boolean[]>();
    for (const r of rows) {
      if (r.purpose !== p.key) continue;
      seen.set(r.candidateId, [...(seen.get(r.candidateId) ?? []), r.granted]);
    }
    let granted = 0;
    let withdrew = 0;
    let declined = 0;
    for (const answers of seen.values()) {
      if (answers[0]) granted++;
      else if (answers.slice(1).some(Boolean)) withdrew++;
      else declined++;
    }
    return {
      key: p.key,
      title: p.title,
      neededToApply: p.neededToApply,
      students: ids.length,
      granted,
      withdrew,
      declined,
      neverAnswered: ids.length - seen.size,
    };
  });
}
