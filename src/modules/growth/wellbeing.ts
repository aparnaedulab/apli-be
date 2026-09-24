/**
 * The practice ladder: small steps from the least scary to the real thing.
 * `module` is the feature a step links to; the screen shows the step without
 * a link when the institution does not have it.
 */
export const LADDER = [
  { key: 'aptitude', label: 'Do one short aptitude practice set', to: '/student/practice', module: 'dev.aptitude' },
  { key: 'speak', label: 'Answer today’s speaking prompt', to: '/student/soft-skills', module: 'dev.softSkills' },
  { key: 'mock-typed', label: 'Answer one interview question in writing', to: '/student/interview', module: 'dev.mockInterview' },
  { key: 'mock-voice', label: 'Answer one interview question out loud', to: '/student/interview', module: 'dev.mockInterview' },
  { key: 'gd', label: 'Take part in a practice group discussion', to: '/student/gd', module: 'dev.gd' },
  { key: 'mock-full', label: 'Complete a full mock interview', to: '/student/interview', module: 'dev.mockInterview' },
  { key: 'apply', label: 'Apply for one real role', to: '/student/jobs', module: null },
] as const;
