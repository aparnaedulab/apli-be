import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { env } from '../../config/env.js';
import { builtinFeedback, OFF_LIMITS, type AnswerInput, type Feedback } from './feedback.js';

/**
 * AI feedback on a mock-interview answer, when the deployment has a key.
 *
 * Claude reviews the answer against a fixed rubric and returns the same shape
 * the built-in rules do, so the screen does not care which answered. Only the
 * question and the answer text are sent - no name, college or contact detail.
 * Anything that goes wrong - no key, an error, a refusal, output that does not
 * match the shape, or a comment about accent - falls back to the built-in
 * feedback, marked as such. The student always gets feedback.
 */

const AiShape = z.object({
  score: z.number().int().min(0).max(100),
  strengths: z.array(z.string().min(1).max(300)).min(1).max(3),
  improvements: z
    .array(z.object({ title: z.string().min(1).max(80), tip: z.string().min(1).max(300) }))
    .max(2),
  betterOpening: z.string().min(1).max(400),
});

export type AiReview = z.infer<typeof AiShape>;

/** Asks a reviewer for feedback. Swappable, so tests never call the network. */
export type AiReviewer = (input: AnswerInput) => Promise<unknown>;

const RUBRIC = `You review answers from a college student practising for a campus job interview in India.

Judge only the answer's content and structure:
- Does it answer the question that was asked?
- For behavioural and situational questions: is there a situation, the student's own actions ("I"), and a result?
- Is there concrete detail - numbers, tools, named projects?
- Is it a sensible length for a spoken answer of one to two minutes?

Rules you must follow:
- Never comment on accent, pronunciation, grammar, fluency in English, or anything about the person. The text may be a speech transcript; ignore transcription errors.
- Lead with specific strengths quoted from the answer. Give at most two improvements, each with one concrete thing to do.
- Be warm and direct, like a helpful senior. No generic praise.
- score is 0-100 for this answer as an interview answer.
- betterOpening is a stronger first one or two sentences for the same answer, written in the student's voice, using only facts from their answer.`;

let client: Anthropic | null = null;

/** The live reviewer: one structured-output request to Claude. */
export const claudeReviewer: AiReviewer = async (input) => {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: env.MOCK_INTERVIEW_MODEL,
    max_tokens: 16000,
    system: RUBRIC,
    output_config: { effort: 'low', format: zodOutputFormat(AiShape) },
    messages: [
      {
        role: 'user',
        content: [
          `Question type: ${input.question.type}`,
          `Question: ${input.question.text}`,
          `Answer (${input.mode === 'voice' ? 'speech transcript' : 'typed'}):`,
          input.answer,
        ].join('\n'),
      },
    ],
  });
  // A declined request carries no usable output; treat it like any failure.
  if (response.stop_reason === 'refusal') throw new Error('refused');
  return response.parsed_output;
};

export function aiEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Feedback for an answer: AI when a reviewer is available and behaves,
 * built-in otherwise. The measured numbers always come from the rules, so
 * word counts and filler counts are exact whichever source wrote the advice.
 */
export async function feedbackFor(input: AnswerInput, reviewer: AiReviewer | null): Promise<Feedback> {
  const base = builtinFeedback(input);
  if (!reviewer) return base;

  try {
    const parsed = AiShape.safeParse(await reviewer(input));
    if (!parsed.success) return { ...base, fellBack: true };
    const r = parsed.data;
    const text = [...r.strengths, ...r.improvements.flatMap((i) => [i.title, i.tip]), r.betterOpening].join(' ');
    if (OFF_LIMITS.test(text)) return { ...base, fellBack: true };
    return {
      source: 'ai',
      score: r.score,
      strengths: r.strengths,
      improvements: r.improvements,
      betterOpening: r.betterOpening,
      metrics: base.metrics,
    };
  } catch {
    return { ...base, fellBack: true };
  }
}
