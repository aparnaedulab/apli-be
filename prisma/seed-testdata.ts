/**
 * Test fixtures for working on the job editor and the student's view of it.
 *
 * `seed.ts` builds a believable demo. This builds a deliberately awkward one:
 * every combination somebody needs to look at while changing eligibility, and
 * the cases a happy-path demo never produces - a role open to everybody, a
 * role narrowed to one batch, a role whose bar nobody clears, students whose
 * course is only on their batch, students their college has not verified.
 *
 * Safe to run repeatedly. Everything it makes is named, and it deletes its own
 * previous run before building again rather than piling up duplicates. It
 * touches nothing it did not create, so the existing demo data survives.
 *
 *   npm run db:seed:test
 */
import { ApplicationStatus, JobStatus, PostingStatus, ResumeSource, Role } from '@prisma/client';
import { loadProfile } from '../src/modules/candidates/candidate.service.js';
import { renderResume } from '../src/modules/candidates/resume.js';
import { saveTenantAsset } from '../src/modules/tenants/assets.js';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

/** The same one every seeded login uses, so there is only one to remember. */
const PASSWORD = process.env.DEMO_PASSWORD ?? 'CampusHire2026';

/** Everything this script creates carries this, so it can clean up after itself. */
const TAG = '[test]';

/** The company whose editor these roles are for. */
const COMPANY_EMAIL = process.env.DEMO_COMPANY ?? 'testcompany@company.in';

/** The one student filled in properly, and left free to apply to things. */
const SHOWCASE_EMAIL = 'test.vit-pune.00@demo-college.example';

const YEAR = new Date().getFullYear();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

// ---------------------------------------------------------------------------
// The catalogue operations keeps under Setup
// ---------------------------------------------------------------------------

const BRANCHES = [
  'Computer Science',
  'Information Technology',
  'Electronics and Telecommunication',
  'Mechanical Engineering',
  'Civil Engineering',
  'Data Science',
];

/** Which branches each course actually runs. */
const COURSES: Record<string, string[]> = {
  'B.Tech': [
    'Computer Science',
    'Information Technology',
    'Electronics and Telecommunication',
    'Mechanical Engineering',
    'Civil Engineering',
  ],
  'M.Tech': ['Computer Science', 'Electronics and Telecommunication'],
  MCA: ['Computer Science', 'Data Science'],
  'B.Sc': ['Computer Science', 'Data Science'],
};

async function seedCatalogue() {
  const branches = new Map<string, string>();
  for (const name of BRANCHES) {
    const b = await prisma.branch.upsert({ where: { name }, update: { isActive: true }, create: { name } });
    branches.set(name, b.id);
  }

  const courses = new Map<string, string>();
  for (const [name, runs] of Object.entries(COURSES)) {
    const c = await prisma.course.upsert({ where: { name }, update: { isActive: true }, create: { name } });
    courses.set(name, c.id);

    for (const branch of runs) {
      // A specialisation is a branch as offered by one course, so the pair is
      // what makes it unique.
      await prisma.specialisation.upsert({
        where: { name_courseId: { name: branch, courseId: c.id } },
        update: { isActive: true },
        create: { name: branch, courseId: c.id, branchId: branches.get(branch)! },
      });
    }
  }

  console.log(`  ${courses.size} courses, ${branches.size} branches, and the pairs between them`);
  return { courses, branches };
}

// ---------------------------------------------------------------------------
// Colleges, their batches, and students with something to filter on
// ---------------------------------------------------------------------------

const FIRST = ['Aditi', 'Rohan', 'Sneha', 'Arjun', 'Priya', 'Karan', 'Neha', 'Vikram', 'Isha', 'Omkar'];
const LAST = ['Rane', 'Kulkarni', 'Patil', 'Deshmukh', 'Joshi', 'Shinde', 'More', 'Gokhale'];

interface StudentSpec {
  cgpa: number;
  tenthPct: number;
  twelfthPct: number | null;
  diplomaPct?: number;
  pgCgpa?: number;
  backlogs: number;
  activeBacklogs: number;
  /** Set on the student, or left null so their batch has to answer for them. */
  ownCourse: boolean;
  frozen: boolean;
  lateral?: boolean;
}

/**
 * A spread wide enough that a criterion actually divides the batch.
 *
 * Every row here exists to be excluded by something: the 5.9 by any CGPA bar,
 * the live backlog by "no active backlogs", the lateral entrant by a 12th
 * standard bar they could never meet, the unverified one by the apply gate.
 */
