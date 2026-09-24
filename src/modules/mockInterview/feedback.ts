import type { Question } from './questions.js';

/**
 * Feedback on one mock-interview answer, from rules alone.
 *
 * Always available - no key, no network - so the feature works for every
 * institution the day it is switched on. It looks only at what the answer
 * says and how it is shaped: length, filler words, story structure, concrete
 * detail, repetition and, for a spoken answer, pace. It never comments on
 * accent, pronunciation or the person, and it leads with what went well:
 * students who feel judged stop practising, and practice is the point.
 */

export interface Improvement {
  title: string;
  tip: string;
}

export interface Feedback {
  source: 'builtin' | 'ai';
  /** True when AI was asked and failed, so the built-in rules answered instead. */
  fellBack?: boolean;
  score: number;
  strengths: string[];
  /** At most two - more than that is a list nobody acts on. */
  improvements: Improvement[];
  /** A stronger way to open the same answer. AI only. */
  betterOpening?: string;
  metrics: {
    words: number;
    idealWords: [number, number];
    wpm: number | null;
    fillers: { word: string; count: number }[];
    fillerTotal: number;
    star: { situation: boolean; task: boolean; action: boolean; result: boolean } | null;
    specifics: string[];
    repeated: string | null;
  };
}

export interface AnswerInput {
  question: Question;
  answer: string;
  durationSec?: number | null;
  /** A spoken answer's pace means something; a typed one's does not. */
  mode?: 'typed' | 'voice';
}

export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

const FILLERS: { word: string; re: RegExp }[] = [
  { word: 'um', re: /\bu+m+\b/g },
  { word: 'uh', re: /\bu+h+\b/g },
  { word: 'basically', re: /\bbasically\b/g },
  { word: 'actually', re: /\bactually\b/g },
  { word: 'you know', re: /\byou know\b/g },
  { word: 'I mean', re: /\bi mean\b/g },
  { word: 'literally', re: /\bliterally\b/g },
  { word: 'sort of', re: /\bsort of\b/g },
  { word: 'kind of', re: /\bkind of\b/g },
  // "like" is a filler only when it is set apart - "I like Java" is not one.
  { word: 'like', re: /(?:^|[,.;]\s*)like\s*,|,\s*like\b/g },
];

export function countFillers(text: string): { word: string; count: number }[] {
  const lower = text.toLowerCase();
  return FILLERS.map((f) => ({ word: f.word, count: (lower.match(f.re) ?? []).length })).filter((f) => f.count > 0);
}

const STAR = {
  situation:
    /\b(when i was|when we were|during (my|our|the)|in my (first|second|third|final|last)?\s?(year|semester|internship|project|college|team)|at (my|our) (college|internship|company|club)|last (year|semester|summer|month)|while (working|doing|i was|we were)|once,? (in|at|during))\b/,
  task: /\b(my (task|role|job|responsibility|goal|aim) was|i (had|needed|was asked|was supposed|was responsible) to|we (had|needed|were asked) to|the (goal|aim|problem|challenge|target) was|i was in charge of)\b/,
  action:
    /\b(i (decided|built|created|wrote|organi[sz]ed|led|spoke|talked|designed|set up|planned|analy[sz]ed|fixed|reached out|proposed|started|made|used|divided|called|tested|asked|met|learned how|broke|rewrote|automated|introduced|convinced))\b/,
  result:
    /\b(as a result|in the end|finally|the result|resulted in|which (led|helped|meant|saved|cut|reduced|increased)|we (won|delivered|finished|reduced|increased|improved|saved|got|launched)|it (reduced|increased|improved|saved|cut|worked)|\d+\s?(%|percent)|i learn(ed|t)|since then|the outcome)\b/,
};

export function detectStar(text: string) {
  const lower = text.toLowerCase();
  return {
    situation: STAR.situation.test(lower),
    task: STAR.task.test(lower),
    action: STAR.action.test(lower),
    result: STAR.result.test(lower),
  };
}

const TOOLS =
  /\b(python|java|javascript|typescript|c\+\+|sql|mysql|excel|power bi|tableau|react|node|django|flask|spring|git|github|docker|aws|azure|linux|matlab|autocad|solidworks|ansys|catia|tally|sap|figma|arduino|raspberry pi|pandas|numpy|tensorflow|pytorch|kotlin|android|html|css|mongodb|postgres|jira|canva|hubspot|salesforce|google analytics)\b/g;

/** The concrete things in an answer: numbers, percentages and named tools. */
export function specificsOf(text: string): string[] {
  const lower = text.toLowerCase();
  const numbers = lower.match(/\b\d[\d,.]*\s?(%|percent|lakh|crore|k|hours?|days?|weeks?|months?|years?|students?|users?|people|members?)?/g) ?? [];
  const tools = lower.match(TOOLS) ?? [];
  return [...new Set([...numbers.map((n) => n.trim()), ...tools])].slice(0, 8);
}

