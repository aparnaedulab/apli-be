/**
 * The demo logins: one account for every situation somebody might want to
 * show, each sitting in exactly that situation.
 *
 * Every account, institution and company here belongs to the demo pack and
 * nothing else does. That is what makes "reset" safe: the pack is wiped and
 * rebuilt, and no other data on the server is touched (demoLogins.service.ts).
 *
 * Names and contact values are made up. Companies are fictional on purpose.
 */

export const DEMO_DOMAIN = 'demo-logins.example';
export const DEMO_TENANT_SLUG = 'apli-demo';

/** Fictional companies the pack owns. Reset deletes exactly these. */
export const DEMO_COMPANIES = {
  northwind: 'Northwind Analytics (Demo)',
  bluefin: 'Bluefin Software (Demo)',
  kestrel: 'Kestrel Foods (Demo)',
  harbor: 'Harbor Logistics (Demo)',
} as const;

export type DemoGroup = 'University' | 'Placement cell' | 'Company' | 'Student';

export interface DemoScenario {
  /** Local part before @, and the stable key of the scenario. */
  local: string;
  /** Sub-domain, e.g. "eng" gives tpo@eng.demo-logins.example. */
  box?: string;
  group: DemoGroup;
  name: string;
  /** The situation the login is in, in one line. */
  situation: string;
  /** What to do with it, in the order a demo would do it. */
  tryThis: string[];
}

export const emailOf = (s: Pick<DemoScenario, 'local' | 'box'>) =>
  `${s.local}@${s.box ? `${s.box}.` : ''}${DEMO_DOMAIN}`;

