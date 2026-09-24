import { wordsOf } from '../mockInterview/feedback.js';

/**
 * Email writing practice, checked by rules.
 *
 * The emails a student sends during placements are few but they count: the
 * reply confirming an interview slot, the request to reschedule, the thank-you,
 * accepting or declining an offer. Recruiters read them as a sample of how the
 * person will write at work. These checks look only at what makes a work email
 * land - a subject, a greeting, a clear ask, a sensible length, courtesy, a
 * sign-off, no text-message shorthand. Nothing about grammar or "good English".
 *
 * The improved version shown to the student is either the scenario's template
 * (with [placeholders] for them to fill) or, when a key is set, a polish of
 * their own draft by Claude. Never an invented "corrected" copy.
 */

export interface EmailScenario {
  id: string;
  title: string;
  /** The situation, as the student reads it. Demo names only. */
  brief: string;
  /** Words that show the email actually makes the ask. Any one is enough. */
  ask: RegExp;
  askHint: string;
  template: { subject: string; body: string };
}

export const SCENARIOS: EmailScenario[] = [
  {
    id: 'confirm-slot',
    title: 'Confirm an interview slot',
    brief: 'Demo Tech Pvt Ltd has offered you an interview on Tuesday at 11 am. Reply to confirm.',
    ask: /\b(confirm|will attend|i('| a)m available|see you|look forward to (meeting|speaking))\b/i,
    askHint: 'Say plainly that you confirm the slot, repeating the date and time.',
    template: {
      subject: 'Interview confirmation - [Your name], [Role]',
      body: 'Dear [Recruiter name],\n\nThank you for the invitation. I confirm that I will attend the interview on Tuesday at 11 am.\n\nPlease let me know if I should bring anything or prepare anything in advance.\n\nRegards,\n[Your name]\n[College], [Course]',
    },
  },
  {
    id: 'reschedule',
    title: 'Ask to reschedule',
    brief: 'Your interview with Demo Analytics clashes with a university exam. Ask politely for another time.',
    ask: /\b(reschedul\w*|another (time|slot|date)|different (time|slot|date)|alternative (time|slot|date)|move the)\b/i,
    askHint: 'Say why in one line, and offer two or three times that work for you.',
    template: {
      subject: 'Request to reschedule interview - [Your name]',
      body: 'Dear [Recruiter name],\n\nThank you for scheduling my interview for [date and time]. Unfortunately, I have a university examination at that time.\n\nWould it be possible to move the interview to another slot? I am available on [option 1] or [option 2].\n\nI apologise for the inconvenience and appreciate your understanding.\n\nRegards,\n[Your name]',
    },
  },
  {
    id: 'thank-you',
    title: 'Thank the interviewer',
    brief: 'You had a good interview with Ms Demo Sharma at Demo Solutions today. Send a short thank-you.',
    ask: /\b(thank|grateful|appreciate)\w*\b/i,
    askHint: 'Thank them, mention one specific thing from the conversation, and restate your interest.',
    template: {
      subject: 'Thank you - [Role] interview',
      body: 'Dear [Interviewer name],\n\nThank you for taking the time to speak with me today. I especially enjoyed learning about [something specific from the interview].\n\nThe conversation made me even more interested in the [Role] position, and I look forward to hearing about the next steps.\n\nRegards,\n[Your name]',
    },
  },
  {
    id: 'accept-offer',
    title: 'Accept an offer',
    brief: 'Demo Systems has offered you a Graduate Engineer Trainee role. Accept it and ask about next steps.',
    ask: /\b(accept\w*|happy to join|pleased to join|confirm my (acceptance|joining))\b/i,
    askHint: 'Accept clearly in the first lines, and ask what happens next (documents, joining date).',
    template: {
      subject: 'Offer acceptance - [Your name], [Role]',
      body: 'Dear [HR name],\n\nThank you for the offer for the [Role] position. I am pleased to accept it.\n\nCould you please let me know the next steps, including the documents required and the joining date?\n\nI look forward to joining the team.\n\nRegards,\n[Your name]',
    },
  },
  {
    id: 'decline-offer',
    title: 'Decline an offer politely',
    brief: 'You have accepted another offer. Decline the one from Demo Retail kindly, keeping the door open.',
    ask: /\b(declin\w*|not be able to (accept|join)|unable to (accept|join)|regret)\b/i,
    askHint: 'Decline clearly, thank them, and keep it short - you do not owe a long explanation.',
    template: {
      subject: 'Regarding the [Role] offer - [Your name]',
      body: 'Dear [HR name],\n\nThank you for offering me the [Role] position and for your time during the process.\n\nAfter careful thought, I have decided to decline the offer, as I have accepted another role that fits my current plans.\n\nI hope our paths cross again in the future.\n\nRegards,\n[Your name]',
    },
  },
  {
    id: 'status',
    title: 'Ask about your application',
    brief: 'You interviewed with Demo Finance two weeks ago and have not heard back. Ask politely about the status.',
    ask: /\b(status|update|any news|next steps|hear back|heard back)\b/i,
    askHint: 'Mention when you interviewed and for which role, then ask for an update.',
    template: {
      subject: 'Following up - [Role] interview on [date]',
      body: 'Dear [Recruiter name],\n\nI hope you are well. I interviewed for the [Role] position on [date] and wanted to follow up on the status of my application.\n\nI remain very interested in the role. Please let me know if you need anything further from me.\n\nRegards,\n[Your name]',
    },
  },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);

export interface EmailCheck {
  key: 'subject' | 'greeting' | 'ask' | 'length' | 'polite' | 'signoff' | 'shorthand' | 'tone';
  label: string;
  ok: boolean;
  tip?: string;
}

export interface EmailFeedback {
  source: 'builtin' | 'ai';
  fellBack?: boolean;
  score: number;
  checks: EmailCheck[];
  /** What to do next - at most two, the first failed checks. */
  improvements: { title: string; tip: string }[];
  /** A better version: the AI polish of their draft, or the scenario template. */
  improved: { subject: string; body: string; from: 'template' | 'ai' };
  notes?: string[];
}

const GREETING = /^\s*(dear|hello|hi|good (morning|afternoon|evening)|respected)\b/i;
const POLITE = /\b(please|kindly|thank(s| you)?|grateful|appreciate|regards)\b/i;
const SIGNOFF = /\b(regards|sincerely|thank you|thanks|best wishes|warm regards|yours (truly|faithfully|sincerely))\s*,?\s*\n+\s*\S+/i;
/** Text-message shorthand - fine with friends, a poor look with a recruiter. */
const SHORTHAND = /\b(u|ur|pls|plz|thx|thnx|tq|coz|cuz|bcoz|gud|msg|wud|wat|abt|asap)\b/gi;

/** Every rule check, in the order the student reads them. */
export function checkEmail(scenario: EmailScenario, subject: string, body: string): EmailCheck[] {
  const subjectWords = wordsOf(subject).length;
  const words = wordsOf(body).length;
  const shorthand = [...new Set((body.match(SHORTHAND) ?? []).map((w) => w.toLowerCase()))];
  const shouting = (body.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !/^(HR|CEO|MBA|BTECH|BCOM|BSC|MCA|BBA|PDF|URL)$/.test(w));
  const exclaim = /!{2,}/.test(body) || /\?{2,}/.test(body);

  return [
    {
      key: 'subject',
      label: 'Clear subject line',
      ok: subjectWords >= 3 && subjectWords <= 12 && subject !== subject.toUpperCase(),
      tip: subjectWords < 3 ? 'Say what the email is about and who you are, e.g. "Interview confirmation - [Your name]".' : 'Keep the subject short and in normal case.',
    },
    { key: 'greeting', label: 'Opens with a greeting', ok: GREETING.test(body), tip: 'Start with "Dear [name]," - or "Dear Hiring Team," if you do not know the name.' },
    { key: 'ask', label: 'Makes the ask clearly', ok: scenario.ask.test(`${subject} ${body}`), tip: scenario.askHint },
    {
      key: 'length',
      label: 'Right length',
      ok: words >= 40 && words <= 200,
      tip: words < 40 ? 'Add a line of context so it does not read as abrupt - 50 to 150 words is about right.' : 'Trim it to the essentials - recruiters skim. 50 to 150 words is about right.',
    },
    { key: 'polite', label: 'Courteous', ok: POLITE.test(body), tip: 'A "thank you" or "please" goes a long way.' },
    { key: 'signoff', label: 'Signs off with your name', ok: SIGNOFF.test(body), tip: 'End with "Regards," on one line and your full name on the next.' },
    {
      key: 'shorthand',
      label: 'No text-message shorthand',
      ok: shorthand.length === 0,
      tip: shorthand.length ? `Write these out in full: ${shorthand.slice(0, 4).join(', ')}.` : undefined,
    },
    {
      key: 'tone',
      label: 'Calm tone',
      ok: shouting.length === 0 && !exclaim,
      tip: 'Avoid capital-letter words and repeated "!!" or "??" - they read as shouting.',
    },
  ];
}

export function emailFeedback(scenario: EmailScenario, subject: string, body: string): EmailFeedback {
  const checks = checkEmail(scenario, subject, body);
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);
  return {
    source: 'builtin',
    score: Math.round((passed / checks.length) * 100),
    checks: checks.map((c) => (c.ok ? { key: c.key, label: c.label, ok: true } : c)),
    improvements: failed.slice(0, 2).map((c) => ({ title: c.label, tip: c.tip ?? '' })),
    improved: { ...scenario.template, from: 'template' },
  };
}