/** A three-word phrase said three or more times - a sign of going in circles. */
export function repeatedPhrase(text: string): string | null {
  const w = wordsOf(text);
  const counts = new Map<string, number>();
  for (let i = 0; i + 2 < w.length; i++) {
    const phrase = `${w[i]} ${w[i + 1]} ${w[i + 2]}`;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 2;
  for (const [phrase, n] of counts) {
    if (n > most) {
      best = phrase;
      most = n;
    }
  }
  return best;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * The built-in review. Returns strengths first (always at least one), then
 * no more than two improvements, most useful first.
 */
export function builtinFeedback(input: AnswerInput): Feedback {
  const { question, answer } = input;
  const words = wordsOf(answer).length;
  const [lo, hi] = question.ideal;
  const fillers = countFillers(answer);
  const fillerTotal = fillers.reduce((n, f) => n + f.count, 0);
  const fillerRate = words ? (fillerTotal / words) * 100 : 0;
  const behavioural = question.type === 'behavioural';
  const star = behavioural || question.type === 'situational' ? detectStar(answer) : null;
  const specifics = specificsOf(answer);
  const repeated = repeatedPhrase(answer);
  const wpm =
    input.mode === 'voice' && input.durationSec && input.durationSec >= 10
      ? Math.round((words / input.durationSec) * 60)
      : null;

  let score = 55;
  const strengths: string[] = [];
  // Ordered by how much fixing each would help; the first two are kept.
  const issues: Improvement[] = [];

  // Length.
  if (words >= lo && words <= hi) {
    score += 15;
    strengths.push('Your answer was a good length for this question - enough detail without running on.');
  } else if (words < lo) {
    score -= words < lo / 2 ? 20 : 10;
    issues.push({
      title: 'Say a little more',
      tip:
        question.type === 'intro'
          ? 'Cover three things: what you study, one thing you have built or done, and what you are looking for next.'
          : 'Add one real example - what happened, what you did, and how it turned out.',
    });
  } else {
    score -= 8;
    issues.push({
      title: 'Tighten it up',
      tip: `Aim for about ${lo}-${hi} words. Lead with your main point, give one example, and stop.`,
    });
  }

  // Story structure, for questions that want a story.
  if (star) {
    const parts = Object.values(star).filter(Boolean).length;
    score += parts * 4;
    if (parts >= 3) {
      strengths.push('You told it as a story - what the situation was, what you did, and what came of it.');
    }
    if (!star.result && behavioural) {
      issues.unshift({
        title: 'End with the result',
        tip: 'Finish with what changed because of you - a number, a decision, or what you would do differently now.',
      });
    } else if (!star.action) {
      issues.push({
        title: 'Say what you did',
        tip: 'Use "I" for your part: "I set up…", "I spoke to…". Interviewers want your contribution, not only the team’s.',
      });
    }
  }

  // Concrete detail.
  if (specifics.length >= 2) {
    score += 10;
    strengths.push(`You gave concrete detail (${specifics.slice(0, 3).join(', ')}), which makes an answer believable.`);
  } else if (question.type !== 'motivation') {
    issues.push({
      title: 'Add something concrete',
      tip: 'A number, a tool you used, or a named project turns a general answer into a memorable one.',
    });
  }

  // Filler words.
  if (words >= 30 && fillerRate <= 2) {
    score += 8;
    strengths.push('Very few filler words - it sounds confident.');
  } else if (fillerRate > 5) {
    score -= 8;
    const top = [...fillers].sort((a, b) => b.count - a.count)[0]!;
    issues.push({
      title: 'Fewer filler words',
      tip: `"${top.word}" came up ${top.count} time${top.count === 1 ? '' : 's'}. A short pause sounds more sure of itself than a filler.`,
    });
  }

  // Going in circles.
  if (repeated) {
    score -= 5;
    issues.push({ title: 'Avoid repeating yourself', tip: `"${repeated}" came up several times. Say it once, then move on.` });
  }

  // Pace, for spoken answers only.
  if (wpm !== null) {
    if (wpm >= 110 && wpm <= 165) {
      score += 5;
      strengths.push(`A comfortable speaking pace (about ${wpm} words a minute).`);
    } else if (wpm > 165) {
      score -= 4;
      issues.push({ title: 'Slow down a little', tip: 'Take a breath between points. A slower pace gives the interviewer time to follow.' });
    } else {
      score -= 2;
      issues.push({ title: 'Keep it moving', tip: 'Decide your three points before you start, so there are fewer long pauses.' });
    }
  }

  if (strengths.length === 0) {
    strengths.push('You answered the question directly - that is the hardest part, and you did it.');
  }

  return {
    source: 'builtin',
    score: clamp(score),
    strengths: strengths.slice(0, 3),
    improvements: issues.slice(0, 2),
    metrics: {
      words,
      idealWords: question.ideal,
      wpm,
      fillers,
      fillerTotal,
      star,
      specifics,
      repeated,
    },
  };
}

/**
 * Words that must never appear in feedback. Applied to AI output too: a
 * suggestion about someone's accent is not feedback on their answer.
 */
export const OFF_LIMITS = /\b(accent|pronunciation|pronounce|mother tongue|native speaker|grammar|grammatical|your english)\b/i;
