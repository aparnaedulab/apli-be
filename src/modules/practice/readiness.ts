/**
 * The readiness check: six areas, a few honest questions each, a score out of
 * a hundred - and a plan for the week built from the two weakest areas.
 *
 * Pure, so the maths can be tested without a database and the screen and the
 * server cannot disagree about what a set of answers means.
 *
 * The score is the student's own measure of themselves over time. It is never
 * ranked against classmates: a readiness number next to other people's names
 * turns a tool for getting better into a reason to feel worse.
 */

export const AREAS = ['aptitude', 'technical', 'communication', 'interview', 'presence', 'clarity'] as const;
export type Area = (typeof AREAS)[number];
export type AreaScores = Record<Area, number>;

export const AREA_LABELS: Record<Area, string> = {
  aptitude: 'Aptitude',
  technical: 'Technical skills',
  communication: 'Communication',
  interview: 'Interview skills',
  presence: 'Professional presence',
  clarity: 'Career clarity',
};

export interface CheckQuestion {
  key: string;
  area: Area;
  text: string;
}

/**
 * Statements the student rates 1 (not at all like me) to 5 (very like me).
 * Written as things a person can check against their own week, not as
 * adjectives - "I have practised a timed test" rather than "I am good at
 * aptitude" - because people answer those more honestly.
 */
export const CHECK_QUESTIONS: CheckQuestion[] = [
  { key: 'apt1', area: 'aptitude', text: 'I can finish a 20-question aptitude test in the time allowed.' },
  { key: 'apt2', area: 'aptitude', text: 'Percentages, ratios and time-and-work questions feel familiar.' },
  { key: 'apt3', area: 'aptitude', text: 'I have practised a timed test in the last two weeks.' },

  { key: 'tec1', area: 'technical', text: 'I can explain the main project on my profile, and why I built it that way.' },
  { key: 'tec2', area: 'technical', text: 'I could answer basic questions on the core subjects of my branch.' },
  { key: 'tec3', area: 'technical', text: 'I have built or practised something outside the syllabus this term.' },

  { key: 'com1', area: 'communication', text: 'I can speak for two minutes on a topic without long pauses.' },
  { key: 'com2', area: 'communication', text: 'I can write a short, clear email to a recruiter.' },
  { key: 'com3', area: 'communication', text: 'In a group discussion, I can get my point in without talking over people.' },

  { key: 'int1', area: 'interview', text: 'I have a ready answer to "Tell me about yourself" that takes about a minute.' },
  { key: 'int2', area: 'interview', text: 'I can describe a problem I solved - the situation, what I did, and the result.' },
  { key: 'int3', area: 'interview', text: 'I have done a mock interview, with someone or with a practice tool.' },

  { key: 'pre1', area: 'presence', text: 'I know what to wear for the kind of company I am applying to.' },
  { key: 'pre2', area: 'presence', text: 'My camera, light and sound are ready for an online interview.' },
  { key: 'pre3', area: 'presence', text: 'I know how to greet, follow up and thank an interviewer.' },

  { key: 'cla1', area: 'clarity', text: 'I can name two or three roles I actually want.' },
  { key: 'cla2', area: 'clarity', text: 'I know what those roles do day to day.' },
  { key: 'cla3', area: 'clarity', text: 'My profile shows why I would be good at them.' },
];

const QUESTION_KEYS = new Set(CHECK_QUESTIONS.map((q) => q.key));

export function isQuestionKey(key: string): boolean {
  return QUESTION_KEYS.has(key);
}

/** 1-5 answers → 0-100 per area. An area with no answers scores nothing rather than guessing. */
export function scoreAnswers(answers: Record<string, number>): AreaScores {
  const out = {} as AreaScores;
  for (const area of AREAS) {
    const values = CHECK_QUESTIONS.filter((q) => q.area === area)
      .map((q) => answers[q.key])
      .filter((v): v is number => typeof v === 'number' && v >= 1 && v <= 5);
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 1;
    out[area] = Math.round(((mean - 1) / 4) * 100);
  }
  return out;
}

/** The single number: the plain average of the six areas. */
export function composite(scores: AreaScores): number {
  return Math.round(AREAS.reduce((sum, a) => sum + (scores[a] ?? 0), 0) / AREAS.length);
}

/**
 * How many practice answers it takes before real accuracy outweighs what the
 * student said about themselves. Ten is enough to mean something and few
 * enough to reach in one sitting.
 */
export const PRACTICE_THRESHOLD = 10;

/**
 * Aptitude is the one area there is hard evidence for. Once a student has
 * practised enough, their actual accuracy counts for more than their own
 * rating - 60 / 40 - so the score moves when they improve, not only when they
 * feel better.
 */
export function blendAptitude(selfScore: number, practice: { attempts: number; correct: number }): number {
  if (practice.attempts < PRACTICE_THRESHOLD) return selfScore;
  const accuracy = (practice.correct / practice.attempts) * 100;
  return Math.round(0.4 * selfScore + 0.6 * accuracy);
}

export interface PlanTask {
  title: string;
  why: string;
  to: string;
  action: string;
}

export interface WeekPlan {
  focus: { area: Area; label: string; score: number }[];
  tasks: PlanTask[];
}

/** What to do about each area, pointing at a screen that exists. */
const TASKS: Record<Area, PlanTask[]> = {
  aptitude: [
    { title: 'Practise your weakest topics', why: 'Ten questions a day on the topics you miss most.', to: '/student/practice', action: 'Practise' },
    { title: 'Take one timed test', why: 'Twenty questions in twenty minutes, like the real first round.', to: '/student/practice?mode=MIXED', action: 'Start test' },
  ],
  technical: [
    { title: 'Write up your best project', why: 'What it does, what you built, what you would change.', to: '/student/profile', action: 'Update profile' },
    { title: 'Revise one core subject', why: 'Technical practice questions cover programming, DBMS and OS basics.', to: '/student/practice?section=TECHNICAL', action: 'Practise' },
  ],
  communication: [
    { title: 'Answer one question out loud', why: 'A mock interview answer, spoken, shows where you pause.', to: '/student/interview', action: 'Practise' },
    { title: 'Learn the email templates', why: 'Replying to HR, following up, saying thank you.', to: '/student/prepare', action: 'Open' },
  ],
  interview: [
    { title: 'Do a mock interview', why: 'Five questions with feedback on structure and clarity.', to: '/student/interview', action: 'Start' },
    { title: 'Prepare "Tell me about yourself"', why: 'One minute, built from your own profile.', to: '/student/interview', action: 'Practise' },
  ],
  presence: [
    { title: 'Check your camera and light', why: 'A two-minute check before any online interview.', to: '/student/prepare', action: 'Check' },
    { title: 'Plan what to wear', why: 'Guides by industry and budget.', to: '/student/prepare', action: 'Open' },
  ],
  clarity: [
    { title: 'Name the roles you want', why: 'A headline and an "about" that point at them.', to: '/student/profile', action: 'Update profile' },
    { title: 'Read what companies ask for', why: 'Open roles at your college show the skills in demand.', to: '/student/jobs', action: 'Browse jobs' },
  ],
};

/**
 * The two weakest areas, and two things to do about each. Ties go to the
 * order the areas are listed in, so the same scores always give the same plan.
 */
export function planFor(scores: AreaScores): WeekPlan {
  const focus = [...AREAS]
    .map((area, i) => ({ area, i, score: scores[area] ?? 0 }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .slice(0, 2)
    .map(({ area, score }) => ({ area, label: AREA_LABELS[area], score }));
  return { focus, tasks: focus.flatMap((f) => TASKS[f.area]) };
}
