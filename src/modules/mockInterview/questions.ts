/**
 * The questions a mock interview asks, written for Indian campus hiring.
 *
 * Each carries its type, because what makes an answer good depends on it: a
 * behavioural question wants a story with a result, an introduction wants to
 * be short, a technical question wants the reasoning out loud. The ideal
 * length is a word range for a spoken answer of roughly one to two minutes.
 */

export type InterviewKind = 'HR' | 'TECHNICAL' | 'MANAGERIAL';

export type QuestionType = 'intro' | 'behavioural' | 'motivation' | 'technical' | 'situational';

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  /** Words, for a spoken answer. */
  ideal: [number, number];
}

/**
 * Spoken at a comfortable 120-150 words a minute, a complete story takes
 * about 90 words and anything past 300 has usually stopped answering.
 */
const WORDS: Record<QuestionType, [number, number]> = {
  intro: [80, 220],
  behavioural: [90, 300],
  motivation: [60, 200],
  technical: [60, 280],
  situational: [80, 260],
};

const q = (id: string, text: string, type: QuestionType): Question => ({ id, text, type, ideal: WORDS[type] });

/** The roles a student can practise for. Technical questions differ by role. */
export const ROLES = [
  { key: 'software', label: 'Software engineering' },
  { key: 'data', label: 'Data & analytics' },
  { key: 'core', label: 'Core engineering (mechanical, civil, electrical)' },
  { key: 'sales', label: 'Sales & marketing' },
  { key: 'finance', label: 'Finance & accounts' },
] as const;

export type RoleKey = (typeof ROLES)[number]['key'];

export const KINDS: { key: InterviewKind; label: string; blurb: string }[] = [
  { key: 'HR', label: 'HR round', blurb: 'About you, your choices and how you work with people.' },
  { key: 'TECHNICAL', label: 'Technical round', blurb: 'Your subject, explained the way you would to an interviewer.' },
  { key: 'MANAGERIAL', label: 'Managerial round', blurb: 'Judgement, priorities and handling real situations.' },
];

const HR: Question[] = [
  q('hr-intro', 'Tell me about yourself.', 'intro'),
  q('hr-strength', 'What is your greatest strength, and when did it make a difference?', 'behavioural'),
  q('hr-weakness', 'Tell me about a weakness you are working on.', 'behavioural'),
  q('hr-conflict', 'Describe a time you disagreed with a teammate. How did you handle it?', 'behavioural'),
  q('hr-failure', 'Tell me about something that did not go to plan, and what you learned from it.', 'behavioural'),
  q('hr-why-us', 'Why do you want to work with us?', 'motivation'),
  q('hr-five-years', 'Where do you see yourself in five years?', 'motivation'),
  q('hr-why-you', 'Why should we hire you over other candidates?', 'motivation'),
  q('hr-pressure', 'Describe a time you worked under a tight deadline.', 'behavioural'),
  q('hr-lead', 'Tell me about a time you took the lead without being asked.', 'behavioural'),
  q('hr-relocate', 'This role may need you to relocate or work shifts. How do you feel about that?', 'situational'),
  q('hr-proud', 'Which project are you most proud of, and what was your part in it?', 'behavioural'),
];

const MANAGERIAL: Question[] = [
  q('mg-priorities', 'You have three urgent tasks due today and time for two. How do you decide?', 'situational'),
  q('mg-feedback', 'Tell me about a time you received critical feedback. What did you do with it?', 'behavioural'),
  q('mg-mistake', 'You find a mistake in work you already submitted to a client. What do you do?', 'situational'),
  q('mg-underperformer', 'A teammate keeps missing their part of a shared task. How do you handle it?', 'situational'),
  q('mg-persuade', 'Describe a time you persuaded someone to change their mind.', 'behavioural'),
  q('mg-ambiguity', 'Tell me about a time you had to start work without clear instructions.', 'behavioural'),
  q('mg-disagree-manager', 'Your manager asks you to do something you think is the wrong approach. What do you do?', 'situational'),
  q('mg-learn-fast', 'Tell me about a time you had to learn something new very quickly.', 'behavioural'),
  q('mg-customer', 'An angry customer calls about a delay that is not your fault. Walk me through the call.', 'situational'),
  q('mg-initiative', 'What is one process you improved, in college or an internship? What changed as a result?', 'behavioural'),
];

