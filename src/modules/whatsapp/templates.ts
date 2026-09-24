import { env } from '../../config/env.js';

/**
 * Which in-app notifications are worth a WhatsApp message, and the approved
 * template each one goes out as.
 *
 * An allowlist, deliberately short. WhatsApp is where students actually read
 * things, which is exactly why it must not become noise: only news a student
 * would want the moment it happens - a round moved, an offer, a result, an
 * invitation, a note from their placement cell. "Your application is under
 * review" and "closed because you accepted another offer" stay in the app.
 *
 * Every template must be approved in Meta Business Manager before it can be
 * sent, with two body parameters: {{1}} a short title and {{2}} the message.
 */
export const WHATSAPP_TYPES: Record<string, string> = {
  // From the hiring pipeline (applications/state.ts).
  // Being shortlisted is the message a student most wants to be told without
  // having to open the portal to find it.
  'application.shortlisted': 'apli_application_update',
  'application.in_round': 'apli_application_update',
  'application.waitlisted': 'apli_application_update',
  'application.offered': 'apli_offer_update',
  'application.hired': 'apli_offer_update',
  'application.rejected': 'apli_application_update',
  // A test with a date on it is the thing students most often miss, and the
  // portal is not where they find out about it in time.
  'assessment.assigned': 'apli_application_update',
  // A recruiter inviting a student to apply (community).
  SHOWCASE_INVITE: 'apli_invite_to_apply',
  // A note from the placement cell (ops, at-risk nudges).
  'placement_cell.check_in': 'apli_placement_cell_note',
};

export const ALLOWED_TYPES = Object.keys(WHATSAPP_TYPES);

/** Overrides from WHATSAPP_TEMPLATES, read once; a malformed value is ignored, not fatal. */
function overrides(): Record<string, string> {
  if (!env.WHATSAPP_TEMPLATES) return {};
  try {
    const parsed = JSON.parse(env.WHATSAPP_TEMPLATES) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0,
      ),
    );
  } catch {
    console.warn('[whatsapp] WHATSAPP_TEMPLATES is not valid JSON; using the default template names.');
    return {};
  }
}

const OVERRIDES = overrides();

export function templateFor(type: string): string | null {
  if (!(type in WHATSAPP_TYPES)) return null;
  return OVERRIDES[type] ?? WHATSAPP_TYPES[type]!;
}

/** Template parameters have a length cap; a long body is cut, never dropped. */
export function templateParams(title: string, body: string | null): string[] {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  // Newlines and runs of spaces are refused inside WhatsApp template parameters.
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  return [clip(flat(title), 60), clip(flat(body ?? title), 900)];
}