const SPREAD: StudentSpec[] = [
  { cgpa: 9.2, tenthPct: 94, twelfthPct: 91, backlogs: 0, activeBacklogs: 0, ownCourse: true, frozen: true },
  { cgpa: 8.4, tenthPct: 88, twelfthPct: 82, backlogs: 0, activeBacklogs: 0, ownCourse: true, frozen: true },
  { cgpa: 8.0, tenthPct: 76, twelfthPct: 71, backlogs: 1, activeBacklogs: 0, ownCourse: false, frozen: true },
  { cgpa: 7.1, tenthPct: 69, twelfthPct: 64, backlogs: 2, activeBacklogs: 1, ownCourse: false, frozen: true },
  { cgpa: 6.4, tenthPct: 72, twelfthPct: null, diplomaPct: 78, backlogs: 0, activeBacklogs: 0, ownCourse: true, frozen: true, lateral: true },
  { cgpa: 5.9, tenthPct: 61, twelfthPct: 58, backlogs: 3, activeBacklogs: 2, ownCourse: false, frozen: true },
  // Their college has not verified them, so nothing is applyable however well
  // they match - the case that looks like a bug until you know the rule.
  { cgpa: 8.8, tenthPct: 90, twelfthPct: 86, backlogs: 0, activeBacklogs: 0, ownCourse: true, frozen: false },
];

interface BatchSpec {
  collegeCode: string;
  name: string;
  course: string;
  specialisation: string;
  graduationYear: number;
  /** MCA and M.Tech students carry a postgraduate score too. */
  postgraduate?: boolean;
}

const BATCHES: BatchSpec[] = [
  { collegeCode: 'VIT-PUNE', name: `${TAG} CSE ${YEAR}`, course: 'B.Tech', specialisation: 'Computer Science', graduationYear: YEAR },
  { collegeCode: 'VIT-PUNE', name: `${TAG} ENTC ${YEAR + 1}`, course: 'B.Tech', specialisation: 'Electronics and Telecommunication', graduationYear: YEAR + 1 },
  { collegeCode: 'VIT-PUNE', name: `${TAG} MCA ${YEAR}`, course: 'MCA', specialisation: 'Computer Science', graduationYear: YEAR, postgraduate: true },
  { collegeCode: 'CCOEW', name: `${TAG} IT ${YEAR + 1}`, course: 'B.Tech', specialisation: 'Information Technology', graduationYear: YEAR + 1 },
  { collegeCode: 'AISSMS', name: `${TAG} Mech ${YEAR}`, course: 'B.Tech', specialisation: 'Mechanical Engineering', graduationYear: YEAR },
];

async function seedBatches() {
  const made: { id: string; spec: BatchSpec; collegeId: string; tenantId: string }[] = [];

  for (const [n, spec] of BATCHES.entries()) {
    const college = await prisma.college.findFirst({ where: { code: spec.collegeCode } });
    if (!college) {
      console.log(`  ! no college ${spec.collegeCode}, skipping ${spec.name}`);
      continue;
    }

    const batch = await prisma.batch.create({
      data: {
        collegeId: college.id,
        tenantId: college.tenantId,
        name: spec.name,
        course: spec.course,
        specialisation: spec.specialisation,
        graduationYear: spec.graduationYear,
      },
    });

    for (const [i, s] of SPREAD.entries()) {
      const fullName = `${FIRST[(n * 3 + i) % FIRST.length]} ${LAST[(n + i) % LAST.length]}`;
      const user = await prisma.user.create({
        data: {
          email: `test.${spec.collegeCode.toLowerCase()}.${n}${i}@demo-college.example`,
          fullName,
          passwordHash: await hashPassword(PASSWORD),
          role: Role.CANDIDATE,
        },
      });

      const candidate = await prisma.candidate.create({
        data: {
          userId: user.id,
          collegeId: college.id,
          graduationYear: spec.graduationYear,
          // Left blank on purpose for some, so the batch is what answers for
          // them - which is how most real rosters arrive.
          course: s.ownCourse ? spec.course : null,
          specialisation: s.ownCourse ? spec.specialisation : null,
          cgpa: s.cgpa,
          tenthPct: s.tenthPct,
          twelfthPct: s.twelfthPct,
          diplomaPct: s.diplomaPct ?? null,
          pgCgpa: spec.postgraduate ? s.cgpa - 0.4 : null,
          backlogs: s.backlogs,
          activeBacklogs: s.activeBacklogs,
          gapYears: 0,
          isLateralEntry: Boolean(s.lateral),
        },
      });

      await prisma.batchMembership.create({
        data: {
          batchId: batch.id,
          candidateId: candidate.id,
          rollNo: `T${n}${String(i).padStart(2, '0')}`,
          isFrozen: s.frozen,
          verifiedAt: s.frozen ? new Date() : null,
        },
      });
    }

    made.push({ id: batch.id, spec, collegeId: college.id, tenantId: college.tenantId });
    console.log(`  ${spec.name} at ${spec.collegeCode} — ${SPREAD.length} students`);

    // The first student of the first batch is the one worth looking at.
    if (n === 0) {
      const first = await prisma.batchMembership.findFirstOrThrow({
        where: { batchId: batch.id },
        orderBy: { rollNo: 'asc' },
        select: { candidateId: true, candidate: { select: { user: { select: { email: true } } } } },
      });
      await fillOneProfile(first.candidateId, college.name);
      console.log(`      filled in: ${first.candidate.user.email}`);
    }
  }

  return made;
}