const TECHNICAL: Record<RoleKey, Question[]> = {
  software: [
    q('sw-project', 'Walk me through the architecture of a project you built. What would you change now?', 'technical'),
    q('sw-oop', 'Explain object-oriented programming to someone who has only written scripts.', 'technical'),
    q('sw-array-list', 'When would you choose an array over a linked list, and why?', 'technical'),
    q('sw-bug', 'Tell me about the hardest bug you fixed. How did you find it?', 'behavioural'),
    q('sw-db-index', 'What is a database index, and when can it make things slower?', 'technical'),
    q('sw-api', 'How does a web request travel from a browser to a server and back?', 'technical'),
    q('sw-scale', 'Your application slows down when many users log in at once. Where do you start looking?', 'situational'),
    q('sw-git', 'How do you work with others on the same code base without breaking each other’s work?', 'technical'),
    q('sw-complexity', 'Explain time complexity using an example from your own code.', 'technical'),
    q('sw-testing', 'How do you know your code works before you hand it over?', 'technical'),
  ],
  data: [
    q('dt-project', 'Walk me through a data analysis you did, from the question to the conclusion.', 'technical'),
    q('dt-missing', 'Your data set has missing values in an important column. What do you do?', 'technical'),
    q('dt-sql-join', 'Explain the difference between an inner join and a left join with an example.', 'technical'),
    q('dt-mean-median', 'When is the median a better summary than the mean?', 'technical'),
    q('dt-overfit', 'What is overfitting, and how would you notice it?', 'technical'),
    q('dt-dashboard', 'A manager says your dashboard number is wrong. How do you check?', 'situational'),
    q('dt-explain', 'Explain a finding of yours to someone with no background in statistics.', 'technical'),
    q('dt-correlation', 'Two numbers rise together. Why can you not say one causes the other?', 'technical'),
    q('dt-clean', 'Tell me about the messiest data you had to clean.', 'behavioural'),
  ],
  core: [
    q('co-project', 'Explain your final-year or best project and the engineering decisions in it.', 'technical'),
    q('co-safety', 'How do you make sure a design is safe before it goes into use?', 'technical'),
    q('co-material', 'How would you choose a material for a part that must be light but strong?', 'technical'),
    q('co-failure', 'A machine on the shop floor keeps failing. How do you find the root cause?', 'situational'),
    q('co-drawing', 'What do you check first when you read an engineering drawing?', 'technical'),
    q('co-cost', 'Your design meets every spec but costs too much. What do you do?', 'situational'),
    q('co-site', 'Tell me about a time you worked hands-on, in a lab, workshop or site.', 'behavioural'),
    q('co-standard', 'Why do engineering standards matter? Give an example you have used.', 'technical'),
    q('co-energy', 'How would you reduce the energy a process uses?', 'technical'),
  ],
  sales: [
    q('sl-sell', 'Sell me a product you use every day.', 'situational'),
    q('sl-rejection', 'Tell me about a time someone said no to you. What did you do next?', 'behavioural'),
    q('sl-target', 'You are behind your monthly target with a week to go. What do you do?', 'situational'),
    q('sl-customer', 'How do you find out what a customer actually needs?', 'technical'),
    q('sl-campaign', 'Describe a campaign or event you promoted. How did you know it worked?', 'behavioural'),
    q('sl-competitor', 'A customer says a competitor is cheaper. How do you respond?', 'situational'),
    q('sl-channel', 'Which channel would you use to reach first-year college students, and why?', 'technical'),
    q('sl-brand', 'Pick a brand you admire and explain what it does well.', 'technical'),
    q('sl-relationship', 'How do you keep a customer coming back after the first sale?', 'technical'),
  ],
  finance: [
    q('fn-statements', 'Explain how the three financial statements connect to each other.', 'technical'),
    q('fn-cashflow', 'Can a profitable company run out of cash? How?', 'technical'),
    q('fn-working-capital', 'What is working capital, and why do companies watch it closely?', 'technical'),
    q('fn-valuation', 'How would you estimate what a small business is worth?', 'technical'),
    q('fn-gst', 'Explain how GST works for a business that buys and sells goods.', 'technical'),
    q('fn-error', 'You find a mismatch in a reconciliation just before a deadline. What do you do?', 'situational'),
    q('fn-ratio', 'Which ratios would you look at first to judge a company’s health, and why?', 'technical'),
    q('fn-excel', 'Tell me about the most useful spreadsheet you built.', 'behavioural'),
    q('fn-budget', 'How would you help a department that keeps going over budget?', 'situational'),
  ],
};

const ALL = new Map<string, Question>(
  [...HR, ...MANAGERIAL, ...Object.values(TECHNICAL).flat()].map((x) => [x.id, x]),
);

export function questionById(id: string): Question | undefined {
  return ALL.get(id);
}

export function isRole(value: string): value is RoleKey {
  return ROLES.some((r) => r.key === value);
}

/** A small seeded generator, so a session's questions can be rebuilt from its id. */
function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function shuffled<T>(list: T[], seed: string): T[] {
  const rand = seeded(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The five questions of one session.
 *
 * Seeded by the session id rather than stored: the same session always asks
 * the same questions, with no extra table to keep in step. An HR round always
 * opens with "Tell me about yourself", because real ones do.
 */
export function questionsFor(kind: InterviewKind, role: RoleKey, sessionId: string, count = 5): Question[] {
  if (kind === 'HR') {
    const intro = HR[0]!;
    return [intro, ...shuffled(HR.slice(1), sessionId).slice(0, count - 1)];
  }
  if (kind === 'MANAGERIAL') return shuffled(MANAGERIAL, sessionId).slice(0, count);
  return shuffled(TECHNICAL[role], sessionId).slice(0, count);
}
