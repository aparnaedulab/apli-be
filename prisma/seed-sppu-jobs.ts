/**
 * Jobs from the real companies in the SPPU demo: full-time roles and paid
 * internships, published and posted to SPPU's open placement drives.
 *
 *   npx tsx prisma/seed-sppu-jobs.ts        (or npm run db:seed:sppu-jobs)
 *
 * The showcase seed calls this at the end, so a rebuilt demo has them too.
 * Safe to run again: it first removes the jobs it added last time (matched by
 * company and title), then adds them afresh. Pay is in rupees; every figure
 * is demo data, not the companies' real offers.
 */
import { ApplicationStatus, JobStatus, PostingStatus } from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { loadCandidateContext, resolvePlacementFor, visibleJobWhere } from '../src/modules/jobs/visibility.js';
import { rebuildDemoNotifications } from './rebuild-demo-notifications.js';

const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const ahead = (d: number) => new Date(Date.now() + d * DAY);
const L = 100_000; // one lakh

interface JobDef {
  company: string;
  title: string;
  type: 'FULL_TIME' | 'INTERNSHIP';
  workMode: 'Hybrid' | 'On-site' | 'Remote';
  location: string;
  openings: number;
  /** Full-time: CTC range in lakhs a year. */
  ctc?: [number, number];
  /** Internship: stipend a month, and months. */
  stipend?: number;
  months?: number;
  /** Internship: the full-time CTC on conversion, in lakhs. */
  ppo?: number;
  minCgpa: number;
  courses: string[];
  description: string;
  responsibilities: string;
  rounds: [string, string][];
  /** Days until applications close. */
  closes: number;
}

const R = {
  screen: ['Profile and simulation review', 'RESUME_SCREEN'] as [string, string],
  test: ['Online assessment', 'MCQ_TEST'] as [string, string],
  video: ['Recorded video interview', 'VIDEO_INTERVIEW'] as [string, string],
  tech: ['Technical interview', 'LIVE_INTERVIEW'] as [string, string],
  case: ['Case interview', 'LIVE_INTERVIEW'] as [string, string],
  gd: ['Group discussion', 'GROUP_DISCUSSION'] as [string, string],
  hr: ['HR conversation', 'LIVE_INTERVIEW'] as [string, string],
};

