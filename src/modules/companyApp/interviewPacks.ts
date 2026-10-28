/**
 * Question packs a company can pull into a recorded-interview round instead
 * of writing every question itself. These ship with Apli.ai; packs the
 * platform team adds later live in InterviewQuestionPackage and are listed
 * beside them.
 */

export interface PackQuestion {
  text: string;
  hint?: string;
  type: 'intro' | 'behavioural' | 'situational' | 'technical' | 'motivation';
}

export interface Pack {
  id: string;
  title: string;
  description: string;
  role: string;
  questions: PackQuestion[];
}

export const BUILT_IN_PACKS: Pack[] = [
  {
    id: 'builtin-first-round',
    title: 'First conversation',
    description: 'Five questions for any role: who they are, why this, and how they work.',
    role: '',
    questions: [
      { type: 'intro', text: 'Tell us about yourself in a minute - what you study and what you enjoy working on.' },
      { type: 'motivation', text: 'Why do you want this role, and why with us?', hint: 'Be specific about the work, not the company name.' },
      {
        type: 'behavioural',
        text: 'Tell us about something you built or did that you are proud of. What was your part in it?',
      },
      { type: 'behavioural', text: 'Describe a time something went wrong in a project. What did you do next?' },
      { type: 'motivation', text: 'Where do you want to be a year after this internship?' },
    ],
  },
  {
    id: 'builtin-internship',
    title: 'Internship readiness',
    description: 'For interns: learning, feedback, and working with a team for the first time.',
    role: 'Intern',
    questions: [
      { type: 'behavioural', text: 'Tell us about a time you had to learn something quickly. How did you go about it?' },
      { type: 'situational', text: 'Your manager gives you a task you do not understand. What do you do in the first hour?' },
      { type: 'behavioural', text: 'Tell us about feedback that changed how you work.' },
      { type: 'situational', text: 'You will miss a deadline by a day. When and how do you tell your team?' },
    ],
  },
  {
    id: 'builtin-work-simulation',
    title: 'About your simulation work',
    description: 'For students who did one of your simulations: how they thought it through.',
    role: '',
    questions: [
      { type: 'technical', text: 'Walk us through how you approached the simulation, task by task.' },
      { type: 'technical', text: 'Which task was hardest, and what did you try before it worked?' },
      { type: 'situational', text: 'If you had one more day on it, what would you change in your work?' },
    ],
  },
];