/**
 * One student filled in properly, so there is something to look at.
 *
 * The spread above is built to be excluded by things, which makes every
 * profile in it thin on purpose. This one is the opposite: the whole of the
 * student side - the readiness ring, the completion checklist, the passport,
 * what a recruiter reads - only shows its shape against a profile somebody
 * has actually finished, and "15% complete, no skills, no projects" is not
 * that. The first student of the first batch gets the full treatment.
 */
async function fillOneProfile(candidateId: string, college: string) {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      phone: '9820011223',
      gender: 'Female',
      dateOfBirth: new Date('2004-03-14'),
      headline: 'Final-year CSE student — backend, databases, and a lot of Python',
      about:
        'I like the unglamorous half of building things: the schema, the queries that have to stay fast once the table is big, and the logging you are grateful for at two in the morning. Most of what I know I learnt by keeping something small running for other people.',
      resumeUrl: 'https://drive.google.com/demo-aditi-rane-resume',
    },
  });

  const skills = ['Python', 'JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'Git', 'SQL'];
  for (const name of skills) {
    const skill = await prisma.skill.upsert({ where: { name }, update: {}, create: { name } });
    await prisma.candidateSkill.upsert({
      where: { candidateId_skillId: { candidateId, skillId: skill.id } },
      update: {},
      create: { candidateId, skillId: skill.id },
    });
  }

  await prisma.education.createMany({
    data: [
      {
        candidateId,
        degree: 'B.Tech',
        institution: college,
        startYear: YEAR - 4,
        endYear: YEAR,
        cgpa: 9.2,
      },
      {
        candidateId,
        degree: 'HSC (Class 12)',
        institution: 'Demo Junior College, Pune',
        board: 'Maharashtra State Board',
        startYear: YEAR - 6,
        endYear: YEAR - 4,
        percentage: 91,
      },
      {
        candidateId,
        degree: 'SSC (Class 10)',
        institution: 'Demo English School, Pune',
        board: 'Maharashtra State Board',
        startYear: YEAR - 8,
        endYear: YEAR - 6,
        percentage: 94,
      },
    ],
  });

  await prisma.experience.createMany({
    data: [
      {
        candidateId,
        title: 'Backend intern',
        organisation: 'Demo Tech Systems',
        location: 'Pune',
        startDate: new Date(`${YEAR - 1}-05-15`),
        endDate: new Date(`${YEAR - 1}-07-31`),
        isCurrent: false,
        description:
          'Two months on the billing service. Wrote the reconciliation job that had been a spreadsheet, and cut a nightly report from eleven minutes to under one by fixing the indexes it was missing.',
      },
      {
        candidateId,
        title: 'Teaching assistant, Data Structures',
        organisation: college,
        location: 'Pune',
        startDate: new Date(`${YEAR - 1}-08-01`),
        isCurrent: true,
        description: 'Two lab sessions a week for the second year, and the marking that comes with them.',
      },
    ],
  });

  /* Several links each, which is the point of a project having a list. */
  await prisma.project.create({
    data: {
      candidateId,
      title: 'Campus bus tracker',
      description:
        'Live positions for the college shuttle, so nobody stands at the gate guessing. Around 400 students use it on a weekday.',
      links: [
        { url: 'https://github.com/example/campus-bus-tracker', label: 'Repository' },
        { url: 'https://example.com/bus-tracker', label: 'Live demo' },
        { url: 'https://example.com/bus-tracker-writeup', label: 'How it works' },
      ],
      startDate: new Date(`${YEAR - 2}-01-10`),
      endDate: new Date(`${YEAR - 1}-04-20`),
    },
  });

  await prisma.project.create({
    data: {
      candidateId,
      title: 'Timetable conflict checker',
      description:
        'Reads the department timetable and finds the clashes before the term starts - two classes in one hall, or a lecturer in two places at once.',
      links: [
        { url: 'https://github.com/example/timetable-checker', label: 'Repository' },
        { url: 'https://example.com/timetable-demo', label: 'Try it' },
      ],
      startDate: new Date(`${YEAR - 1}-09-01`),
    },
  });

  await prisma.project.create({
    data: {
      candidateId,
      title: 'Query plan visualiser',
      description: 'A small tool that draws what PostgreSQL says it is about to do. Built while learning to read EXPLAIN.',
      links: [{ url: 'https://github.com/example/query-plan-visualiser', label: 'Repository' }],
      startDate: new Date(`${YEAR}-01-05`),
    },
  });

  /*
   * Two resumes, so the apply step has a choice to offer.
   *
   * Built through the real renderer rather than faked rows: a picker whose
   * preview cannot be opened proves nothing about the picker.
   */
  const loaded = await loadProfile(candidateId);
  for (const [name, layout] of [
    ['For backend roles', 'classic'],
    ['For analytics roles', 'sidebar'],
  ] as const) {
    const url = await saveTenantAsset('resume', await renderResume(loaded, { layout }));
    await prisma.resume.create({
      data: { candidateId, name, url, source: ResumeSource.BUILT, build: { layout } },
    });
    // The first one built is the one they are using.
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { resumeUrl: url, resumeBuild: { layout } },
    });
  }
}