const ENG = ['B.Tech', 'B.E.'];
const JOBS: JobDef[] = [
  {
    company: 'JPMorgan Chase & Co.', title: 'Software Engineer - Analyst Program', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Mumbai',
    openings: 12, ctc: [16, 19], minCgpa: 7.5, courses: [...ENG, 'MCA'], closes: 21,
    description: 'Join a technology team building the trading, payments and risk platforms the bank runs on. Two years of rotations across teams, with structured training in the first six months.',
    responsibilities: 'Design, build and test services in Java or Python.\nWork with traders and analysts to understand what they need.\nReview code and keep production healthy.',
    rounds: [R.screen, R.test, R.tech, R.hr],
  },
  {
    company: 'JPMorgan Chase & Co.', title: 'Summer Analyst - Corporate & Investment Bank Technology', type: 'INTERNSHIP', workMode: 'On-site', location: 'Mumbai',
    openings: 20, stipend: 75_000, months: 2, ppo: 17, minCgpa: 7.5, courses: [...ENG], closes: 14,
    description: 'An eight-week internship on a live engineering team. Strong interns receive a full-time offer at the end of the summer.',
    responsibilities: 'Ship a project end to end with your team.\nPresent your work to senior engineers in week eight.',
    rounds: [R.screen, R.test, R.tech],
  },
  {
    company: 'Goldman Sachs', title: 'Analyst - Controllers', type: 'FULL_TIME', workMode: 'On-site', location: 'Bengaluru',
    openings: 8, ctc: [14, 17], minCgpa: 7.0, courses: ['B.Com', 'BBA', 'MBA', ...ENG], closes: 28,
    description: 'Make sure the firm\'s financial reporting is right. You will work on fund accounting, net asset value and the controls behind them.',
    responsibilities: 'Reconcile positions and balances across funds.\nInvestigate breaks and explain them.\nAutomate checks that are done by hand today.',
    rounds: [R.screen, R.test, R.tech, R.hr],
  },
  {
    company: 'Goldman Sachs', title: 'Summer Analyst - Engineering', type: 'INTERNSHIP', workMode: 'On-site', location: 'Bengaluru',
    openings: 15, stipend: 80_000, months: 2, ppo: 22, minCgpa: 8.0, courses: [...ENG], closes: 10,
    description: 'Ten weeks in the engineering division building tools used across the firm, with a full-time offer for strong interns.',
    responsibilities: 'Build features in a production codebase.\nWrite tests and documentation.\nDemo your project at the end of the summer.',
    rounds: [R.screen, R.test, R.tech, R.tech],
  },
  {
    company: 'Bank of America', title: 'Investment Banking Analyst', type: 'FULL_TIME', workMode: 'On-site', location: 'Mumbai',
    openings: 6, ctc: [18, 22], minCgpa: 8.0, courses: ['MBA', 'B.Com', ...ENG], closes: 25,
    description: 'Work on mergers, acquisitions and capital raising for clients in technology, media and telecom.',
    responsibilities: 'Build financial models and valuations.\nPrepare client presentations.\nResearch companies and industries.',
    rounds: [R.screen, R.test, R.case, R.hr],
  },
  {
    company: 'Bank of America', title: 'Global Technology Analyst', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Hyderabad',
    openings: 10, ctc: [12, 15], minCgpa: 7.0, courses: [...ENG, 'MCA'], closes: 30,
    description: 'Engineer the systems behind one of the world\'s largest banks, with a two-year rotation programme.',
    responsibilities: 'Build and support banking applications.\nWork in an agile team with daily releases.',
    rounds: [R.screen, R.test, R.tech, R.hr],
  },
  {
    company: 'BCG', title: 'Associate', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Mumbai',
    openings: 5, ctc: [24, 28], minCgpa: 8.5, courses: ['MBA', ...ENG], closes: 18,
    description: 'Solve strategy problems for leading companies in India and abroad as part of a small case team.',
    responsibilities: 'Structure the client\'s problem and analyse the data.\nBuild the recommendation and present it.\nWork directly with client teams.',
    rounds: [R.screen, R.test, R.case, R.case],
  },
  {
    company: 'BCG', title: 'Analytics Associate - BCG X', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Gurugram',
    openings: 6, ctc: [15, 18], minCgpa: 7.5, courses: [...ENG, 'M.Tech', 'MCA'], closes: 26,
    description: 'Data science and analytics on consulting cases, from pricing models to customer churn.',
    responsibilities: 'Clean and model client data.\nBuild dashboards and models the case team uses.',
    rounds: [R.screen, R.test, R.tech, R.case],
  },
  {
    company: 'PwC', title: 'Cyber Security Associate', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Kolkata',
    openings: 15, ctc: [7, 9], minCgpa: 6.5, courses: [...ENG, 'MCA', 'B.Sc'], closes: 24,
    description: 'Help clients find and fix the risks in their systems and processes, from access controls to cloud security.',
    responsibilities: 'Run risk and control assessments.\nTest security controls.\nWrite clear findings for clients.',
    rounds: [R.screen, R.test, R.tech, R.hr],
  },
  {
    company: 'PwC', title: 'Audit & Assurance Associate', type: 'FULL_TIME', workMode: 'On-site', location: 'Pune',
    openings: 20, ctc: [6, 7.5], minCgpa: 6.5, courses: ['B.Com', 'BBA', 'M.Com', 'MBA'], closes: 32,
    description: 'Audit the financial statements of large Indian and global companies, with on-the-job training.',
    responsibilities: 'Test transactions and balances.\nDocument audit work.\nWork on client sites with your team.',
    rounds: [R.screen, R.test, R.gd, R.hr],
  },
  {
    company: 'Accenture', title: 'Associate Software Engineer', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Pune',
    openings: 60, ctc: [4.5, 6.5], minCgpa: 6.0, courses: [...ENG, 'MCA', 'B.Sc', 'BCA'], closes: 35,
    description: 'Start your career building software for global clients, with three months of paid training.',
    responsibilities: 'Develop and test applications.\nLearn a cloud or data platform.\nWork with client teams across time zones.',
    rounds: [R.screen, R.test, R.video, R.hr],
  },
  {
    company: 'Accenture', title: 'Data Analyst Intern', type: 'INTERNSHIP', workMode: 'Hybrid', location: 'Pune',
    openings: 12, stipend: 30_000, months: 6, ppo: 7, minCgpa: 6.5, courses: [...ENG, 'MCA', 'B.Sc', 'BCA'], closes: 15,
    description: 'Six months with the data and AI practice, working on client analytics projects.',
    responsibilities: 'Clean and analyse client data.\nBuild dashboards in Power BI.\nPresent insights to the project team.',
    rounds: [R.screen, R.test, R.video],
  },
  {
    company: 'Tata Group', title: 'Graduate Engineer Trainee', type: 'FULL_TIME', workMode: 'On-site', location: 'Pune',
    openings: 40, ctc: [6, 8], minCgpa: 6.5, courses: [...ENG], closes: 30,
    description: 'A one-year trainee programme across a Tata group company\'s engineering and operations teams.',
    responsibilities: 'Rotate through plant, quality and design teams.\nDeliver an improvement project in your first year.',
    rounds: [R.screen, R.test, R.gd, R.hr],
  },
  {
    company: 'Tata Group', title: 'Business Analytics Associate', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Mumbai',
    openings: 8, ctc: [9, 12], minCgpa: 7.0, courses: ['MBA', ...ENG, 'MCA'], closes: 22,
    description: 'Turn business data into decisions for a Tata group company\'s leadership.',
    responsibilities: 'Build dashboards and reports.\nAnalyse sales and operations data.\nPresent findings to managers.',
    rounds: [R.screen, R.test, R.case, R.hr],
  },
  {
    company: 'Mastercard', title: 'Software Engineer I', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Pune',
    openings: 10, ctc: [13, 16], minCgpa: 7.5, courses: [...ENG, 'MCA'], closes: 27,
    description: 'Build the payment network services used by billions of cards, at the Pune technology hub.',
    responsibilities: 'Write and test Java microservices.\nImprove reliability and performance.\nShip features with your squad.',
    rounds: [R.screen, R.test, R.tech, R.hr],
  },
  {
    company: 'Mastercard', title: 'Cybersecurity Analyst', type: 'FULL_TIME', workMode: 'On-site', location: 'Pune',
    openings: 5, ctc: [11, 14], minCgpa: 7.0, courses: [...ENG, 'MCA', 'M.Tech'], closes: 20,
    description: 'Protect the payment network: monitor threats, run phishing tests and respond to incidents.',
    responsibilities: 'Monitor and triage security alerts.\nRun security awareness campaigns.\nSupport incident response.',
    rounds: [R.screen, R.test, R.tech],
  },
  {
    company: 'Deloitte', title: 'Analyst - Technology Consulting', type: 'FULL_TIME', workMode: 'Hybrid', location: 'Hyderabad',
    openings: 25, ctc: [7.5, 9.5], minCgpa: 6.5, courses: [...ENG, 'MCA', 'MBA'], closes: 29,
    description: 'Help clients plan and deliver technology change, from ERP roll-outs to data platforms.',
    responsibilities: 'Gather requirements and map processes.\nConfigure and test solutions.\nSupport go-lives with the client.',
    rounds: [R.screen, R.test, R.gd, R.hr],
  },
  {
    company: 'Deloitte', title: 'Risk Advisory Intern', type: 'INTERNSHIP', workMode: 'Hybrid', location: 'Pune',
    openings: 10, stipend: 25_000, months: 3, ppo: 8, minCgpa: 6.5, courses: ['B.Com', 'BBA', 'MBA', ...ENG], closes: 12,
    description: 'Three months with the risk advisory team on internal audit and controls projects.',
    responsibilities: 'Test controls and document findings.\nResearch regulations for the team.',
    rounds: [R.screen, R.video, R.hr],
  },
  {
    company: 'Johnson & Johnson', title: 'Graduate Engineer - MedTech', type: 'FULL_TIME', workMode: 'On-site', location: 'Mumbai',
    openings: 6, ctc: [9, 11], minCgpa: 7.0, courses: [...ENG], closes: 26,
    description: 'Engineer surgical and orthopaedic technology on a MedTech product team.',
    responsibilities: 'Design and test device components.\nSupport verification and validation.\nDocument for regulatory review.',
    rounds: [R.screen, R.test, R.tech, R.hr],
  },
  {
    company: 'Johnson & Johnson', title: 'Supply Chain Intern', type: 'INTERNSHIP', workMode: 'On-site', location: 'Mumbai',
    openings: 6, stipend: 35_000, months: 6, ppo: 9, minCgpa: 6.5, courses: [...ENG, 'MBA'], closes: 16,
    description: 'Six months improving how products move from plant to hospital.',
    responsibilities: 'Analyse supply and demand data.\nFind and fix a bottleneck in a live process.',
    rounds: [R.screen, R.video, R.hr],
  },
  {
    company: 'White & Case', title: 'Trainee Associate', type: 'FULL_TIME', workMode: 'On-site', location: 'Mumbai',
    openings: 3, ctc: [15, 18], minCgpa: 7.0, courses: ['B.A. LL.B', 'BBA LL.B', 'LL.M'], closes: 24,
    description: 'Train in the projects and finance practice on cross-border transactions.',
    responsibilities: 'Research and draft documents.\nSupport deal teams on live transactions.',
    rounds: [R.screen, R.test, R.tech],
  },
  {
    company: 'CBRE', title: 'Graduate Trainee - Project Management', type: 'FULL_TIME', workMode: 'On-site', location: 'Pune',
    openings: 10, ctc: [5, 6.5], minCgpa: 6.0, courses: [...ENG, 'B.Arch', 'MBA'], closes: 31,
    description: 'Deliver office fit-outs and building projects for corporate clients.',
    responsibilities: 'Plan schedules and track progress on site.\nManage vendors and budgets.\nReport to the client every week.',
    rounds: [R.screen, R.gd, R.hr],
  },
  {
    company: 'Electronic Arts', title: 'Software Engineer - Games', type: 'FULL_TIME', workMode: 'On-site', location: 'Hyderabad',
    openings: 8, ctc: [14, 18], minCgpa: 7.5, courses: [...ENG, 'MCA'], closes: 23,
    description: 'Build features and tools for games played by millions, in C++ and C#.',
    responsibilities: 'Implement gameplay and engine features.\nProfile and fix performance problems.\nWork with designers and artists.',
    rounds: [R.screen, R.test, R.tech, R.tech],
  },
  {
    company: 'Electronic Arts', title: 'QA Engineer Intern', type: 'INTERNSHIP', workMode: 'On-site', location: 'Hyderabad',
    openings: 10, stipend: 40_000, months: 6, ppo: 10, minCgpa: 6.5, courses: [...ENG, 'MCA', 'BCA'], closes: 13,
    description: 'Six months testing unreleased games and the tools behind them.',
    responsibilities: 'Write and run test plans.\nReport bugs clearly.\nAutomate repeated checks.',
    rounds: [R.screen, R.test, R.video],
  },
];

