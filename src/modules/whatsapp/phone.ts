/**
 * Indian mobile numbers, as rosters actually hold them.
 *
 * A class list has "9000000000", "+91 90000 00000", "090000-00000" and
 * "0091 9000000000" in the same column. WhatsApp needs one exact form -
 * country code and number, digits only - so everything is reduced to E.164
 * first, and a number that cannot be a mobile is refused with a reason a
 * placement officer can act on rather than sent into a void.
 */

export type Normalised = { ok: true; e164: string } | { ok: false; reason: string };

export function normaliseIndianMobile(raw: string | null | undefined): Normalised {
  if (!raw || !raw.trim()) return { ok: false, reason: 'No mobile number on the student’s record.' };

  let digits = raw.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return { ok: false, reason: 'The mobile number has letters or symbols in it.' };

  if (digits.startsWith('+')) {
    if (!digits.startsWith('+91')) return { ok: false, reason: 'Only Indian (+91) mobile numbers can be messaged.' };
    digits = digits.slice(3);
  } else if (digits.startsWith('0091')) {
    digits = digits.slice(4);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) return { ok: false, reason: 'The mobile number does not have 10 digits.' };
  // Indian mobiles start 6-9; anything else is a landline or a typo.
  if (!/^[6-9]/.test(digits)) return { ok: false, reason: 'That looks like a landline, not a mobile number.' };

  return { ok: true, e164: `+91${digits}` };
}

/**
 * What the log keeps: the last four digits and nothing more. The full number
 * stays on the student's record, where the college already holds it.
 */
export function maskNumber(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '—';
  return `••••••${digits.slice(-4)}`;
}