/**
 * Every batch needs a drive to be reachable through: a student sees a role
 * only through an accepted posting into a drive their batch is in.
 */
async function seedDrives(batches: Awaited<ReturnType<typeof seedBatches>>) {
  const drives: { id: string; collegeId: string; name: string }[] = [];

  for (const collegeId of new Set(batches.map((b) => b.collegeId))) {
    const mine = batches.filter((b) => b.collegeId === collegeId);
    const college = await prisma.college.findUniqueOrThrow({ where: { id: collegeId } });
    const name = `${TAG} ${YEAR} Placements`;

    const drive = await prisma.placement.create({
      data: {
        collegeId,
        name,
        year: YEAR,
        isOpen: true,
        oneOfferRule: true,
        batches: { connect: mine.map((b) => ({ id: b.id })) },
      },
    });

    drives.push({ id: drive.id, collegeId, name: `${college.name} — ${name}` });
    console.log(`  ${college.code}: ${name} with ${mine.length} batch(es)`);
  }

  // The existing demo drives too, so a role can be sent somewhere that
  // already has students in it.
  const existing = await prisma.placement.findMany({
    where: { isOpen: true, name: { not: { startsWith: TAG } }, batches: { some: {} } },
    select: { id: true, name: true, collegeId: true, college: { select: { name: true } } },
  });
  for (const d of existing) {
    drives.push({ id: d.id, collegeId: d.collegeId, name: `${d.college.name} — ${d.name}` });
  }

  return drives;
}

// ---------------------------------------------------------------------------
// The roles themselves
// ---------------------------------------------------------------------------

interface RoundSpec {
  name: string;
  type: string;
  isOnline: boolean;
  durationMin?: number;
  shortlistCount?: number;
  isElimination?: boolean;
  venue?: string;
  addressLine?: string;
  pincode?: string;
  mapsLink?: string;
  meetingLink?: string;
  description?: string;
  dayOffset?: number;
}

interface JobSpec {
  title: string;
  why: string;
  status: JobStatus;
  jobType?: string;
  description: string;
  openings?: number;
  ctcMin?: number;
  ctcMax?: number;
  stipendPerMonth?: number;
  openToAll?: boolean;
  minCgpa?: number;
  minTenthPct?: number;
  minTwelfthPct?: number;
  minDiplomaPct?: number;
  minPgCgpa?: number;
  maxBacklogs?: number;
  maxActiveBacklogs?: number;
  allowsLateralEntry?: boolean;
  courses?: string[];
  specialisations?: string[];
  gradYears?: number[];
  /**
   * What the role asks for, which is what the match score is mostly made of.
   * `required` is the subset it will not bend on.
   */
  skills?: string[];
  required?: string[];
  /**
   * How long ago it went out. Staggered across the set so "posted in the
   * last 24 hours" is a filter with something on either side of it.
   */
  postedDaysAgo?: number;
  /** Days until applications close. Thirty unless a case needs otherwise. */
  closesInDays?: number;
  location?: string;
  workMode?: string;
  /** Monthly, for a role quoted that way rather than as a yearly figure. */
  payPeriod?: 'YEARLY' | 'MONTHLY';
  internshipMonths?: number;
  /** Conditions a student must accept before applying counts. */
  terms?: string[];
  /** A test taken before applying, and whether it gates the application. */
  test?: { name: string; url: string; required: boolean; instructions?: string };
  /** Which drives to post into: 'all', or a college code to match. */
  postTo: 'all' | string[];
  /** Narrow the posting to batches whose name contains this. */
  onlyBatches?: string;
  rounds: RoundSpec[];
}