/** A small seeded random, so every run applies the same students to the same jobs. */
let seed = 20261030;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

/** The academic year 2026-27: final years pass out in 2027, the year below in 2028. */
const FINAL_YEAR = 2027;

/**
 * Every SPPU college gets the two drives jobs are posted to, with its
 * students' batches in them: final placements for the final year, summer
 * internships for the final year and the year below.
 */
async function ensureDrives(tenantId: string) {
  const colleges = await prisma.college.findMany({ where: { tenantId }, select: { id: true } });
  for (const college of colleges) {
    const batches = await prisma.batch.findMany({
      where: { collegeId: college.id, graduationYear: { in: [FINAL_YEAR, FINAL_YEAR + 1] } },
      select: { id: true, graduationYear: true },
    });
    const drives: [string, 'FINAL' | 'INTERNSHIP', { id: string }[]][] = [
      ['2026 Final Placements', 'FINAL', batches.filter((b) => b.graduationYear === FINAL_YEAR).map((b) => ({ id: b.id }))],
      ['2026 Summer Internships', 'INTERNSHIP', batches.map((b) => ({ id: b.id }))],
    ];
    for (const [name, type, connect] of drives) {
      await prisma.placement.upsert({
        where: { collegeId_name_year: { collegeId: college.id, name, year: 2026 } },
        create: { collegeId: college.id, name, type, year: 2026, isOpen: true, batches: { connect } },
        update: { isOpen: true, batches: { connect } },
      });
    }
  }
  return prisma.placement.findMany({ where: { isOpen: true, year: 2026, college: { tenantId } }, select: { id: true, type: true } });
}

