import type { Question } from '../mockInterview/questions.js';
import { wordsOf } from '../mockInterview/feedback.js';

/**
 * Speaking and pitch practice for the soft skills studio.
 *
 * Both reuse the mock-interview feedback engine as it stands: a speaking
 * prompt is treated as a short opinion answer, a pitch as a self-introduction.
 * So the student gets the same fair, content-only feedback here as in a mock
 * interview - length, pace when spoken, fillers, concrete detail - and a pitch
 * additionally gets a check of its structure.
 */

export const SPEAKING_PROMPTS = [
  'Describe a place in your town that you would show a visitor, and why.',
  'Talk about a skill you taught yourself. How did you go about it?',
  'What is one change you would make to your college, and how would it help?',
  'Describe a time you changed your mind about something.',
  'Talk about a book, film or series that stayed with you.',
  'Explain something you know well to someone who knows nothing about it.',
  'What does a good team-mate do that others do not?',
  'Describe a small problem you solved at home or in your hostel.',
  'Talk about someone whose work you admire and what you have learned from them.',
  'If you could learn any skill in a month, what would it be and why?',
  'Describe your ideal first year at work.',
  'Talk about a festival or tradition from your region and what it means to you.',
  'What is a common piece of advice you disagree with?',
  'Describe a time you had to wait patiently for something.',
];

/** Today's speaking prompt - the same for everyone on a given day, a new one tomorrow. */
export function dailyPrompt(now = new Date()): string {
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
  return SPEAKING_PROMPTS[day % SPEAKING_PROMPTS.length]!;
}

export const PITCH_PROMPTS = [
  'Introduce yourself to a recruiter at a campus job fair.',
  'Pitch yourself for a summer internship in your field.',
  'Tell an alumnus in 60 seconds why they should refer you.',
  'Pitch a project you built to someone who could hire you.',
];

/** A speaking answer, as the interview engine sees it: an opinion, about a minute. */
export const speakingQuestion = (prompt: string): Question => ({ id: 'soft-speaking', text: prompt, type: 'motivation', ideal: [60, 180] });

/** A pitch, as the interview engine sees it: a self-introduction of 60-90 seconds. */
export const pitchQuestion = (prompt: string): Question => ({ id: 'soft-pitch', text: prompt, type: 'intro', ideal: [120, 220] });

export interface PitchPart {
  key: 'who' | 'proof' | 'fit' | 'ask';
  label: string;
  ok: boolean;
  tip: string;
}

/**
 * The four beats of a good 60-90 second pitch: who you are, one piece of
 * proof, why you fit what they need, and what you are asking for.
 */
export function pitchStructure(text: string): PitchPart[] {
  const t = text.toLowerCase();
  return [
    {
      key: 'who',
      label: 'Who you are',
      ok: /\b(i am|i'm|my name is|myself)\b/.test(t) && /\b(student|studying|final year|year|graduate|course|b\.?tech|b\.?com|b\.?sc|bba|bca|mba|degree|college)\b/.test(t),
      tip: 'Open with your name, what you study and where - one sentence.',
    },
    {
      key: 'proof',
      label: 'One piece of proof',
      ok: /\b(built|created|led|won|organi[sz]ed|developed|designed|completed|interned|internship|project|achieved|increased|reduced|\d+)\b/.test(t),
      tip: 'Give one specific thing you did - a project, an internship, a result with a number.',
    },
    {
      key: 'fit',
      label: 'Why you fit',
      ok: /\b(interested in|passionate about|enjoy|want to (work|build|grow|learn)|excited|because|fit|match|your (team|company|role))\b/.test(t),
      tip: 'Link what you have done to what they need - "which is why the analyst role interests me".',
    },
    {
      key: 'ask',
      label: 'A clear ask',
      ok: /\b(i would (love|like)|i'd (love|like)|looking for|hoping (to|for)|could (i|we|you)|would you|opportunity|chance to|refer|connect|conversation|internship|role)\b/.test(t),
      tip: 'End with what you want: "I would love a chance to interview for…", "Could I send you my CV?"',
    },
  ];
}

/** Rough speaking time at a comfortable 140 words a minute. */
export const spokenSeconds = (text: string) => Math.round((wordsOf(text).length / 140) * 60);
