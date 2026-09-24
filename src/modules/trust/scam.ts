/**
 * The scam shield's automatic half: does a listing ask students to pay?
 *
 * The single most reliable sign of a fake internship in India is a fee -
 * "registration", "training", "security deposit", "pay ₹2,000 to receive
 * your offer letter". Genuine employers never charge the people they hire.
 * This reads the text of a role and points at every sentence that looks like
 * a demand for money, so the company is warned while writing it, the college
 * sees it before accepting, and the student is told plainly before applying.
 *
 * It flags, it never blocks: a person decides. A pattern is only a pattern,
 * so each one is written narrowly - a stipend the company pays, or a line
 * saying there is no fee, must not trip it.
 */

export interface FeeHit {
  /** The words that matched, as written. */
  phrase: string;
  /** A little of the text around it, so a reader can judge without hunting. */
  snippet: string;
  /** Which kind of demand it looked like. */
  kind: 'fee' | 'deposit' | 'payment' | 'offer_letter';
}

interface Pattern {
  kind: FeeHit['kind'];
  re: RegExp;
  /** If the text just before the match says this, it is not a demand. */
  unless?: RegExp;
}

/** "No registration fee", "we never charge any deposit" - the reassurances. */
const DENIAL = /\b(no|not|never|don'?t|do\s+not|does\s+not|without|zero|free\s+of|nil|waived?)\b[^.\n]{0,25}$/i;

/** The employer paying the student: a stipend, a salary, a bonus. */
const EMPLOYER_PAYS = /\b(we|company|employer|firm|organi[sz]ation|they)\b[^.\n]{0,20}$/i;

const PATTERNS: Pattern[] = [
  {
    kind: 'fee',
    re: /\b(registration|processing|training|kit|security|joining|onboarding|application|certification|certificate|verification|documentation|interview|enrol?ment|placement|admission)\s+(fees?|charges?|deposit|amount)\b/gi,
    unless: DENIAL,
  },
  {
    kind: 'deposit',
    re: /\b(non[-\s]?refundable|refundable|caution|security)\s+(deposit|amount|money|fees?)\b/gi,
    unless: DENIAL,
  },
  {
    kind: 'payment',
    re: /\b(you|candidates?|students?|applicants?|interns?|trainees?)\s+(will\s+)?(need\s+to|must|have\s+to|has\s+to|should|are\s+required\s+to|is\s+required\s+to|shall)\s+(pay|deposit|transfer|remit)\b/gi,
    unless: DENIAL,
  },
  {
    kind: 'payment',
    re: /\b(pay|deposit|transfer|remit)\s+(an?\s+|the\s+)?(amount\s+of\s+)?(₹|rs\.?|inr|rupees)\s?[\d,]+/gi,
    unless: EMPLOYER_PAYS,
  },
  {
    kind: 'offer_letter',
    re: /\b(pay(ment)?|fees?|deposit)\b[^.\n]{0,40}\boffer\s+letter\b|\boffer\s+letter\b[^.\n]{0,40}\b(after|on|upon|against)\s+(payment|paying|deposit)\b/gi,
    unless: DENIAL,
  },
];

function snippetAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 40);
  const to = Math.min(text.length, end + 40);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

export function scanForFeeDemand(text: string | null | undefined): FeeHit[] {
  if (!text) return [];
  const hits: (FeeHit & { start: number; end: number })[] = [];

  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (p.unless && p.unless.test(text.slice(Math.max(0, start - 40), start))) continue;
      // One sentence tripping two patterns is one warning, not two.
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ phrase: m[0], snippet: snippetAround(text, start, end), kind: p.kind, start, end });
    }
  }

  return hits.sort((a, b) => a.start - b.start).map(({ start: _s, end: _e, ...h }) => h);
}

/** Every piece of a role a company writes, joined for one scan. */
export function jobText(job: {
  title?: string | null;
  description?: string | null;
  responsibilities?: string | null;
  bondNote?: string | null;
  screeningTestInstructions?: string | null;
  terms?: (string | { text: string })[];
}): string {
  return [
    job.title,
    job.description,
    job.responsibilities,
    job.bondNote,
    job.screeningTestInstructions,
    ...(job.terms ?? []).map((t) => (typeof t === 'string' ? t : t.text)),
  ]
    .filter(Boolean)
    .join('\n');
}