export async function addShowcaseJobs() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'sppu' }, select: { id: true } });
  if (!tenant) throw new Error('No tenant with slug "sppu".');
  const placements = await ensureDrives(tenant.id);
  const admin = await prisma.user.findFirst({ where: { email: 'admin@apli.example' }, select: { id: true } });

  // A record with nothing on it for backlogs fails every role that asks for
  // "no active backlogs"; the demo students have none.
  const sppu = { OR: [{ college: { tenantId: tenant.id } }, { batchMemberships: { some: { batch: { tenantId: tenant.id } } } }] };
  await prisma.candidate.updateMany({ where: { AND: [sppu, { activeBacklogs: null }] }, data: { activeBacklogs: 0 } });
  await prisma.candidate.updateMany({ where: { AND: [sppu, { backlogs: null }] }, data: { backlogs: 0 } });
  await prisma.candidate.updateMany({ where: { AND: [sppu, { gapYears: null }] }, data: { gapYears: 0 } });

  // Clear what the last run added: the jobs (their applications go with
  // them) and the interview process made for each.
  for (const companyName of new Set(JOBS.map((j) => j.company))) {
    const titles = JOBS.filter((j) => j.company === companyName).map((j) => j.title);
    await prisma.job.deleteMany({ where: { company: { name: companyName }, title: { in: titles } } });
    await prisma.interviewProcess.deleteMany({ where: { company: { name: companyName }, title: { in: titles } } });
  }

  let made = 0;
  let posted = 0;
  const built: { jobId: string; companyId: string; recruiterId: string; processId: string; title: string; rounds: number }[] = [];
  for (const [i, j] of JOBS.entries()) {
    const company = await prisma.company.findUnique({
      where: { name: j.company },
      select: { id: true, members: { take: 1, select: { userId: true } } },
    });
    if (!company?.members[0]) {
      console.log(`  skipped ${j.title}: no company called ${j.company} with a recruiter`);
      continue;
    }
    const recruiterId = company.members[0].userId;
    const intern = j.type === 'INTERNSHIP';
    const job = await prisma.job.create({
      data: {
        companyId: company.id,
        createdById: recruiterId,
        title: j.title,
        description: j.description,
        responsibilities: j.responsibilities,
        jobType: j.type,
        workMode: j.workMode,
        location: j.location,
        openings: j.openings,
        payPeriod: intern ? 'MONTHLY' : 'YEARLY',
        ctcMin: j.ctc ? j.ctc[0] * L : null,
        ctcMax: j.ctc ? j.ctc[1] * L : null,
        ctcFixed: j.ctc ? Math.round(j.ctc[0] * 0.85 * L) : null,
        ctcVariable: j.ctc ? Math.round((j.ctc[1] - j.ctc[0] * 0.85) * L) : null,
        stipendPerMonth: j.stipend ?? null,
        internshipMonths: j.months ?? null,
        ppoCtc: j.ppo ? j.ppo * L : null,
        minCgpa: j.minCgpa,
        maxActiveBacklogs: 0,
        deadline: ahead(j.closes),
        joiningFrom: intern ? ahead(60) : new Date('2027-07-01T00:00:00.000Z'),
        status: JobStatus.PUBLISHED,
        publishedAt: ago(3 + (i % 12)),
        createdAt: ago(5 + (i % 12)),
        noFeeDeclaredAt: ago(5 + (i % 12)),
        noFeeDeclaredById: recruiterId,
        rounds: {
          create: j.rounds.map(([name, type], order) => ({
            order: order + 1,
            name,
            type,
            // Every round but the last one filters; the last decides.
            isElimination: order < j.rounds.length - 1,
            isOnline: type !== 'GROUP_DISCUSSION',
          })),
        },
        courses: { create: j.courses.map((course) => ({ course })) },
        // Full-time roles are for the final year; internships for the final year and the year below.
        gradYears: { create: (intern ? [FINAL_YEAR, FINAL_YEAR + 1] : [FINAL_YEAR]).map((year) => ({ year })) },
      },
    });
    made++;

    // Posted to every SPPU college's open drive of the matching kind, approved.
    for (const p of placements.filter((x) => (intern ? x.type === 'INTERNSHIP' : x.type === 'FINAL'))) {
      await prisma.jobPosting.create({
        data: { jobId: job.id, placementId: p.id, status: PostingStatus.ACCEPTED, decidedAt: ago(2), decidedById: admin?.id ?? null },
      });
      posted++;
    }

    // The interview process for this job, the same rounds as the job's, so
    // an applicant can be invited to interview just as from a simulation.
    const process = await prisma.interviewProcess.create({
      data: {
        companyId: company.id,
        createdById: recruiterId,
        title: j.title,
        description: `The selection rounds for ${j.title}.`,
        processType: intern ? 'INTERNSHIP' : 'HIRING',
        status: 'ACTIVE',
        rounds: {
          create: j.rounds.map(([name, type], order) => ({
            order: order + 1,
            name,
            type,
            isElimination: order < j.rounds.length - 1,
            isOnline: type !== 'GROUP_DISCUSSION',
            durationMin: type === 'LIVE_INTERVIEW' ? 45 : type === 'MCQ_TEST' ? 60 : type === 'VIDEO_INTERVIEW' ? 20 : null,
            meetingLink: type === 'LIVE_INTERVIEW' ? `https://meet.sppu-demo.example/${job.id.slice(-8)}` : null,
            questionTimeSec: type === 'VIDEO_INTERVIEW' ? 90 : null,
            prepTimeSec: type === 'VIDEO_INTERVIEW' ? 30 : null,
          })),
        },
      },
      include: { rounds: { orderBy: { order: 'asc' } } },
    });
    for (const r of process.rounds.filter((x) => x.type === 'VIDEO_INTERVIEW')) {
      const qs = [`Why do you want to join ${j.company} as a ${j.title}?`, 'Tell us about a project you are proud of.', 'Describe a time you solved a hard problem.'];
      for (const [qi, text] of qs.entries()) {
        await prisma.videoInterviewQuestion.create({ data: { roundId: r.id, order: qi + 1, text, type: qi === 0 ? 'behavioural' : 'technical' } });
      }
    }
    built.push({ jobId: job.id, companyId: company.id, recruiterId, processId: process.id, title: j.title, rounds: process.rounds.length });
  }

  const applications = await addApplications(tenant.id, built);
  return { made, posted, ...applications };
}