const ONLINE_ROUND: RoundSpec = {
  name: 'Online test',
  type: 'APTITUDE_TEST',
  isOnline: true,
  durationMin: 60,
  shortlistCount: 40,
  meetingLink: 'https://meet.google.com/demo-test-link',
  description: '60 multiple-choice questions — aptitude, then core subject. No negative marking.',
  dayOffset: 14,
};

const ONSITE_ROUND: RoundSpec = {
  name: 'Technical interview',
  type: 'LIVE_INTERVIEW',
  isOnline: false,
  durationMin: 45,
  shortlistCount: 12,
  venue: 'Seminar hall 2',
  addressLine: 'Level 4, Demo Tech Park, Baner Road, Pune',
  pincode: '411045',
  mapsLink: 'https://maps.app.goo.gl/demoPuneOffice',
  description: 'Two interviewers, one whiteboard problem and a walk through your projects.',
  dayOffset: 21,
};

const HR_ROUND: RoundSpec = {
  name: 'HR round',
  type: 'HR_INTERVIEW',
  isOnline: true,
  durationMin: 30,
  isElimination: false,
  meetingLink: 'https://meet.google.com/demo-hr-link',
  description: 'Role, location, joining date and anything you want to ask us.',
  dayOffset: 24,
};

const JOBS: JobSpec[] = [
  {
    title: `${TAG} Graduate Trainee — everyone can see this`,
    postedDaysAgo: 0,
    why: 'openToAll, no course/branch/year filter, sent to every open drive.',
    status: JobStatus.PUBLISHED,
    description:
      'A one-year rotation across engineering, support and delivery. Open to every student in every drive we are in — there is no marks bar of any kind.',
    openings: 25,
    ctcMin: 450000,
    ctcMax: 600000,
    openToAll: true,
    // Deliberately none, so the "asks for nothing in particular" case is on
    // the screen too.
    postTo: 'all',
    rounds: [ONLINE_ROUND, { ...HR_ROUND, isElimination: true }],
  },
  {
    title: `${TAG} Software Engineer — B.Tech CSE & IT, 8.0 CGPA`,
    postedDaysAgo: 2,
    why: 'Course + branch + year + three marks bars at once.',
    status: JobStatus.PUBLISHED,
    description:
      'Backend and platform work on our billing product. Criteria are strict on purpose so the shortlist stays readable.',
    openings: 6,
    ctcMin: 1200000,
    ctcMax: 1800000,
    minCgpa: 8.0,
    minTenthPct: 75,
    minTwelfthPct: 70,
    minDiplomaPct: 70,
    maxActiveBacklogs: 0,
    courses: ['B.Tech'],
    specialisations: ['Computer Science', 'Information Technology'],
    gradYears: [YEAR],
    skills: ['Python', 'PostgreSQL', 'Docker', 'Kubernetes'],
    required: ['Python', 'PostgreSQL'],
    postTo: 'all',
    rounds: [ONLINE_ROUND, ONSITE_ROUND, HR_ROUND],
  },
  {
    title: `${TAG} Data Analyst Intern — MCA only`,
    postedDaysAgo: 5,
    why: 'An internship: stipend rather than CTC, and one course only.',
    status: JobStatus.PUBLISHED,
    jobType: 'INTERNSHIP',
    description:
      'Six months on the analytics team, working with the people who own the numbers. Converts to a full-time offer for the right person.',
    openings: 4,
    stipendPerMonth: 35000,
    maxBacklogs: 0,
    courses: ['MCA'],
    gradYears: [YEAR],
    skills: ['SQL', 'Python', 'Machine Learning'],
    required: ['SQL'],
    postTo: ['VIT-PUNE'],
    rounds: [ONLINE_ROUND, { ...HR_ROUND, name: 'Conversation with the team', isElimination: true }],
  },
  {
    title: `${TAG} Core Engineer — one batch only`,
    postedDaysAgo: 12,
    why: 'Posted into a drive but narrowed to a single batch inside it.',
    status: JobStatus.PUBLISHED,
    description:
      'Embedded firmware for our metering hardware. Aimed at one batch, so the drive is right but most of it will not see this.',
    openings: 3,
    ctcMin: 700000,
    ctcMax: 900000,
    specialisations: ['Electronics and Telecommunication'],
    gradYears: [YEAR + 1],
    skills: ['C++', 'Embedded C'],
    postTo: ['VIT-PUNE'],
    onlyBatches: 'ENTC',
    rounds: [ONSITE_ROUND],
  },
  {
    title: `${TAG} Lateral entrants welcome — diploma route`,
    postedDaysAgo: 25,
    why: 'A diploma bar beside the 12th one, so lateral entrants are not cut.',
    status: JobStatus.PUBLISHED,
    description:
      'Same work, either route in. States a diploma percentage beside the 12th standard one, which is what stops a lateral entrant being excluded by a bar they could never meet.',
    openings: 8,
    ctcMin: 550000,
    ctcMax: 750000,
    minCgpa: 6.0,
    minTwelfthPct: 60,
    minDiplomaPct: 60,
    allowsLateralEntry: true,
    courses: ['B.Tech'],
    skills: ['JavaScript', 'React', 'Git'],
    required: ['JavaScript'],
    postTo: 'all',
    rounds: [ONLINE_ROUND, ONSITE_ROUND],
  },
  {
    title: `${TAG} Research Fellow — nobody clears this`,
    postedDaysAgo: 45,
    why: 'A bar no student meets, for the "Nobody can see this" warning.',
    status: JobStatus.PUBLISHED,
    description:
      'Deliberately impossible criteria. Use this one to check that the reach bar says so loudly rather than letting a recruiter publish into silence.',
    openings: 1,
    ctcMin: 2400000,
    minCgpa: 9.9,
    minPgCgpa: 9.8,
    maxBacklogs: 0,
    postTo: 'all',
    rounds: [ONSITE_ROUND],
  },
  /* --- the cases the first seven do not reach ----------------------------- */
  {
    title: `${TAG} Platform Engineer — a perfect match`,
    why: 'Every skill the filled-in student has. The top of "Worth a look".',
    status: JobStatus.PUBLISHED,
    postedDaysAgo: 1,
    description:
      'Runs the services everything else sits on. Asks for exactly what a backend-leaning final year tends to have, so this is the one the suggestions should put first.',
    openings: 4,
    ctcMin: 1400000,
    ctcMax: 2000000,
    skills: ['Python', 'PostgreSQL', 'Docker', 'Git', 'SQL'],
    required: ['Python', 'PostgreSQL'],
    courses: ['B.Tech'],
    postTo: 'all',
    rounds: [ONLINE_ROUND, ONSITE_ROUND, HR_ROUND],
  },
  {
    title: `${TAG} Support Engineer — closes tomorrow`,
    why: 'A deadline inside a day, for the red date and "closing this week".',
    status: JobStatus.PUBLISHED,
    postedDaysAgo: 20,
    closesInDays: 1,
    description:
      'First line for our enterprise customers. Applications close tomorrow, so this is the one that should be shouting on the card.',
    openings: 10,
    ctcMin: 500000,
    ctcMax: 650000,
    skills: ['SQL', 'Git'],
    postTo: 'all',
    rounds: [{ ...HR_ROUND, isElimination: true }],
  },
  {
    title: `${TAG} Summer Intern — paid monthly, in Bengaluru`,
    why: 'Monthly pay, a second city for the location filter, and a stipend.',
    status: JobStatus.PUBLISHED,
    jobType: 'INTERNSHIP',
    postedDaysAgo: 4,
    location: 'Bengaluru',
    workMode: 'HYBRID',
    payPeriod: 'MONTHLY',
    internshipMonths: 6,
    description:
      'Six months with the platform team in Bengaluru, three days a week in the office. Converts for the right person.',
    openings: 6,
    stipendPerMonth: 45000,
    skills: ['Python', 'Git'],
    postTo: 'all',
    rounds: [ONLINE_ROUND, { ...HR_ROUND, isElimination: true }],
  },
  {
    title: `${TAG} Field Engineer — conditions to accept`,
    why: 'Terms a student must agree to, so the apply step has a gate on it.',
    status: JobStatus.PUBLISHED,
    postedDaysAgo: 8,
    location: 'Bengaluru',
    workMode: 'ONSITE',
    description:
      'Installs and services our metering hardware on customer sites. The conditions are real ones, and they are on the application rather than sprung in the last round.',
    openings: 12,
    ctcMin: 600000,
    ctcMax: 800000,
    terms: [
      'You would be posted anywhere in Karnataka or Maharashtra for the first two years.',
      'A two-year service agreement, with three months of notice after that.',
      'Travel up to fifteen days a month, paid separately.',
    ],
    skills: ['Embedded C'],
    postTo: 'all',
    rounds: [ONSITE_ROUND, HR_ROUND],
  },
  {
    title: `${TAG} Quant Analyst — test before applying`,
    why: 'A required screening test, so applying asks for what it gave them.',
    status: JobStatus.PUBLISHED,
    postedDaysAgo: 6,
    description:
      'Pricing and risk models. There is a timed test first, and the application asks for the reference it gives you at the end.',
    openings: 2,
    ctcMin: 2200000,
    ctcMax: 3000000,
    minCgpa: 8.5,
    skills: ['Python', 'SQL', 'Machine Learning'],
    required: ['Python'],
    test: {
      name: 'Quantitative aptitude test',
      url: 'https://example.com/demo-quant-test',
      required: true,
      instructions:
        '90 minutes, one attempt. Copy the submission ID from the last screen - the application will ask for it.',
    },
    postTo: 'all',
    rounds: [ONSITE_ROUND, HR_ROUND],
  },
  {
    title: `${TAG} Design Intern — asks for nothing you have`,
    why: 'Skills nobody in the seed holds, for the bottom of the ordering.',
    status: JobStatus.PUBLISHED,
    jobType: 'INTERNSHIP',
    postedDaysAgo: 15,
    payPeriod: 'MONTHLY',
    internshipMonths: 3,
    description:
      'Three months with the design team. Listed so there is something a technical student matches badly, which is what the ordering is for.',
    openings: 2,
    stipendPerMonth: 25000,
    skills: ['Figma', 'User Research'],
    required: ['Figma'],
    postTo: 'all',
    rounds: [{ ...HR_ROUND, isElimination: true }],
  },
  {
    title: `${TAG} Closed already — deadline gone`,
    why: 'A deadline in the past: it should not reach a student at all.',
    status: JobStatus.PUBLISHED,
    postedDaysAgo: 60,
    closesInDays: -2,
    description: 'Applications closed two days ago. Nobody should see this under Jobs.',
    openings: 1,
    ctcMin: 900000,
    postTo: 'all',
    rounds: [HR_ROUND],
  },
  {
    title: `${TAG} Half-finished draft`,
    why: 'A draft with gaps, for the wizard rail and the publish checklist.',
    status: JobStatus.DRAFT,
    description: 'Started and not finished — no pay, no rounds, nowhere to send it.',
    postTo: [],
    rounds: [],
  },
];