export const SCENARIOS: DemoScenario[] = [
  // --- University -----------------------------------------------------------
  {
    local: 'university',
    group: 'University',
    name: 'Rekha Deshmukh',
    situation: 'University admin of Apli Demo University: two colleges, students, companies and activity.',
    tryThis: ['Overview: students, simulations, offers and interviews', 'Colleges > Demo College of Engineering', 'Set up and Role management'],
  },
  {
    local: 'auditor',
    group: 'University',
    name: 'Sanjay Bapat',
    situation: 'Read-only auditor at the university: can look at everything, change nothing.',
    tryThis: ['Open Students and Colleges', 'Notice that there is nothing to edit'],
  },

  // --- Placement cell -------------------------------------------------------
  {
    local: 'tpo',
    box: 'eng',
    group: 'Placement cell',
    name: 'Dr. Anjali Kulkarni',
    situation: 'Placement officer, Demo College of Engineering: a job request waiting, an unverified student, open seasons.',
    tryThis: [
      'Job requests: approve or decline Bluefin Software\'s role',
      'Batches > IT 2028: verify & freeze Nikhil Joshi',
      'Placement seasons, Offers and Reports',
    ],
  },
  {
    local: 'coordinator',
    box: 'eng',
    group: 'Placement cell',
    name: 'Prof. Vivek Sathe',
    situation: 'Coordinator at the same college, with fewer powers than the officer.',
    tryThis: ['Compare the menu with the placement officer\'s', 'Batches and Job requests'],
  },
  {
    local: 'verifier',
    box: 'eng',
    group: 'Placement cell',
    name: 'Meena Patil',
    situation: 'Verifier: may only check and lock student records.',
    tryThis: ['Batches > IT 2028: verify & freeze a student', 'Try to open anything else'],
  },
  {
    local: 'tpo',
    box: 'com',
    group: 'Placement cell',
    name: 'Dr. Suresh Naik',
    situation: 'Placement officer of Demo College of Commerce: a brand-new college with nothing set up yet.',
    tryThis: ['Follow the getting-started checklist', 'Create a batch and add students'],
  },

  // --- Companies ------------------------------------------------------------
  {
    local: 'recruiter',
    box: 'northwind',
    group: 'Company',
    name: 'Kavita Rao',
    situation: 'Verified company with everything going on: work to review, interviews at every round, offers, applicants.',
    tryThis: [
      'Students\' work: approve Rohan Mehta\'s hand-in (issues a certificate)',
      'Interviews: give a verdict on Aditya Kale (round 1)',
      'Interviews: Ishita Rane cleared every round - offer her the internship',
      'Jobs > applicants: shortlist or reject',
    ],
  },
  {
    local: 'interviewer',
    box: 'northwind',
    group: 'Company',
    name: 'Arun Pillai',
    situation: 'Interviewer at Northwind: records round verdicts but cannot make offers.',
    tryThis: ['Interviews: open a student and mark the round', 'Notice there is no offer button'],
  },
  {
    local: 'recruiter',
    box: 'bluefin',
    group: 'Company',
    name: 'Farhan Shaikh',
    situation: 'Verified company whose job is still waiting for the college to approve it.',
    tryThis: ['Jobs: see the role waiting on the college', 'Simulations: its live simulation'],
  },
  {
    local: 'recruiter',
    box: 'kestrel',
    group: 'Company',
    name: 'Leena Fernandes',
    situation: 'Company that just signed up. Until Apli.ai verifies it, signing in shows "still being reviewed".',
    tryThis: ['Try to sign in: see the "still being reviewed" message', 'Super admin > Companies: verify Kestrel Foods', 'Sign in again: it now gets in'],
  },
  {
    local: 'recruiter',
    box: 'harbor',
    group: 'Company',
    name: 'Manoj Thakur',
    situation: 'Verified company with nothing created yet: a clean start.',
    tryThis: ['Simulations > New: write a simulation from scratch', 'Interviews > New: build an interview process'],
  },

  // --- Students -------------------------------------------------------------
  {
    local: 'new.student',
    group: 'Student',
    name: 'Nikhil Joshi',
    situation: 'Just joined. The college has not verified him yet, so he cannot apply to jobs.',
    tryThis: ['Complete the profile', 'Open a job and see why applying is blocked'],
  },
  {
    local: 'fresh',
    group: 'Student',
    name: 'Priya Shinde',
    situation: 'Verified, profile complete, nothing started.',
    tryThis: ['Simulations: start one', 'Jobs: apply to Northwind\'s Graduate Data Analyst role'],
  },
  {
    local: 'sim.started',
    group: 'Student',
    name: 'Omkar Pawar',
    situation: 'Half-way through a simulation: task 1 handed in, task 2 to do.',
    tryThis: ['Dashboard > Continue', 'Hand in task 2 and task 3, explain the work, send it'],
  },
  {
    local: 'sim.review',
    group: 'Student',
    name: 'Rohan Mehta',
    situation: 'Handed in a whole simulation; waiting for Northwind to review it.',
    tryThis: ['See the "with the company" status', 'Then approve it from the Northwind login'],
  },
  {
    local: 'sim.changes',
    group: 'Student',
    name: 'Sneha Gokhale',
    situation: 'The company asked for changes on her hand-in.',
    tryThis: ['Read the reviewer\'s note', 'Fix the task and send it again'],
  },
  {
    local: 'sim.certified',
    group: 'Student',
    name: 'Tanvi Kulkarni',
    situation: 'Certificate earned, not shared with anyone yet.',
    tryThis: ['Certificates: verify, print, copy the link', 'Share the work with Northwind or Bluefin'],
  },
  {
    local: 'interview.invited',
    group: 'Student',
    name: 'Yash Chavan',
    situation: 'Invited to interview by Northwind; has not answered.',
    tryThis: ['Interviews: accept (or decline) the invite'],
  },
  {
    local: 'interview.round1',
    group: 'Student',
    name: 'Aditya Kale',
    situation: 'Accepted the interview; round 1 (profile review) is with the company.',
    tryThis: ['See the rounds ahead', 'Then pass him from the Northwind login and watch round 2 open'],
  },
  {
    local: 'interview.round2',
    group: 'Student',
    name: 'Gauri Apte',
    situation: 'Passed round 1. Round 2 is a recorded video interview waiting for her answers.',
    tryThis: ['Interviews: record the three video answers and send them'],
  },
  {
    local: 'interview.round3',
    group: 'Student',
    name: 'Harsh More',
    situation: 'Passed two rounds. Round 3 is a live interview with a meeting link.',
    tryThis: ['Interviews: see the live round and its link', 'Then pass or fail him from the Northwind login'],
  },
  {
    local: 'interview.cleared',
    group: 'Student',
    name: 'Ishita Rane',
    situation: 'Cleared every round at Northwind; waiting for the company\'s offer.',
    tryThis: ['See "Cleared every round"', 'Then send her an internship offer from the Northwind login'],
  },
  {
    local: 'interview.rejected',
    group: 'Student',
    name: 'Kabir Jadhav',
    situation: 'Did not pass round 2 at Northwind.',
    tryThis: ['Interviews: see the round verdicts'],
  },
  {
    local: 'offer.waiting',
    group: 'Student',
    name: 'Mira Deshpande',
    situation: 'Has an internship offer from Northwind waiting for her reply.',
    tryThis: ['Jobs > Internship offers: accept or decline with a note'],
  },
  {
    local: 'offer.accepted',
    group: 'Student',
    name: 'Varun Bhosale',
    situation: 'Accepted an internship offer; the company contact is shown.',
    tryThis: ['Jobs > Internship offers: see the accepted offer'],
  },
  {
    local: 'offer.lapsed',
    group: 'Student',
    name: 'Riya Sawant',
    situation: 'An internship offer she never answered; its reply-by date has passed.',
    tryThis: ['See the lapsed offer'],
  },
  {
    local: 'job.applied',
    group: 'Student',
    name: 'Siddharth Naik',
    situation: 'Applied to Northwind\'s Graduate Data Analyst role; nothing has happened yet.',
    tryThis: ['Jobs > My applications', 'Then shortlist or reject him from the Northwind login'],
  },
  {
    local: 'job.shortlisted',
    group: 'Student',
    name: 'Pooja Phadke',
    situation: 'Shortlisted for Northwind\'s Graduate Data Analyst role.',
    tryThis: ['Jobs > My applications: see the step track', 'Then invite her to interview from the Northwind login'],
  },
  {
    local: 'job.offer',
    group: 'Student',
    name: 'Tejas Gaikwad',
    situation: 'Has a full-time job offer from Northwind (shown as "Offer made").',
    tryThis: ['Jobs > My applications: see the offer'],
  },
  {
    local: 'placed',
    group: 'Student',
    name: 'Shruti Ranade',
    situation: 'Accepted a full-time offer; her other application closed under the one-offer rule.',
    tryThis: ['Jobs > My applications', 'Placement officer > Offers: she is tracked to joining'],
  },
  {
    local: 'busy',
    group: 'Student',
    name: 'Arjun Mane',
    situation: 'A bit of everything: a certificate, an interview at round 2, an offer waiting and a simulation under way.',
    tryThis: ['Dashboard: every section filled', 'Use him for a full student tour'],
  },
];
