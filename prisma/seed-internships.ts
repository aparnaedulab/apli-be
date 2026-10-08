/**
 * Virtual internships and micro-internships for the demo.
 *
 * Apli.ai is a virtual internship portal that leads to jobs, and a demo with
 * an empty internships page shows none of that. This builds eight published
 * virtual internships from the verified demo companies (plus one draft, so the
 * company's authoring screen shows both states), students at every stage of
 * them, and three open paid micro-internships.
 *
 * The named demo students each sit in a state worth showing:
 *
 *   karan.iyer5        one completed with a certificate, one under way
 *   atharva.wagh.21    one with Indus Systems waiting for review, one completed
 *   sneha.patil2       explain-your-work call booked for later this week
 *   rahul.kulkarni9    just started
 *
 * Rows are written with prisma directly - no service that might send mail.
 * Deterministic: the same codes, the same students, every run.
 * Demo values only: resource links point at demo-resources.example.
 */
import { EnrolmentStatus, MicroApplicationStatus, MicroProjectStatus, SimulationStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';

const RES = 'https://www.demo-resources.example';

interface TaskDef {
  title: string;
  brief: string;
  resources?: { label: string; url: string }[];
  /** What a decent student answer looks like, used for the seeded submissions. */
  answer: string;
}

interface InternshipDef {
  key: string;
  company: string;
  title: string;
  role: string;
  hours: number;
  summary: string;
  skills: string[];
  status?: SimulationStatus;
  tasks: TaskDef[];
}

const INTERNSHIPS: InternshipDef[] = [
  {
    key: 'swe',
    company: 'Indus Systems',
    title: 'Software Engineering Virtual Internship',
    role: 'Software Engineer',
    hours: 5,
    summary:
      'Join the payments team for a week in miniature. You will fix a real-looking bug, design a small API and review a teammate’s code, the three things a new engineer at Indus does in their first month.',
    skills: ['Java', 'REST APIs', 'Debugging', 'Code review', 'SQL'],
    tasks: [
      {
        title: 'Find and fix the refund bug',
        brief:
          'Customers are being refunded twice when the network drops mid-request. Read the handler in the starter repository, explain the cause in three or four sentences, and describe the fix you would make.',
        resources: [{ label: 'Starter repository (read-only)', url: `${RES}/indus/refund-service` }],
        answer:
          'The handler retries on timeout without an idempotency key, so a retry after a slow success refunds again. I would accept an idempotency key from the client, store it with the refund row under a unique index, and return the stored result on a repeat.',
      },
      {
        title: 'Design the refund status API',
        brief:
          'Support wants to look up any refund by order number. Propose the endpoint: path, request, response, error cases and the database query behind it.',
        answer:
          'GET /orders/{orderNo}/refunds returns a list with id, amount, status, createdAt. 404 when the order does not exist, 403 when the agent lacks support:read. Query: SELECT ... FROM refunds WHERE order_id = ? ORDER BY created_at DESC, with an index on order_id.',
      },
      {
        title: 'Review a teammate’s pull request',
        brief:
          'A colleague has opened a pull request adding refund notifications. Write the review you would leave: what is good, what must change before merge, and one question.',
        resources: [{ label: 'Pull request #418', url: `${RES}/indus/pr-418` }],
        answer:
          'Good: notification sending is behind an interface, easy to test. Must change: the email is sent inside the database transaction, so a rollback still notifies the customer; move it after commit. Question: should a failed notification retry, and who sees the failure?',
      },
    ],
  },
  {
    key: 'qa',
    company: 'Indus Systems',
    title: 'Quality Assurance Virtual Internship',
    role: 'QA Engineer',
    hours: 3,
    summary:
      'Test the checkout of a food-delivery app before it ships to two million users. Write the test cases, find the bugs we planted, and report them the way a QA engineer at Indus would.',
    skills: ['Test design', 'Bug reporting', 'Manual testing', 'Edge cases'],
    tasks: [
      {
        title: 'Write the test cases',
        brief:
          'List the ten test cases you would run on the checkout screen first, and say why those ten. Include at least two edge cases most people would miss.',
        answer:
          'Covered: empty cart, coupon on minimum order, coupon just below minimum, address outside delivery zone, payment timeout, double tap on Pay, price change between cart and checkout, COD limit, saved card expired, app backgrounded during payment.',
      },
      {
        title: 'Find the planted bugs',
        brief:
          'Use the test build linked below. Three bugs are planted. Report each one with steps to reproduce, expected and actual behaviour, and severity.',
        resources: [{ label: 'Test build', url: `${RES}/indus/checkout-test-build` }],
        answer:
          '1. Coupon applies twice when removed and re-added (high). 2. Delivery fee shows zero for addresses with a PIN starting 41 (medium). 3. Pay button stays enabled during processing, allowing a double charge (critical).',
      },
      {
        title: 'Recommend: ship or hold?',
        brief: 'Write a five-line note to the release manager: should this build ship on Friday, and what has to happen first?',
        answer:
          'Hold. The double-charge bug is customer-facing and costs money. Fix it and the coupon bug, re-run the payment cases, and ship Monday. The delivery-fee bug can follow in the next release with a monitoring alert.',
      },
    ],
  },
  {
    key: 'data',
    company: 'Northwind Analytics',
    title: 'Data Analytics Virtual Internship',
    role: 'Data Analyst',
    hours: 4,
    summary:
      'A retail client’s sales dropped 12% last quarter and nobody agrees why. Clean their data, find what actually happened, and present it to a client who has ten minutes.',
    skills: ['Excel', 'SQL', 'Data cleaning', 'Visualisation', 'Storytelling'],
    tasks: [
      {
        title: 'Clean the sales data',
        brief:
          'The sample file has duplicates, missing store codes and two date formats. Describe each problem you found, how many rows it affected, and how you fixed it.',
        resources: [{ label: 'Sample sales file (CSV)', url: `${RES}/northwind/sales-q3.csv` }],
        answer:
          'Removed 214 exact duplicates, mapped 37 missing store codes from the address column, converted 1,102 DD-MM dates to ISO. Flagged 9 rows with negative quantity as returns rather than deleting them.',
      },
      {
        title: 'Find what happened',
        brief: 'Using the clean data, find the main driver of the 12% drop. Show the numbers that prove it, not just the conclusion.',
        answer:
          'Nine of the twelve points come from four Pune stores that lost footfall after a competitor opened nearby in July; online sales actually grew 6%. Same-store sales outside Pune were flat.',
      },
      {
        title: 'The ten-minute presentation',
        brief: 'Write the three slides you would show the client: one chart each, a headline sentence each, and your recommendation.',
        answer:
          'Slide 1: the drop is local, not national (map). Slide 2: four stores explain 75% of it (bar chart). Slide 3: recommend a click-and-collect push in those four catchments, measured weekly.',
      },
    ],
  },
  {
    key: 'fintech',
    company: 'Harbour Fintech',
    title: 'Fintech Product Analyst Virtual Internship',
    role: 'Product Analyst',
    hours: 5,
    summary:
      'Harbour’s UPI autopay feature has a 40% drop-off at the mandate screen. Work out why, size the opportunity, and propose a fix the engineering team can build in one sprint.',
    skills: ['Product thinking', 'Funnel analysis', 'UPI', 'Writing specs', 'Prioritisation'],
    tasks: [
      {
        title: 'Read the funnel',
        brief: 'Study the funnel numbers provided. Where exactly do users drop, and what are your three best guesses for why?',
        resources: [{ label: 'Autopay funnel, last 30 days', url: `${RES}/harbour/autopay-funnel` }],
        answer:
          'Biggest drop is between "Review mandate" and "Approve in UPI app" (40%). Guesses: users fear an open-ended debit; the amount shown is the maximum, not the monthly charge; switching apps loses context.',
      },
      {
        title: 'Size the opportunity',
        brief: 'If you halved the drop-off, how many more active mandates and how much monthly revenue would that be? Show your working.',
        answer:
          '1.2 lakh users reach the screen monthly; halving a 40% drop adds about 24,000 mandates. At an average fee of ₹6, that is roughly ₹1.44 lakh more per month, before retention effects.',
      },
      {
        title: 'Write the one-sprint fix',
        brief: 'Write a one-page spec: the change, what success looks like, and what you are deliberately not doing.',
        answer:
          'Show the expected monthly amount in large type and the maximum in small, add "Cancel anytime from Harbour" with a link, and pre-fill the return deep link. Success: drop-off under 30% in two weeks. Not doing: redesigning the whole flow.',
      },
    ],
  },
  {
    key: 'cyber',
    company: 'Harbour Fintech',
    title: 'Cybersecurity Virtual Internship',
    role: 'Security Analyst',
    hours: 4,
    summary:
      'A customer reports a login from a city they have never visited. Investigate the logs, decide whether it was an attack, and write the incident report a bank regulator would accept.',
    skills: ['Log analysis', 'Incident response', 'Phishing', 'Risk assessment'],
    tasks: [
      {
        title: 'Investigate the logs',
        brief: 'Read the sign-in logs for the account. What happened, when, and from where? Quote the log lines that prove it.',
        resources: [{ label: 'Sign-in logs (sample)', url: `${RES}/harbour/signin-logs` }],
        answer:
          'Three failed attempts from a new device at 02:14, then a success at 02:16 after an OTP was entered, then a beneficiary added at 02:19. The OTP was requested by the customer’s own number, which points to OTP sharing via a phishing call.',
      },
      {
        title: 'Contain it',
        brief: 'List the actions you would take in the first hour, in order, and who must be told.',
        answer:
          'Freeze outgoing transfers, revoke the new device session, block the added beneficiary, call the customer on the registered number, raise a fraud case, and inform the fraud-ops lead and the nodal officer.',
      },
      {
        title: 'Write the incident report',
        brief: 'One page: summary, timeline, root cause, impact, and the two changes that would stop it happening again.',
        answer:
          'Root cause: social engineering, not a system breach. Impact: no money left the account. Changes: a cooling-off period before new beneficiaries can receive money, and an in-app warning when an OTP is requested during an active call.',
      },
    ],
  },
  {
    key: 'ev',
    company: 'Vertex Motors',
    title: 'EV Battery Engineering Virtual Internship',
    role: 'Graduate Engineer Trainee',
    hours: 6,
    summary:
      'Vertex’s electric scooter loses 18% range in Pune summers. Analyse the battery test data, find the cause, and propose a design change the plant can test next month.',
    skills: ['Battery systems', 'Thermal analysis', 'MATLAB', 'Root cause analysis', 'Technical writing'],
    tasks: [
      {
        title: 'Analyse the test data',
        brief: 'Plot cell temperature against range for the summer and winter test runs. What pattern do you see?',
        resources: [{ label: 'Battery test runs', url: `${RES}/vertex/battery-runs` }],
        answer:
          'Above 42°C cell temperature the BMS derates current by 30%, and summer runs spend 38% of the ride above that line. Winter runs never reach it. The range loss tracks time above 42°C almost exactly.',
      },
      {
        title: 'Find the root cause',
        brief: 'Use a 5-whys or fishbone analysis to get from "less range" to a cause the design team can act on.',
        answer:
          'Less range ← BMS derating ← cells over 42°C ← heat trapped under the floorboard ← no airflow path in the battery housing. The housing was sealed for water resistance with no thermal path.',
      },
      {
        title: 'Propose the change',
        brief: 'Propose one design change, the test that would prove it works, and its cost per vehicle.',
        answer:
          'Add an aluminium thermal pad between the cell pack and the housing floor, which acts as a heat spreader while staying sealed. Test: 30 summer rides, target under 10% range loss. Estimated cost ₹420 per vehicle.',
      },
      {
        title: 'Brief the plant',
        brief: 'Write the half-page note the plant manager reads before approving the trial.',
        answer:
          'Ask: approve a 20-scooter trial of the thermal pad. Why: summer range complaints are our top warranty issue. Risk: low; no change to the sealed design. Decision needed by the 15th to make the June test window.',
      },
    ],
  },
  {
    key: 'health',
    company: 'Solace Health',
    title: 'Healthcare Operations Virtual Internship',
    role: 'Operations Associate',
    hours: 3,
    summary:
      'Patients at Solace’s outpatient clinic wait an average of 70 minutes. Map the patient journey, find the bottleneck, and propose a change the front desk can try on Monday.',
    skills: ['Process mapping', 'Operations', 'Patient experience', 'Data analysis'],
    tasks: [
      {
        title: 'Map the journey',
        brief: 'Using the timestamps provided, map each step from arrival to leaving, and the average time at each.',
        resources: [{ label: 'One week of clinic timestamps', url: `${RES}/solace/clinic-week` }],
        answer:
          'Arrival → registration 14 min → vitals 9 min → wait for doctor 38 min → consultation 7 min → billing 6 min. The doctor wait is over half the visit.',
      },
      {
        title: 'Find the bottleneck',
        brief: 'Why is the wait for the doctor so long? Use the data, not a guess.',
        answer:
          'Appointments are all booked on the hour, so 60% of patients arrive in the first 15 minutes of each hour while doctors see patients evenly. The queue is created by the booking pattern, not by the doctors.',
      },
      {
        title: 'Monday’s change',
        brief: 'Propose one change the front desk can make on Monday, and how you will know by Friday whether it worked.',
        answer:
          'Book in 10-minute slots instead of on the hour and send the slot time by WhatsApp. Measure: average wait for the doctor each day; success is under 20 minutes by Friday.',
      },
    ],
  },
  {
    key: 'ux',
    company: 'Zenith Labs',
    title: 'Product Design Virtual Internship',
    role: 'Product Designer',
    hours: 4,
    summary:
      'Zenith’s learning app loses half its new users before their first lesson. Interview the data, redesign the first five minutes, and explain every decision to a sceptical product manager.',
    skills: ['UX research', 'Figma', 'Onboarding design', 'Prototyping', 'Design rationale'],
    tasks: [
      {
        title: 'Diagnose the onboarding',
        brief: 'Walk through the current onboarding screens. List every point where a new user has to think, and rank them by how likely they are to make someone quit.',
        resources: [{ label: 'Current onboarding screens', url: `${RES}/zenith/onboarding-screens` }],
        answer:
          'Six decisions before the first lesson: language, goal, level test, notification permission, account creation, plan choice. The 12-question level test is the worst; it feels like an exam before any reward.',
      },
      {
        title: 'Redesign the first five minutes',
        brief: 'Sketch or describe your new flow and share a link to your wireframes. Show what you removed as well as what you added.',
        answer:
          'New flow: pick a goal, then start a 2-minute lesson immediately, then create the account to save progress. The level test moves inside the first lesson. Wireframes: https://www.demo-resources.example/student/zenith-wireframes',
      },
      {
        title: 'Defend your design',
        brief: 'The product manager says "account first is how we get emails". Write your reply.',
        answer:
          'We only get emails from people who stay. Asking after the first lesson means fewer accounts that are worth more. Let us A/B test it for two weeks and compare day-7 retention, not sign-ups.',
      },
    ],
  },
  {
    key: 'draft',
    company: 'Indus Systems',
    title: 'Cloud and DevOps Virtual Internship',
    role: 'DevOps Engineer',
    hours: 4,
    status: SimulationStatus.DRAFT,
    summary:
      'Take a service from a laptop to production: containerise it, write the pipeline, and set up the alert that wakes someone at 3 a.m. only when it should.',
    skills: ['Docker', 'CI/CD', 'Linux', 'Monitoring'],
    tasks: [
      {
        title: 'Containerise the service',
        brief: 'Write the Dockerfile for the sample service and explain each line.',
        answer: '',
      },
      {
        title: 'Write the pipeline',
        brief: 'Describe the build, test and deploy stages you would set up, and what blocks a release.',
        answer: '',
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

/** A small fixed-seed generator, so certificate codes are the same every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The same shape and alphabet as `newCertificateCode` in simulations.service.ts. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nextRandom = rng(20261008);
function certificateCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += ALPHABET[Math.floor(nextRandom() * ALPHABET.length)];
  return code;
}

function daysFrom(days: number, hour = 11): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

type Stage = 'IN_PROGRESS' | 'SUBMITTED' | 'EXPLAIN_BOOKED' | 'COMPLETED' | 'NEEDS_WORK';

interface Plan {
  email: string;
  internship: string;
  stage: Stage;
  /** For IN_PROGRESS: how many tasks are answered. */
  answered?: number;
}

/** The named students, each in a state worth showing. */
const NAMED: Plan[] = [
  { email: 'karan.iyer5@pict.demo-college.example', internship: 'swe', stage: 'COMPLETED' },
  { email: 'karan.iyer5@pict.demo-college.example', internship: 'data', stage: 'IN_PROGRESS', answered: 1 },
  { email: 'atharva.wagh.21@pict.demo-college.example', internship: 'qa', stage: 'SUBMITTED' },
  { email: 'atharva.wagh.21@pict.demo-college.example', internship: 'fintech', stage: 'COMPLETED' },
  { email: 'sneha.patil2@pict.demo-college.example', internship: 'ux', stage: 'EXPLAIN_BOOKED' },
  { email: 'rahul.kulkarni9@pict.demo-college.example', internship: 'ev', stage: 'IN_PROGRESS', answered: 0 },
];

/** The mix for everyone else: mostly under way or finished, a few sent back. */
const MIX: Stage[] = [
  'COMPLETED',
  'IN_PROGRESS',
  'COMPLETED',
  'IN_PROGRESS',
  'SUBMITTED',
  'COMPLETED',
  'IN_PROGRESS',
  'NEEDS_WORK',
  'COMPLETED',
  'IN_PROGRESS',
  'EXPLAIN_BOOKED',
];
const PUBLISHED_KEYS = INTERNSHIPS.filter((i) => i.status !== SimulationStatus.DRAFT).map((i) => i.key);
const OTHERS = 22;

const EXPLAIN_NOTES: Record<'COMPLETED' | 'EXPLAIN_BOOKED' | 'NEEDS_WORK', string> = {
  COMPLETED:
    'Explained every decision clearly on the call and handled the follow-up question about edge cases well. Certificate issued.',
  EXPLAIN_BOOKED: 'Strong written work. Booked a 10-minute call to walk through the reasoning before we issue the certificate.',
  NEEDS_WORK: 'The second task describes the problem but not the fix. Add the concrete change you would make, then resubmit.',
};

export async function seedInternships() {
  const companies = await prisma.company.findMany({
    where: { name: { in: [...new Set(INTERNSHIPS.map((i) => i.company))] } },
    select: { id: true, name: true, members: { select: { userId: true }, orderBy: { createdAt: 'asc' }, take: 1 } },
  });
  const companyByName = new Map(companies.map((c) => [c.name, c]));

  // --- the internships ------------------------------------------------------
  const sims = new Map<string, { id: string; companyId: string; reviewerId: string | null; taskIds: string[]; def: InternshipDef }>();
  for (const def of INTERNSHIPS) {
    const company = companyByName.get(def.company);
    if (!company) {
      console.warn(`   skipped "${def.title}": no company called ${def.company}`);
      continue;
    }
    const sim = await prisma.simulation.create({
      data: {
        companyId: company.id,
        title: def.title,
        role: def.role,
        summary: def.summary,
        estimatedHours: def.hours,
        skills: def.skills,
        status: def.status ?? SimulationStatus.PUBLISHED,
        tasks: {
          create: def.tasks.map((t, i) => ({ order: i + 1, title: t.title, brief: t.brief, resources: t.resources ?? [] })),
        },
      },
      include: { tasks: { orderBy: { order: 'asc' }, select: { id: true } } },
    });
    sims.set(def.key, {
      id: sim.id,
      companyId: company.id,
      reviewerId: company.members[0]?.userId ?? null,
      taskIds: sim.tasks.map((t) => t.id),
      def,
    });
  }

  // --- who is doing them ----------------------------------------------------
  const named = new Set(NAMED.map((p) => p.email));
  const others = await prisma.candidate.findMany({
    where: {
      OR: [
        { user: { email: { endsWith: '@pict.demo-college.example' } } },
        { user: { email: { endsWith: '@vit.demo-college.example' } } },
      ],
      NOT: { user: { email: { in: [...named] } } },
    },
    select: { user: { select: { email: true } } },
    orderBy: { user: { email: 'asc' } },
  });
  // Every third student, so the spread crosses batches and both colleges.
  const picked = others.filter((_, i) => i % 3 === 0).slice(0, OTHERS);
  const plans: Plan[] = [
    ...NAMED,
    ...picked.map((c, i) => ({
      email: c.user.email,
      internship: PUBLISHED_KEYS[i % PUBLISHED_KEYS.length]!,
      stage: MIX[i % MIX.length]!,
      answered: 1 + (i % 2),
    })),
  ];

  const candidates = await prisma.candidate.findMany({
    where: { user: { email: { in: [...new Set(plans.map((p) => p.email))] } } },
    select: { id: true, user: { select: { email: true } } },
  });
  const candidateByEmail = new Map(candidates.map((c) => [c.user.email, c.id]));

  const counts: Record<Stage, number> = { IN_PROGRESS: 0, SUBMITTED: 0, EXPLAIN_BOOKED: 0, COMPLETED: 0, NEEDS_WORK: 0 };
  let n = 0;
  for (const plan of plans) {
    const sim = sims.get(plan.internship);
    const candidateId = candidateByEmail.get(plan.email);
    if (!sim || !candidateId) continue;
    n++;

    const allAnswered = plan.stage !== 'IN_PROGRESS';
    const answered = allAnswered ? sim.taskIds.length : Math.min(plan.answered ?? 0, sim.taskIds.length - 1);
    // Older work first: the further along, the longer ago it started.
    const startedDaysAgo = { COMPLETED: 24, EXPLAIN_BOOKED: 9, NEEDS_WORK: 12, SUBMITTED: 4, IN_PROGRESS: 2 }[plan.stage] + (n % 5);

    const data = {
      simulationId: sim.id,
      candidateId,
      status: EnrolmentStatus[plan.stage],
      createdAt: daysFrom(-startedDaysAgo, 10),
      reviewedById: plan.stage === 'IN_PROGRESS' || plan.stage === 'SUBMITTED' ? null : sim.reviewerId,
      explainAt:
        plan.stage === 'COMPLETED'
          ? daysFrom(-(startedDaysAgo - 8), 15)
          : plan.stage === 'EXPLAIN_BOOKED'
            ? daysFrom(2 + (n % 3), 16)
            : null,
      explainNote:
        plan.stage === 'COMPLETED' || plan.stage === 'EXPLAIN_BOOKED' || plan.stage === 'NEEDS_WORK'
          ? EXPLAIN_NOTES[plan.stage]
          : null,
      completedAt: plan.stage === 'COMPLETED' ? daysFrom(-(startedDaysAgo - 9), 17) : null,
      certificateCode: plan.stage === 'COMPLETED' ? certificateCode() : null,
    };

    await prisma.simulationEnrolment.create({
      data: {
        ...data,
        submissions: {
          create: sim.taskIds.slice(0, answered).map((taskId, i) => ({
            taskId,
            text: sim.def.tasks[i]!.answer,
            submittedAt: daysFrom(-(startedDaysAgo - 1 - i), 20),
          })),
        },
      },
    });
    counts[plan.stage]++;
  }

  // --- paid micro-internships -----------------------------------------------
  const micro = [
    {
      company: 'Northwind Analytics',
      title: 'Build a sales dashboard for a retail client',
      brief:
        'Turn three months of store sales into a one-page dashboard the client’s regional managers will open every Monday. Delivered as a shared workbook with a short note on how to read it.',
      hours: 20,
      stipend: 8000,
      skills: ['Excel', 'Power BI', 'Data cleaning'],
      slots: 2,
      deadline: daysFrom(14),
    },
    {
      company: 'Zenith Labs',
      title: 'Usability test our new lesson player',
      brief:
        'Run five short usability sessions with first-year students, then write up what confused them and what you would change. We pay for the sessions and the write-up.',
      hours: 12,
      stipend: 5000,
      skills: ['UX research', 'Interviewing', 'Writing'],
      slots: 3,
      deadline: daysFrom(10),
    },
    {
      company: 'Indus Systems',
      title: 'Write integration tests for the refunds service',
      brief:
        'Add integration tests for the refunds API covering retries, partial refunds and currency rounding. Delivered as a pull request with a short summary of what each test protects.',
      hours: 30,
      stipend: 12000,
      skills: ['Java', 'Testing', 'REST APIs'],
      slots: 1,
      deadline: daysFrom(21),
    },
  ];
  const pitches = [
    'I completed the Data Analytics virtual internship and enjoyed turning messy files into one clear chart. I can give this 10 hours a week.',
    'I run the design club at my college and have already done two small usability studies for our fest app.',
    'I finished the Software Engineering virtual internship on the same refunds service, so I know the codebase.',
  ];
  let microCount = 0;
  let microApps = 0;
  for (const [i, m] of micro.entries()) {
    const company = companyByName.get(m.company);
    if (!company) continue;
    const project = await prisma.microProject.create({
      data: {
        companyId: company.id,
        title: m.title,
        brief: m.brief,
        hours: m.hours,
        stipend: m.stipend,
        skills: m.skills,
        slots: m.slots,
        deadline: m.deadline,
        status: MicroProjectStatus.OPEN,
      },
    });
    microCount++;
    // Two applicants each from the students already doing internships;
    // Karan's application to the Indus project has been accepted.
    const applicants = [plans[(i * 5 + 6) % plans.length]!, plans[(i * 5 + 9) % plans.length]!];
    if (m.company === 'Indus Systems') applicants[0] = NAMED[0]!;
    for (const [j, a] of applicants.entries()) {
      const candidateId = candidateByEmail.get(a.email);
      if (!candidateId) continue;
      const exists = await prisma.microApplication.findUnique({
        where: { projectId_candidateId: { projectId: project.id, candidateId } },
      });
      if (exists) continue;
      await prisma.microApplication.create({
        data: {
          projectId: project.id,
          candidateId,
          pitch: pitches[i]!,
          status: m.company === 'Indus Systems' && j === 0 ? MicroApplicationStatus.SELECTED : MicroApplicationStatus.APPLIED,
        },
      });
      microApps++;
    }
  }

  return {
    internships: [...sims.values()].filter((s) => s.def.status !== SimulationStatus.DRAFT).length,
    drafts: [...sims.values()].filter((s) => s.def.status === SimulationStatus.DRAFT).length,
    enrolments: n,
    byStage: counts,
    microProjects: microCount,
    microApplications: microApps,
  };
}