async function seedJobs(drives: { id: string; collegeId: string; name: string }[]) {
  const owner = await prisma.user.findUnique({ where: { email: COMPANY_EMAIL } });
  if (!owner) throw new Error(`No user ${COMPANY_EMAIL} — set DEMO_COMPANY to one that exists.`);

  const member = await prisma.companyMember.findUnique({ where: { userId: owner.id } });
  if (!member) throw new Error(`${COMPANY_EMAIL} is not a member of any company.`);

  const company = await prisma.company.findUniqueOrThrow({ where: { id: member.companyId } });
  console.log(`  roles go to ${company.name} (${company.status})`);

  const colleges = await prisma.college.findMany({ select: { id: true, code: true } });
  const codeOf = new Map(colleges.map((c) => [c.id, c.code]));

  for (const spec of JOBS) {
    const job = await prisma.job.create({
      data: {
        companyId: company.id,
        createdById: owner.id,
        title: spec.title,
        description: spec.description,
        jobType: spec.jobType ?? 'FULL_TIME',
        workMode: spec.workMode ?? 'ONSITE',
        location: spec.location ?? 'Pune',
        payPeriod: spec.payPeriod ?? 'YEARLY',
        ...(spec.internshipMonths ? { internshipMonths: spec.internshipMonths } : {}),
        ...(spec.test
          ? {
              screeningTestName: spec.test.name,
              screeningTestUrl: spec.test.url,
              screeningTestRequired: spec.test.required,
              screeningTestInstructions: spec.test.instructions ?? null,
              screeningTestDeadline: inDays(10),
            }
          : {}),
        terms: { create: (spec.terms ?? []).map((text, i) => ({ order: i + 1, text })) },
        openings: spec.openings ?? null,
        ctcMin: spec.ctcMin ?? null,
        ctcMax: spec.ctcMax ?? null,
        stipendPerMonth: spec.stipendPerMonth ?? null,
        deadline: inDays(spec.closesInDays ?? 30),
        status: spec.status,
        publishedAt:
          spec.status === JobStatus.PUBLISHED ? inDays(-(spec.postedDaysAgo ?? 0)) : null,
        openToAll: spec.openToAll ?? false,
        minCgpa: spec.minCgpa ?? null,
        minTenthPct: spec.minTenthPct ?? null,
        minTwelfthPct: spec.minTwelfthPct ?? null,
        minDiplomaPct: spec.minDiplomaPct ?? null,
        minPgCgpa: spec.minPgCgpa ?? null,
        maxBacklogs: spec.maxBacklogs ?? null,
        maxActiveBacklogs: spec.maxActiveBacklogs ?? null,
        allowsLateralEntry: spec.allowsLateralEntry ?? true,
        courses: { create: (spec.courses ?? []).map((course) => ({ course })) },
        specialisations: {
          create: (spec.specialisations ?? []).map((specialisation) => ({ specialisation })),
        },
        gradYears: { create: (spec.gradYears ?? []).map((year) => ({ year })) },
        skills: {
          create: await Promise.all(
            (spec.skills ?? []).map(async (name) => ({
              skillId: (await prisma.skill.upsert({ where: { name }, update: {}, create: { name } })).id,
              isRequired: (spec.required ?? []).includes(name),
            })),
          ),
        },
        rounds: {
          create: spec.rounds.map((r, i) => ({
            order: i + 1,
            name: r.name,
            type: r.type,
            isElimination: r.isElimination ?? true,
            isOnline: r.isOnline,
            durationMin: r.durationMin ?? null,
            shortlistCount: r.shortlistCount ?? null,
            venue: r.venue ?? null,
            addressLine: r.addressLine ?? null,
            pincode: r.pincode ?? null,
            mapsLink: r.mapsLink ?? null,
            meetingLink: r.meetingLink ?? null,
            description: r.description ?? null,
            scheduledAt: r.dayOffset ? inDays(r.dayOffset) : null,
          })),
        },
      },
    });

    const targets =
      spec.postTo === 'all'
        ? drives
        : drives.filter((d) => spec.postTo.includes(codeOf.get(d.collegeId) ?? ''));

    for (const drive of targets) {
      const posting = await prisma.jobPosting.create({
        data: {
          jobId: job.id,
          placementId: drive.id,
          // Accepted, because a pending posting reaches nobody and the point
          // of these is to be looked at from the student's side too.
          status: PostingStatus.ACCEPTED,
          decidedAt: new Date(),
        },
      });

      if (spec.onlyBatches) {
        const batches = await prisma.batch.findMany({
          where: { placements: { some: { id: drive.id } }, name: { contains: spec.onlyBatches } },
          select: { id: true },
        });
        for (const b of batches) {
          await prisma.jobPostingBatch.create({ data: { postingId: posting.id, batchId: b.id } });
        }
      }
    }

    console.log(`  ${spec.title}`);
    console.log(`      ${spec.why}`);
    console.log(`      ${targets.length} drive(s), ${spec.rounds.length} round(s)`);
  }
}

