import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { env } from '../../config/env.js';
import { OFF_LIMITS, wordsOf } from '../mockInterview/feedback.js';
import { builtinTurn, gdFeedback, personaByKey, type GdFeedback, type GdTopic, type PersonaKey, type Turn } from './gd.js';
import { emailFeedback, type EmailFeedback, type EmailScenario } from './email.js';

/**
 * Claude, where a key is configured, for the three places it adds something
 * the rules cannot: playing the GD participants so they actually respond to
 * what the student said, reviewing a whole discussion, and polishing an email
 * draft. Each caller is swappable so tests never touch the network, and every
 * path falls back to the built-in version on any failure - no key, an error, a
 * refusal, output that does not fit the shape, or advice about accent or
 * grammar. Nothing identifying is sent: the student appears only as "you".
 */

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));

export function aiEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

const speakerName = (s: string) => (s === 'you' ? 'Student' : s === 'moderator' ? 'Moderator' : (personaByKey(s)?.name ?? s));
const transcriptText = (t: Turn[]) => t.map((x) => `${speakerName(x.speaker)}: ${x.text}`).join('\n');

/* -------------------------------------------------------------------------- */
/* GD participants                                                             */
/* -------------------------------------------------------------------------- */

const TurnShape = z.object({ text: z.string().min(1).max(700) });

export interface TurnInput {
  topic: GdTopic;
  persona: PersonaKey;
  transcript: Turn[];
}
export type TurnWriter = (input: TurnInput) => Promise<unknown>;

export const claudeTurnWriter: TurnWriter = async ({ topic, persona, transcript }) => {
  const p = personaByKey(persona)!;
  const response = await anthropic().messages.parse({
    model: env.MOCK_INTERVIEW_MODEL,
    max_tokens: 16000,
    system: `You play ${p.name}, one participant in a practice group discussion for a campus placement in India. ${p.brief}
Write ${p.name}'s next contribution only: 20-70 words, spoken register, in character. React to the last speaker when natural. Stay on the topic unless your character drifts. Never invent statistics or name real people. Never comment on anyone's accent, grammar or English.`,
    output_config: { effort: 'low', format: zodOutputFormat(TurnShape) },
    messages: [{ role: 'user', content: `Topic: ${topic.title}\n\nDiscussion so far:\n${transcriptText(transcript)}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('refused');
  return response.parsed_output;
};

/** A participant's next line: from Claude when it behaves, from the bank otherwise. */
export async function personaTurn(
  input: TurnInput & { seed: string },
  writer: TurnWriter | null,
): Promise<{ text: string; source: 'builtin' | 'ai' }> {
  const fallback = () => ({ text: builtinTurn(input.topic, input.transcript, input.seed, input.persona), source: 'builtin' as const });
  if (!writer) return fallback();
  try {
    const parsed = TurnShape.safeParse(await writer(input));
    if (!parsed.success) return fallback();
    const text = parsed.data.text.trim();
    if (wordsOf(text).length > 120 || OFF_LIMITS.test(text)) return fallback();
    return { text, source: 'ai' };
  } catch {
    return fallback();
  }
}

/* -------------------------------------------------------------------------- */
/* GD review                                                                   */
/* -------------------------------------------------------------------------- */

const ReviewShape = z.object({
  score: z.number().int().min(0).max(100),
  strengths: z.array(z.string().min(1).max(300)).min(1).max(3),
  improvements: z.array(z.object({ title: z.string().min(1).max(80), tip: z.string().min(1).max(300) })).max(2),
});

export type GdReviewer = (input: { topic: GdTopic; transcript: Turn[] }) => Promise<unknown>;

export const claudeGdReviewer: GdReviewer = async ({ topic, transcript }) => {
  const response = await anthropic().messages.parse({
    model: env.MOCK_INTERVIEW_MODEL,
    max_tokens: 16000,
    system: `You review how a college student took part in a practice group discussion for campus placements in India. The other participants are simulated. Judge only the Student's participation: when they came in, how often and how long they spoke, whether they built on others' points, brought the group back on topic, used examples, and summarised at the end; and whether they dominated or balanced.
Rules: never comment on accent, pronunciation, grammar or English. Lead with specific strengths quoting the Student. At most two improvements, each one concrete action. Warm and direct, like a helpful senior. score is 0-100 for GD participation.`,
    output_config: { effort: 'low', format: zodOutputFormat(ReviewShape) },
    messages: [{ role: 'user', content: `Topic: ${topic.title}\n\n${transcriptText(transcript)}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('refused');
  return response.parsed_output;
};

/** Feedback on a discussion. The measured numbers always come from the rules. */
export async function gdFeedbackFor(topic: GdTopic, transcript: Turn[], reviewer: GdReviewer | null): Promise<GdFeedback> {
  const base = gdFeedback(transcript);
  if (!reviewer || base.metrics.contributions === 0) return base;
  try {
    const parsed = ReviewShape.safeParse(await reviewer({ topic, transcript }));
    if (!parsed.success) return { ...base, fellBack: true };
    const r = parsed.data;
    if (OFF_LIMITS.test([...r.strengths, ...r.improvements.flatMap((i) => [i.title, i.tip])].join(' '))) return { ...base, fellBack: true };
    return { source: 'ai', score: r.score, strengths: r.strengths, improvements: r.improvements, metrics: base.metrics };
  } catch {
    return { ...base, fellBack: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Email polish                                                                */
/* -------------------------------------------------------------------------- */

const PolishShape = z.object({
  subject: z.string().min(1).max(150),
  body: z.string().min(1).max(2500),
  notes: z.array(z.string().min(1).max(200)).max(3),
});

export type EmailPolisher = (input: { scenario: EmailScenario; subject: string; body: string }) => Promise<unknown>;

export const claudeEmailPolisher: EmailPolisher = async ({ scenario, subject, body }) => {
  const response = await anthropic().messages.parse({
    model: env.MOCK_INTERVIEW_MODEL,
    max_tokens: 16000,
    system: `You help a college student in India polish a short professional email during campus placements. Rewrite their draft into a clear, courteous version: subject line, greeting, the ask in the first lines, 50-150 words, sign-off with their name. Keep their facts and voice; do not add facts. Where a detail is missing, use a [placeholder] in square brackets. notes: up to three short points on what changed and why, about structure and tone only. Never mention accent, grammar or "English".`,
    output_config: { effort: 'low', format: zodOutputFormat(PolishShape) },
    messages: [{ role: 'user', content: `Situation: ${scenario.brief}\n\nSubject: ${subject}\n\n${body}` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('refused');
  return response.parsed_output;
};

/** Checks always from the rules; the improved version from Claude when it behaves, the template otherwise. */
export async function emailFeedbackFor(
  scenario: EmailScenario,
  subject: string,
  body: string,
  polisher: EmailPolisher | null,
): Promise<EmailFeedback> {
  const base = emailFeedback(scenario, subject, body);
  if (!polisher) return base;
  try {
    const parsed = PolishShape.safeParse(await polisher({ scenario, subject, body }));
    if (!parsed.success) return { ...base, fellBack: true };
    const p = parsed.data;
    if (OFF_LIMITS.test(p.notes.join(' '))) return { ...base, fellBack: true };
    return { ...base, source: 'ai', improved: { subject: p.subject, body: p.body, from: 'ai' }, notes: p.notes };
  } catch {
    return { ...base, fellBack: true };
  }
}