/**
 * Students who have applied, at every stage: just applied, under review,
 * shortlisted and in an interview (round 1 or 2), and not shortlisted. Only
 * to jobs each student can actually see and is eligible for - the same rule
 * the student's own Jobs page uses.
 */
async function addApplications(
  tenantId: string,
  built: { jobId: string; companyId: string; recruiterId: string; processId: string; title: string; rounds: number }[],
) {
  // Kept free for testing by hand.
  const untouched = ['gauri.pawar14@ccoew.sppu-demo.example'];
  const students = await prisma.candidate.findMany({
    where: {
      college: { tenantId },
      batchMemberships: { some: { isFrozen: true } },
      user: { email: { notIn: untouched } },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true },
  });
  const ours = new Set(built.map((b) => b.jobId));
  let applied = 0;
  let interviewing = 0;
  for (const s of students) {
    if (rnd() < 0.45) continue;
    const ctx = await loadCandidateContext(s.id);
    const visible = (await prisma.job.findMany({ where: visibleJobWhere(ctx), select: { id: true } })).filter((j) => ours.has(j.id));
    if (!visible.length) continue;
    const picks = [...visible].sort(() => rnd() - 0.5).slice(0, rnd() < 0.6 ? 1 : 2);
    for (const pick of picks) {
      const b = built.find((x) => x.jobId === pick.id)!;
      const placementId = await resolvePlacementFor(b.jobId, ctx);
      if (!placementId) continue;
      const x = rnd();
      const status =
        x < 0.4 ? ApplicationStatus.APPLIED
          : x < 0.55 ? ApplicationStatus.UNDER_REVIEW
            : x < 0.85 ? ApplicationStatus.SHORTLISTED
              : ApplicationStatus.REJECTED;
      const daysAgo = 1 + Math.floor(rnd() * 10);
      await prisma.application.create({
        data: { candidateId: s.id, jobId: b.jobId, placementId, status, appliedAt: ago(daysAgo) },
      });
      applied++;
      // Shortlisted means invited to interview: the job's own process, in round 1 or 2.
      if (status === ApplicationStatus.SHORTLISTED) {
        const pending = rnd() < 0.35;
        const round = pending ? 1 : rnd() < 0.5 ? 1 : 2;
        const invite = await prisma.interviewInvite.create({
          data: {
            companyId: b.companyId,
            candidateId: s.id,
            processId: b.processId,
            sentById: b.recruiterId,
            role: b.title,
            message: `Thank you for applying for ${b.title}. We would like to take you through our selection rounds.`,
            status: pending ? 'PENDING' : 'ACCEPTED',
            currentRoundOrder: round,
            respondedAt: pending ? null : ago(Math.max(0, daysAgo - 2)),
            createdAt: ago(Math.max(0, daysAgo - 1)),
          },
        });
        if (round === 2) {
          const first = await prisma.interviewProcessRound.findFirstOrThrow({ where: { processId: b.processId, order: 1 } });
          await prisma.interviewRoundFeedback.create({
            data: { inviteId: invite.id, roundOrder: 1, roundName: first.name, outcome: 'PASSED', score: 70 + Math.floor(rnd() * 25), notes: 'Strong profile for the role.' },
          });
        }
        interviewing++;
      }
    }
  }
  return { applied, interviewing };
}

// Run directly: npx tsx prisma/seed-sppu-jobs.ts
if (process.argv[1]?.includes('seed-sppu-jobs')) {
  addShowcaseJobs()
    .then(async (r) => {
      const notes = await rebuildDemoNotifications();
      console.log(
        `added ${r.made} jobs, posted to ${r.posted} placement drives; ${r.applied} applications (${r.interviewing} in interviews); ${notes.total} notifications`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(disconnectPrisma);
}