// ---------------------------------------------------------------------------

/**
 * A crowd on each role, so the applicant counts are not all zero.
 *
 * The one student whose profile is filled in is left out on purpose: they are
 * who the student side gets demonstrated with, and a demonstration where
 * every role already says "Applied" has no apply button left to press.
 */
async function seedApplications(showcaseEmail: string) {
  const jobs = await prisma.job.findMany({
    where: { title: { startsWith: TAG }, status: JobStatus.PUBLISHED },
    include: { postings: true },
    orderBy: { title: 'asc' },
  });

  const students = await prisma.batchMembership.findMany({
    where: {
      batch: { name: { startsWith: TAG } },
      isFrozen: true,
      candidate: { user: { email: { not: showcaseEmail } } },
    },
    select: { candidateId: true },
  });

  let made = 0;
  for (const [i, job] of jobs.entries()) {
    const posting = job.postings[0];
    if (!posting) continue;

    // A different crowd per role, so the number on the card means something.
    for (const st of students.slice(0, (i * 5) % 17)) {
      try {
        await prisma.application.create({
          data: {
            candidateId: st.candidateId,
            jobId: job.id,
            placementId: posting.placementId,
            status: ApplicationStatus.APPLIED,
          },
        });
        made++;
      } catch {
        // Already applied, or not in that drive. Neither is worth stopping for.
      }
    }
  }

  console.log(`  ${made} applications across ${jobs.length} roles`);
  console.log(`  none from ${showcaseEmail}, so there is still something to apply to`);
}

/** Removes the previous run, and only the previous run. */
async function clean() {
  const jobs = await prisma.job.deleteMany({ where: { title: { startsWith: TAG } } });
  const drives = await prisma.placement.deleteMany({ where: { name: { startsWith: TAG } } });

  const batches = await prisma.batch.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true, memberships: { select: { candidate: { select: { userId: true } } } } },
  });
  const userIds = batches.flatMap((b) => b.memberships.map((m) => m.candidate.userId));

  await prisma.batch.deleteMany({ where: { id: { in: batches.map((b) => b.id) } } });
  // Candidate and membership go with the user by cascade.
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(
    `  removed ${jobs.count} role(s), ${drives.count} drive(s), ${batches.length} batch(es), ${userIds.length} student(s)`,
  );
}

async function main() {
  console.log('\nCleaning up the last run');
  await clean();

  console.log('\nSetup — courses and branches');
  await seedCatalogue();

  console.log('\nBatches and students');
  const batches = await seedBatches();

  console.log('\nDrives');
  const drives = await seedDrives(batches);

  console.log('\nRoles');
  await seedJobs(drives);

  console.log('\nApplications');
  await seedApplications(SHOWCASE_EMAIL);

  console.log(`\nDone. Every student signs in with the seeded password.`);
  console.log(`Roles are on ${COMPANY_EMAIL}; everything made here is tagged "${TAG}".\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
