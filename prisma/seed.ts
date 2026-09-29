/**
 * Builds a complete, demonstrable world in one command.
 *
 *   npm run db:seed
 *
 * Everything the platform does is represented: two institutions (one live, one
 * still being onboarded), two onboarded colleges, three companies,
 * students at every stage of verification, drives, published roles, an
 * approval queue with something still waiting, and applications spread across
 * the pipeline including one student who accepted an offer and had their other
 * applications closed automatically.
 *
 * Safe to re-run: it clears the tables it owns first.
 */
import 'dotenv/config';
import {
  ApplicationStatus as S,
  CompanySize,
  CompanyStatus,
  JobStatus,
  PlacementType,
  Prisma,
  PostingStatus,
  Role,
  RoundOutcome,
  RoleScope,
  RefKind,
  RecordSource,
} from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { SYSTEM_ROLES } from '../src/modules/roles/permissions.js';
import { CORE_KEYS } from '../src/modules/tenants/catalogue.js';
import { seedAptitude } from '../src/scripts/seedAptitude.js';
import { setCollegePrograms } from '../src/modules/mapping/mapping.service.js';
import { seedDepth } from './seed-depth.js';

const PASSWORD = 'CampusHire2026';

const SKILLS = [
  'Python', 'JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL',
  'Docker', 'AWS', 'Machine Learning', 'SQL', 'Java', 'Git',
];

const FIRST = ['Aditi', 'Rohan', 'Sneha', 'Arjun', 'Priya', 'Karan', 'Neha', 'Vikram',
  'Ananya', 'Rahul', 'Divya', 'Siddharth', 'Meera', 'Aryan', 'Isha', 'Nikhil'];
const LAST = ['Rane', 'Kulkarni', 'Patil', 'Desai', 'Sharma', 'Iyer', 'Nair', 'Joshi'];

const pick = <T>(xs: readonly T[], i: number): T => xs[i % xs.length]!;
const rand = (min: number, max: number) => Math.round((min + Math.random() * (max - min)) * 100) / 100;

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

async function clear() {
  // Order does not matter with cascades, but being explicit documents what
  // this script owns.
  const tables = await prisma.$queryRaw<{ TABLE_NAME: string }[]>`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME NOT LIKE '_prisma%'
      AND TABLE_NAME <> 'user_sessions'
  `;

  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const { TABLE_NAME } of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}

/* -------------------------------------------------------------------------- */
/* The course catalogue, and which college runs what                           */
/* -------------------------------------------------------------------------- */

/**
 * Courses, branches, and the two Map data layers above them.
 *
 * None of this was seeded before, which left a freshly seeded demo with an
 * empty Course dropdown on every screen that has one - a student's profile, a
 * batch, a role's criteria - while the batches themselves carried course names
 * as plain text. Eligibility still worked, because it compares those names,
 * but nobody could pick one.
 *
 * Three layers, narrowing:
 *
 *   Course / Specialisation   what the platform knows about at all
 *   TenantProgram             what SPPU offers across its colleges
 *   CollegeProgram            what PICT and VIT actually run
 *
 * A student picks from the last one. The catalogue is deliberately wider than
 * either - that is the point of having three - so that narrowing is visibly
 * doing something rather than being three copies of one list.
 */
async function seedPrograms() {
  console.log('Courses, branches and Map data…');

  /* The branch names first: a branch is a subject, shared across the courses
     that teach it, so "Computer Science" is one row whether it is taught as a
     B.Tech or an M.Tech. */
  const BRANCHES = [
    'Computer Science',
    'Information Technology',
    'Electronics and Telecommunication',
    'Electrical',
    'Mechanical Engineering',
    'Civil',
    'Data Science',
    'Artificial Intelligence and Machine Learning',
    'Finance',
    'Marketing',
  ];

  const branchId = new Map<string, string>();
  for (const name of BRANCHES) {
    const b = await prisma.branch.create({ data: { name } });
    branchId.set(name, b.id);
  }

  /** Every course the platform knows, and the branches each is taught in. */
  const COURSES: Record<string, string[]> = {
    'B.Tech': [
      'Computer Science',
      'Information Technology',
      'Electronics and Telecommunication',
      'Electrical',
      'Mechanical Engineering',
      'Civil',
      'Artificial Intelligence and Machine Learning',
    ],
    'B.E.': ['Computer Science', 'Electronics and Telecommunication', 'Mechanical Engineering'],
    'M.Tech': ['Computer Science', 'Electronics and Telecommunication', 'Data Science'],
    MCA: ['Computer Science', 'Data Science'],
    MBA: ['Finance', 'Marketing'],
    'B.Sc': ['Computer Science', 'Data Science'],
    'B.Com': [],
  };

  const courseId = new Map<string, string>();
  /** courseName -> branchName -> specialisation id, for the Map data below. */
  const specId = new Map<string, Map<string, string>>();

  for (const [name, taught] of Object.entries(COURSES)) {
    const c = await prisma.course.create({ data: { name } });
    courseId.set(name, c.id);

    const mine = new Map<string, string>();
    for (const branch of taught) {
      // A specialisation is a branch as offered by one course, so the pair is
      // what makes it unique.
      const sp = await prisma.specialisation.create({
        data: { name: branch, courseId: c.id, branchId: branchId.get(branch)! },
      });
      mine.set(branch, sp.id);
    }
    specId.set(name, mine);
  }

  /* --- what the university offers ---------------------------------------- */

  const sppu = await prisma.tenant.findFirstOrThrow({ where: { slug: 'sppu' } });

  /** SPPU is an engineering-and-management university, not a medical one. */
  const OFFERED: Record<string, string[]> = {
    'B.Tech': [
      'Computer Science',
      'Information Technology',
      'Electronics and Telecommunication',
      'Mechanical Engineering',
      'Civil',
    ],
    'M.Tech': ['Computer Science', 'Data Science'],
    MCA: ['Computer Science'],
    MBA: ['Finance', 'Marketing'],
  };

  for (const [course, branches] of Object.entries(OFFERED)) {
    for (const branch of branches) {
      await prisma.tenantProgram.create({
        data: {
          tenantId: sppu.id,
          courseId: courseId.get(course)!,
          specialisationId: specId.get(course)!.get(branch)!,
        },
      });
    }
  }

  /* --- what each college runs -------------------------------------------- */

  /*
   * Taken from the batches each college already has, so the programmes and
   * the roster cannot disagree - which is the whole failure Map data exists
   * to prevent. Their students' own course and branch are written from the
   * same place, as a roster import would have done, so that
   * `setCollegePrograms` links them to the programme on the way past.
   */
  // SPPU's own. Another tenant's college is another tenant's business, and
  // `setCollegePrograms` refuses it anyway.
  const colleges = await prisma.college.findMany({
    where: { tenantId: sppu.id },
    select: { id: true, name: true },
  });

  for (const college of colleges) {
    const batches = await prisma.batch.findMany({
      where: { collegeId: college.id },
      select: { id: true, course: true, specialisation: true },
    });

    for (const batch of batches) {
      if (!batch.course || !batch.specialisation) continue;
      await prisma.candidate.updateMany({
        where: { batchMemberships: { some: { batchId: batch.id } }, course: null },
        data: { course: batch.course, specialisation: batch.specialisation },
      });
    }

    const pairs = new Map<string, { courseId: string; branchId: string | null; intake: number }>();
    for (const batch of batches) {
      const cid = batch.course ? courseId.get(batch.course) : undefined;
      const sid = batch.specialisation ? specId.get(batch.course!)?.get(batch.specialisation) : undefined;
      // A batch naming something the catalogue does not have is skipped
      // rather than invented: the catalogue is the platform's, not a batch's.
      if (!cid || !sid) continue;
      pairs.set(`${cid}|${sid}`, { courseId: cid, branchId: sid, intake: 120 });
    }
    if (pairs.size === 0) continue;

    // The production path, not a copy of it: it checks each pair against what
    // the university offers and links matching students, which is exactly
    // what a placement cell doing this by hand would get.
    await setCollegePrograms(sppu.id, college.id, [...pairs.values()]);
  }

  const mapped = await prisma.candidate.count({ where: { collegeProgramId: { not: null } } });
  console.log(
    `  ${courseId.size} courses, ${BRANCHES.length} branches, ` +
      `${await prisma.collegeProgram.count()} college programmes, ${mapped} students mapped`,
  );
}


/* -------------------------------------------------------------------------- */
/* The rest of a student profile                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fills in every field the profile asks for and no seed ever wrote.
 *
 * The demo had 120 students with a course, marks and a degree row, and
 * nothing else: no date of birth, nothing under Preferences, no internship,
 * no 10th or 12th, no student-entered qualification at all. So half the
 * profile screen was empty on every account, the fields a role can filter on
 * had nobody to filter, and the two features that turn on a distinction - a
 * college row against a student's own, a declared accommodation against a
 * role that offers one - had no second case to show.
 *
 * Deterministic: every value is a function of the student's position in the
 * roster, never of `Math.random`, so the seed keeps its promise that the
 * same students get the same numbers on every run.
 */
async function seedProfileDetail() {
  console.log('Profile detail...');

  const candidates = await prisma.candidate.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      gender: true,
      prn: true,
      graduationYear: true,
      tenthPct: true,
      twelfthPct: true,
      diplomaPct: true,
      cgpa: true,
      isLateralEntry: true,
      activeBacklogs: true,
      gapYears: true,
      batchMemberships: {
        select: { id: true, division: true, batch: { select: { graduationYear: true } } },
      },
    },
  });

  const ABOUT = [
    'Final-year student. I like the part of a problem where you work out what it actually is.',
    'I build things end to end and care most about the bit users touch.',
    'Backend by preference. Happiest when a slow query gets fast.',
    'I picked up data work through a college project and stayed with it.',
    'I would rather write the test than debug it later. Usually.',
    'Interested in systems that stay up, and learning where the sharp edges are.',
  ];

  const BOARDS = ['Maharashtra State Board', 'CBSE', 'ICSE'];
  const SCHOOLS = [
    'Modern High School',
    'St. Ann\u2019s High School',
    'Abhinav Vidyalaya',
    'Loyola High School',
    'New English School',
  ];
  const JUNIOR = ['Fergusson College', 'S. P. College', 'Nowrosjee Wadia College', 'Modern College'];
  const POLY = ['Government Polytechnic, Pune', 'Cusrow Wadia Institute of Technology'];

  const INTERNSHIPS = [
    {
      title: 'Backend intern',
      org: 'Zenith Labs',
      what: 'Wrote the reporting endpoints and the tests behind them. Took one report from nine seconds to under one by fixing an N+1.',
    },
    {
      title: 'Frontend intern',
      org: 'Northwind Analytics',
      what: 'Built the dashboard filters and kept them working on a phone. First screen I owned end to end.',
    },
    {
      title: 'Data intern',
      org: 'Indus Systems',
      what: 'Cleaned three years of sales data into something a model could read, and wrote down what I discarded and why.',
    },
    {
      title: 'QA intern',
      org: 'Solace Health',
      what: 'Automated the regression pack. A day by hand became twenty minutes on a runner.',
    },
    {
      title: 'Summer trainee',
      org: 'Vertex Motors',
      what: 'Sat with the embedded team and wrote the serial-logging tool they still use.',
    },
  ];

  const TRAVEL_VALUES = ['NONE', 'OCCASIONAL', 'FREQUENT'];

  /** Yes, no, and not-said in turn, so the three-state control shows all three. */
  const tri = (i: number): boolean | null => (i % 3 === 0 ? true : i % 3 === 1 ? false : null);

  const educations: Prisma.EducationCreateManyInput[] = [];
  const experiences: Prisma.ExperienceCreateManyInput[] = [];

  for (const [i, c] of candidates.entries()) {
    const membership = c.batchMemberships[0];
    const gradYear = c.graduationYear ?? membership?.batch.graduationYear ?? 2026;

    /* Worked out once, because the diploma row below has to carry the same
       number the column does - two marks for one exam is the contradiction
       this whole pass exists to avoid. */
    const diplomaPct =
      c.diplomaPct ?? (c.isLateralEntry ? Math.round((62 + (i % 28)) * 100) / 100 : null);

    /*
     * The fields the depth layer already writes for its own students, so the
     * fourteen from this file stop being the odd ones out - a demo where a
     * seventh of the roster has no gender is a demo where a role restricted
     * by gender quietly loses a seventh of its applicants.
     */
    await prisma.candidate.update({
      where: { id: c.id },
      data: {
        ...(c.gender ? {} : { gender: i % 5 === 0 || i % 5 === 3 ? 'Female' : 'Male' }),
        ...(c.prn ? {} : { prn: `PRN${gradYear}${String(90000 + i).padStart(5, '0')}` }),

        // Born about 22 years before they graduate. The day is spread so a
        // list sorted by it is not one long tie.
        dateOfBirth: new Date(Date.UTC(gradYear - 22, i % 12, (i % 27) + 1)),
        about: pick(ABOUT, i),

        /*
         * What they will take. All three states appear - and null is a real
         * one here, meaning "has not said", which is what the Preferences
         * band exists to turn into an answer.
         */
        openToRelocate: tri(i),
        openToNightShift: tri(i + 1),
        openToTravel: i % 4 === 3 ? null : pick(TRAVEL_VALUES, i),

        /*
         * A percentage as well as a CGPA for some of them. Universities are
         * split on which they award and a role may set its bar on either, so
         * with this column empty everywhere half of that rule was never
         * exercised by anything.
         */
        ...(i % 5 === 0 && c.cgpa ? { degreePct: Math.round(Number(c.cgpa) * 9.5 * 100) / 100 } : {}),

        /*
         * A lateral entrant's diploma mark. The flag was seeded without it,
         * so every one of them failed a role's diploma bar for want of the
         * number the bar exists to read - which is the exact failure the
         * column was added to prevent.
         */
        ...(c.isLateralEntry ? { diplomaPct } : {}),

        // The two the depth layer writes and this file's fourteen never got.
        ...(c.activeBacklogs === null ? { activeBacklogs: 0 } : {}),
        ...(c.gapYears === null ? { gapYears: 0 } : {}),

        /*
         * A few students declare a disability, with the support they need in
         * the same keys a role offers it in. Without a single one, neither
         * side of that match had anything to match.
         */
        ...(i % 31 === 7
          ? {
              isPwd: true,
              pwdCategories: [pick(['LOCOMOTOR', 'HEARING', 'VISUAL', 'LEARNING'], i)],
              pwdPct: 40 + (i % 5) * 10,
              accommodations: [pick(['WHEELCHAIR', 'SIGN_LANGUAGE', 'SCREEN_READER', 'EXTRA_TIME'], i)],
            }
          : {}),
      },
    });

    if (membership && !membership.division) {
      await prisma.batchMembership.update({
        where: { id: membership.id },
        data: { division: pick(['A', 'B'], i) },
      });
    }

    /*
     * School, in the student's own name.
     *
     * Every education row in the demo was the college's degree, which left
     * the distinction this screen now turns on - a row the college entered
     * against a row the student did - with only one side of it on screen.
     * The percentages are the verified ones, so the qualification and the
     * mark above it agree rather than being two numbers about one exam.
     */
    educations.push({
      candidateId: c.id,
      degree: 'Secondary (10th / SSC)',
      institution: pick(SCHOOLS, i),
      board: pick(BOARDS, i),
      startYear: gradYear - 10,
      endYear: gradYear - 8,
      percentage: c.tenthPct,
      source: RecordSource.STUDENT,
    });

    // A lateral entrant has a diploma where everybody else has a 12th, which
    // is the whole reason the profile asks for both.
    educations.push(
      c.isLateralEntry
        ? {
            candidateId: c.id,
            degree: 'Diploma',
            institution: pick(POLY, i),
            board: 'MSBTE',
            startYear: gradYear - 8,
            endYear: gradYear - 5,
            percentage: diplomaPct,
            source: RecordSource.STUDENT,
          }
        : {
            candidateId: c.id,
            degree: 'Higher Secondary (12th / HSC)',
            institution: pick(JUNIOR, i),
            board: pick(BOARDS, i + 1),
            startYear: gradYear - 8,
            endYear: gradYear - 6,
            percentage: c.twelfthPct,
            source: RecordSource.STUDENT,
          },
    );

    /*
     * An internship for two in three, with what they actually did in it.
     * The description column has been on the table and in the resume
     * renderer from the start with nothing ever written into it, so every
     * built resume listed a company, two dates and no work.
     */
    if (i % 3 !== 2) {
      const job = pick(INTERNSHIPS, i);
      experiences.push({
        candidateId: c.id,
        title: job.title,
        organisation: job.org,
        location: pick(['Pune', 'Mumbai', 'Bengaluru', 'Remote'], i),
        startDate: new Date(Date.UTC(gradYear - 1, 4, 15)),
        endDate: new Date(Date.UTC(gradYear - 1, 6, 15)),
        isCurrent: false,
        description: job.what,
      });
    }
  }

  await prisma.education.createMany({ data: educations });
  await prisma.experience.createMany({ data: experiences });

  /* When each project ran, so a reader can tell last term's work from first
     year's. The columns existed; the form never offered them. */
  const projects = await prisma.project.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, candidateId: true },
  });
  const gradOf = new Map(candidates.map((c) => [c.id, c.graduationYear ?? 2026]));
  for (const [i, project] of projects.entries()) {
    const year = (gradOf.get(project.candidateId) ?? 2026) - 1;
    await prisma.project.update({
      where: { id: project.id },
      data: {
        startDate: new Date(Date.UTC(year, i % 9, 1)),
        endDate: new Date(Date.UTC(year, (i % 9) + 2, 1)),
      },
    });
  }

  console.log(
    `  ${educations.length} school qualifications, ${experiences.length} internships, ` +
      `${projects.length} projects dated, ` +
      `${await prisma.candidate.count({ where: { isPwd: true } })} declared PwD`,
  );
}


async function main() {
  console.log('Clearing…');
  await clear();

  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (email: string, fullName: string, role: Role) =>
    prisma.user.create({ data: { email, fullName, passwordHash, role } });

  // --- operations ---------------------------------------------------------
  console.log('Operations…');
  const admin = await mkUser('admin@apli.example', 'Super Admin', Role.ADMIN);

  // --- skills -------------------------------------------------------------
  await prisma.skill.createMany({ data: SKILLS.map((name) => ({ name })) });
  const skills = await prisma.skill.findMany();

  /*
   * --- the small vocabularies operations keeps ----------------------------
   *
   * Cities, states, NAAC grades and genders. Left out of this seed until
   * now, which meant a freshly seeded demo had four empty dropdowns - and
   * an empty gender list is not a cosmetic gap: gender is a bar a role can
   * be restricted on, so a student who cannot state theirs quietly fails
   * every restricted role and is never told why.
   *
   * Operations edits all of it afterwards. This is only somewhere to start.
   */
  console.log('Reference lists…');
  const REFERENCE: Record<RefKind, string[]> = {
    [RefKind.CITY]: [
      'Pune', 'Mumbai', 'Nashik', 'Nagpur', 'Aurangabad', 'Kolhapur', 'Thane',
      'Bengaluru', 'Hyderabad', 'Chennai', 'Delhi', 'Gurugram', 'Noida', 'Ahmedabad', 'Remote',
    ],
    [RefKind.STATE]: [
      'Maharashtra', 'Karnataka', 'Telangana', 'Tamil Nadu', 'Gujarat', 'Delhi', 'Uttar Pradesh',
    ],
    // The grades NAAC actually awards, best first.
    [RefKind.NAAC_GRADE]: ['A++', 'A+', 'A', 'B++', 'B+', 'B', 'C'],
    // The four the eligibility matcher already knows how to read.
    [RefKind.GENDER]: ['Female', 'Male', 'Other', 'Prefer not to say'],
  };
  for (const [kind, values] of Object.entries(REFERENCE)) {
    await prisma.refValue.createMany({
      // Position, so a dropdown reads in the order somebody chose rather
      // than alphabetically - 'A++' after 'A' would be wrong.
      data: values.map((value, position) => ({ kind: kind as RefKind, value, position })),
    });
  }

  // --- college types (operations-managed reference data) -------------------
  console.log('College types…');
  const TYPES = [
    'Engineering',
    'Management',
    'Pharmacy',
    'Architecture',
    'Science',
    'Commerce',
    'Law',
    'Medical',
  ];
  for (const name of TYPES) {
    await prisma.collegeType.create({ data: { name } });
  }
  // Industries a campus placement cell actually sorts recruiters by. Admin
  // manages the list afterwards; this is only somewhere to start.
  const INDUSTRIES = [
    'Information Technology',
    'Software Products',
    'Consulting',
    'Banking and Financial Services',
    'Manufacturing',
    'Automotive',
    'Core Engineering',
    'Pharmaceuticals and Life Sciences',
    'Telecommunications',
    'E-commerce and Retail',
    'Analytics and Data Science',
    'Education and EdTech',
    'Government and Public Sector',
  ];
  for (const name of INDUSTRIES) {
    await prisma.industry.create({ data: { name } });
  }

  const engineering = await prisma.collegeType.findUniqueOrThrow({
    where: { name: 'Engineering' },
  });

  // --- tenants ---------------------------------------------------------------
  //
  // One institution already live, holding the whole demo world, and one the
  // platform team has only just started onboarding - so the console has a
  // finished tenant to step into and an unfinished one to carry on with.
  console.log('Tenants…');
  const ONBOARDING_STEPS = ['identity', 'academics', 'colleges', 'batches', 'features', 'people', 'review'];

  const sppu = await prisma.tenant.create({
    data: {
      name: 'Savitribai Phule Pune University',
      shortName: 'SPPU',
      slug: 'sppu',
      kind: 'UNIVERSITY',
      status: 'ACTIVE',
      brandColor: '#1d3b8b',
      city: 'Pune',
      state: 'Maharashtra',
      website: 'https://www.demo-university.example',
      plan: 'CUSTOM',
      completedSteps: ONBOARDING_STEPS,
      launchedAt: new Date(),
      modules: {
        create: CORE_KEYS.map((moduleKey) => ({ moduleKey, enabled: true })),
      },
    },
  });

  await prisma.tenant.create({
    data: {
      name: 'Symbiosis Institute of Technology',
      shortName: 'SIT',
      slug: 'sit',
      kind: 'COLLEGE',
      status: 'DRAFT',
      brandColor: '#8a1c2b',
      city: 'Pune',
      state: 'Maharashtra',
      completedSteps: ['identity'],
    },
  });

  // --- colleges -----------------------------------------------------------
  console.log('Colleges…');
  // Colleges affiliated to Savitribai Phule Pune University. Only the first two
  // get a placement officer - the rest sit there unonboarded, which is what a
  // real rollout looks like and gives operations something to work through.
  // Real college names, but the accreditation grades and contact details below
  // are placeholders for the demo - not claims about these institutions.
  const SPPU = 'Savitribai Phule Pune University';

  const rait = await prisma.college.create({
    data: {
      tenantId: sppu.id,
      name: 'Pune Institute of Computer Technology',
      code: 'PICT',
      city: 'Pune',
      state: 'Maharashtra',
      collegeTypeId: engineering.id,
      affiliation: SPPU,
      address: 'Survey No. 27, Near Trimurti Chowk, Dhankawadi',
      pincode: '411043',
      naacGrade: 'A+',
      isVerified: true,
    },
  });
  const fcrce = await prisma.college.create({
    data: {
      tenantId: sppu.id,
      name: 'Vishwakarma Institute of Technology',
      code: 'VIT-PUNE',
      city: 'Pune',
      state: 'Maharashtra',
      collegeTypeId: engineering.id,
      affiliation: SPPU,
      address: '666, Upper Indiranagar, Bibwewadi',
      pincode: '411037',
      naacGrade: 'A++',
      isVerified: true,
    },
  });

  // Onboarded but with no placement officer yet - what a real rollout looks
  // like, and it gives operations a queue to work through.
  for (const [name, code, naacGrade] of [
    ['Cummins College of Engineering for Women', 'CCOEW', 'A'],
    ['AISSMS College of Engineering', 'AISSMS', 'A'],
    ['Sinhgad College of Engineering', 'SCOE', 'A'],
    ['PVG College of Engineering and Technology', 'PVGCOET', 'B++'],
    ['Modern Education Society College of Engineering', 'MESCOE', 'B++'],
  ] as const) {
    await prisma.college.create({
      data: {
        tenantId: sppu.id,
        name,
        code,
        city: 'Pune',
        state: 'Maharashtra',
        collegeTypeId: engineering.id,
        affiliation: SPPU,
        naacGrade,
      },
    });
  }

  // --- roles ---------------------------------------------------------------
  //
  // The same set the migration inserts, so a database built from migrations
  // and one built from this seed end up identical.
  console.log('Roles…');
  for (const role of SYSTEM_ROLES) {
    await prisma.platformRole.upsert({
      where: { key: role.key },
      update: { name: role.name, description: role.description, permissions: role.permissions },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        scope: role.scope as RoleScope,
        permissions: role.permissions,
        isSystem: true,
      },
    });
  }

  const roleId = async (key: string) =>
    (await prisma.platformRole.findUniqueOrThrow({ where: { key }, select: { id: true } })).id;

  const officerRole = await roleId('campus.officer');
  const ownerRole = await roleId('company.owner');
  const recruiterRole = await roleId('company.recruiter');
  const superAdminRole = await roleId('admin.super');

  // Whoever was made an admin before roles existed gets the full one. The
  // super admin is the platform team - no tenant - which is what lets it
  // onboard institutions and step into any of them.
  for (const admin of await prisma.user.findMany({ where: { role: Role.ADMIN } })) {
    await prisma.adminMember.upsert({
      where: { userId: admin.id },
      update: {},
      create: { userId: admin.id, roleId: superAdminRole, tenantId: null },
    });
  }

  // And one person who runs the university and nothing else, so the fence
  // between institutions can be seen from the inside.
  const universityOps = await mkUser('ops@demo-university.example', 'Sunita Joshi', Role.ADMIN);
  await prisma.adminMember.create({
    data: {
      userId: universityOps.id,
      roleId: await roleId('admin.university'),
      tenantId: sppu.id,
    },
  });

  const tpo = await mkUser('tpo@pict.demo-college.example', 'Dr. Meera Kulkarni', Role.CAMPUS);
  await prisma.campusMember.create({
    data: { userId: tpo.id, collegeId: rait.id, roleId: officerRole },
  });

  const tpo2 = await mkUser('tpo@vit.demo-college.example', 'Prof. Anil Deshpande', Role.CAMPUS);
  await prisma.campusMember.create({
    data: { userId: tpo2.id, collegeId: fcrce.id, roleId: officerRole },
  });

  // --- batches and students ----------------------------------------------
  console.log('Batches and students…');
  const cse = await prisma.batch.create({
    data: {
      collegeId: rait.id,
      tenantId: sppu.id,
      name: 'CSE 2026',
      course: 'B.Tech',
      specialisation: 'Computer Science',
      graduationYear: 2026,
      headOfDept: 'Dr. S. Deshmukh',
    },
  });
  const it = await prisma.batch.create({
    data: {
      collegeId: rait.id,
      tenantId: sppu.id,
      name: 'IT 2026',
      course: 'B.Tech',
      specialisation: 'Information Technology',
      graduationYear: 2026,
      headOfDept: 'Dr. K. Bhagat',
    },
  });

  const students: { candidateId: string; userId: string; name: string; frozen: boolean }[] = [];

  for (let i = 0; i < 14; i++) {
    const name = `${pick(FIRST, i)} ${pick(LAST, i)}`;
    const email = `${pick(FIRST, i).toLowerCase()}.${pick(LAST, i).toLowerCase()}${i}@pict.demo-college.example`;
    const batch = i < 9 ? cse : it;
    // Most are verified; a few are left pending so the freeze queue is not empty.
    const frozen = i < 11;

    const user = await mkUser(email, name, Role.CANDIDATE);
    const candidate = await prisma.candidate.create({
      data: {
        userId: user.id,
        collegeId: rait.id,
        phone: `90000${String(i).padStart(5, '0')}`,
        graduationYear: 2026,
        headline: 'Final-year student looking for a first role',
        cgpa: rand(6.2, 9.4),
        tenthPct: rand(70, 96),
        twelfthPct: rand(68, 94),
        backlogs: i % 7 === 0 ? 1 : 0,
        resumeUrl: `https://example.com/resumes/${i}.pdf`,
      },
    });

    await prisma.batchMembership.create({
      data: {
        batchId: batch.id,
        candidateId: candidate.id,
        rollNo: `${batch === cse ? 'CS' : 'IT'}22-${String(101 + i).padStart(3, '0')}`,
        isFrozen: frozen,
        verifiedAt: frozen ? new Date() : null,
      },
    });

    /* The degree itself comes from the college's own records, so it is
       marked as theirs: it is the evidence for the verified CGPA above it,
       and a student who could delete it could delete the evidence and then
       write their own. Everything they add below it stays theirs. */
    await prisma.education.create({
      data: {
        candidateId: candidate.id,
        degree: 'B.Tech Computer Science',
        institution: rait.name,
        startYear: 2022,
        endYear: 2026,
        cgpa: candidate.cgpa,
        source: RecordSource.COLLEGE,
      },
    });

    await prisma.project.create({
      data: {
        candidateId: candidate.id,
        title: pick(['Campus bus tracker', 'Expense splitter', 'Chat app', 'Recipe finder'], i),
        description: 'A final-year project built with a small team.',
        links: [
          { url: 'https://github.com/example/project', label: 'Repository' },
          { url: 'https://example.com/demo', label: 'Live demo' },
        ],
      },
    });

    for (let s = 0; s < 4; s++) {
      await prisma.candidateSkill.create({
        data: { candidateId: candidate.id, skillId: pick(skills, i + s).id },
      });
    }

    students.push({ candidateId: candidate.id, userId: user.id, name, frozen });
  }

  // --- drives -------------------------------------------------------------
  console.log('Drives…');
  const finals = await prisma.placement.create({
    data: {
      collegeId: rait.id,
      name: '2026 Final Placements',
      type: PlacementType.FINAL,
      year: 2026,
      oneOfferRule: true,
      batches: { connect: [{ id: cse.id }, { id: it.id }] },
    },
  });
  await prisma.placement.create({
    data: {
      collegeId: rait.id,
      name: '2026 Summer Internships',
      type: PlacementType.INTERNSHIP,
      year: 2026,
      // Internships let a student hold more than one.
      oneOfferRule: false,
      batches: { connect: [{ id: cse.id }] },
    },
  });
  const fcrceDrive = await prisma.placement.create({
    data: {
      collegeId: fcrce.id,
      name: '2026 Final Placements',
      type: PlacementType.FINAL,
      year: 2026,
      oneOfferRule: true,
    },
  });

  // --- companies ----------------------------------------------------------
  console.log('Companies…');
  const software = await prisma.industry.findUniqueOrThrow({
    where: { name: 'Software Products' },
  });
  const analytics = await prisma.industry.findUniqueOrThrow({
    where: { name: 'Analytics and Data Science' },
  });

  // Entered by operations, so verified on the spot and appliedAt stays null.
  const zenith = await prisma.company.create({
    data: {
      name: 'Zenith Labs',
      legalName: 'Zenith Labs Private Limited',
      website: 'https://zenithlabs.example',
      careersUrl: 'https://zenithlabs.example/careers',
      about: 'Developer tooling, built in Pune and used by teams across the country.',
      industryId: software.id,
      sizeBand: CompanySize.MID,
      foundedYear: 2016,
      city: 'Pune',
      state: 'Maharashtra',
      status: CompanyStatus.VERIFIED,
      reviewedAt: new Date(),
    },
  });
  const northwind = await prisma.company.create({
    data: {
      name: 'Northwind Analytics',
      legalName: 'Northwind Analytics LLP',
      website: 'https://northwind.example',
      about: 'Data and reporting for retail.',
      industryId: analytics.id,
      sizeBand: CompanySize.SMALL,
      foundedYear: 2019,
      city: 'Bengaluru',
      state: 'Karnataka',
      status: CompanyStatus.VERIFIED,
      reviewedAt: new Date(),
    },
  });
  // Signed itself up and is sitting in the review queue - the state operations
  // needs something to look at on day one.
  const unverified = await prisma.company.create({
    data: {
      name: 'Fledgling Startup',
      website: 'https://fledgling.example',
      about: 'Two founders and an idea. Wants to hire two interns.',
      industryId: software.id,
      sizeBand: CompanySize.STARTUP,
      foundedYear: 2025,
      city: 'Pune',
      state: 'Maharashtra',
      status: CompanyStatus.PENDING,
      appliedAt: new Date(),
    },
  });

  const kavya = await mkUser('hiring@zenithlabs.example', 'Kavya Menon', Role.COMPANY);
  await prisma.companyMember.create({
    data: { userId: kavya.id, companyId: zenith.id, roleId: ownerRole },
  });
  const arjun = await mkUser('arjun@zenithlabs.example', 'Arjun Rao', Role.COMPANY);
  await prisma.companyMember.create({
    data: { userId: arjun.id, companyId: zenith.id, roleId: recruiterRole },
  });
  const nw = await mkUser('talent@northwind.example', 'Farhan Qureshi', Role.COMPANY);
  await prisma.companyMember.create({
    data: { userId: nw.id, companyId: northwind.id, roleId: ownerRole },
  });
  const fs = await mkUser('founder@fledgling.example', 'Ritu Bansal', Role.COMPANY);
  await prisma.companyMember.create({
    data: { userId: fs.id, companyId: unverified.id, roleId: ownerRole },
  });

  // --- jobs ---------------------------------------------------------------
  console.log('Roles and rounds…');
  async function makeJob(
    companyId: string,
    createdById: string,
    title: string,
    opts: {
      description: string;
      ctcMin?: number;
      ctcMax?: number;
      minCgpa?: number;
      status?: JobStatus;
      rounds: { name: string; type: string }[];
    },
  ) {
    const job = await prisma.job.create({
      data: {
        companyId,
        createdById,
        title,
        description: opts.description,
        location: 'Pune',
        ctcMin: opts.ctcMin ?? null,
        ctcMax: opts.ctcMax ?? null,
        deadline: daysFromNow(30),
        status: opts.status ?? JobStatus.PUBLISHED,
        publishedAt: opts.status === JobStatus.DRAFT ? null : new Date(),
        minCgpa: opts.minCgpa ?? null,
        courses: { create: [{ course: 'B.Tech' }] },
        gradYears: { create: [{ year: 2026 }] },
      },
    });
    for (const [i, r] of opts.rounds.entries()) {
      await prisma.round.create({
        data: { jobId: job.id, order: i + 1, name: r.name, type: r.type, isElimination: true },
      });
    }
    return job;
  }

  const seJob = await makeJob(zenith.id, kavya.id, 'Software Engineer', {
    description: 'Build and ship backend services for our platform team.',
    ctcMin: 900000,
    ctcMax: 1400000,
    minCgpa: 7.5,
    rounds: [
      { name: 'Resume screen', type: 'RESUME_SCREEN' },
      { name: 'Online test', type: 'MCQ_TEST' },
      { name: 'Technical interview', type: 'LIVE_INTERVIEW' },
      { name: 'Final round', type: 'LIVE_INTERVIEW' },
    ],
  });

  const daJob = await makeJob(northwind.id, nw.id, 'Data Analyst', {
    description: 'Analyse retail product usage and build reporting for the growth team.',
    ctcMin: 700000,
    ctcMax: 1000000,
    minCgpa: 7.0,
    rounds: [
      { name: 'Resume screen', type: 'RESUME_SCREEN' },
      { name: 'Case study', type: 'ASSIGNMENT' },
      { name: 'Interview', type: 'LIVE_INTERVIEW' },
    ],
  });

  const qaJob = await makeJob(zenith.id, arjun.id, 'QA Engineer', {
    description: 'Own test automation for the platform team and keep the suite fast.',
    ctcMin: 650000,
    ctcMax: 900000,
    rounds: [
      { name: 'Resume screen', type: 'RESUME_SCREEN' },
      { name: 'Interview', type: 'LIVE_INTERVIEW' },
    ],
  });

  await makeJob(zenith.id, kavya.id, 'Product Designer', {
    description: 'Still being written up.',
    status: JobStatus.DRAFT,
    rounds: [{ name: 'Portfolio review', type: 'RESUME_SCREEN' }],
  });

  // --- postings: two accepted, one still waiting on the TPO ---------------
  console.log('Postings…');
  await prisma.jobPosting.create({
    data: {
      jobId: seJob.id,
      placementId: finals.id,
      status: PostingStatus.ACCEPTED,
      decidedById: tpo.id,
      decidedAt: new Date(),
    },
  });
  await prisma.jobPosting.create({
    data: {
      jobId: daJob.id,
      placementId: finals.id,
      status: PostingStatus.ACCEPTED,
      decidedById: tpo.id,
      decidedAt: new Date(),
    },
  });
  // Left PENDING so the approval queue has something in it on first login.
  await prisma.jobPosting.create({
    data: { jobId: qaJob.id, placementId: finals.id, status: PostingStatus.PENDING },
  });
  await prisma.jobPosting.create({
    data: { jobId: seJob.id, placementId: fcrceDrive.id, status: PostingStatus.PENDING },
  });

  // --- applications across the pipeline -----------------------------------
  console.log('Applications…');
  const verified = students.filter((s) => s.frozen);

  async function apply(candidateId: string, jobId: string, to: S[], actorId: string) {
    const app = await prisma.application.create({
      data: { candidateId, jobId, placementId: finals.id, status: S.APPLIED },
    });
    await prisma.statusEvent.create({
      data: { applicationId: app.id, toStatus: S.APPLIED, reason: 'applied', actorId: null },
    });

    let from: S = S.APPLIED;
    for (const next of to) {
      await prisma.statusEvent.create({
        data: { applicationId: app.id, fromStatus: from, toStatus: next, actorId },
      });
      from = next;
    }
    if (to.length) {
      await prisma.application.update({ where: { id: app.id }, data: { status: from } });
    }
    return app;
  }

  const rounds = await prisma.round.findMany({ where: { jobId: seJob.id }, orderBy: { order: 'asc' } });

  // A spread across every stage, so each dashboard has something to show.
  await apply(verified[0]!.candidateId, seJob.id, [], kavya.id);
  await apply(verified[1]!.candidateId, seJob.id, [S.UNDER_REVIEW], kavya.id);
  const inRound = await apply(
    verified[2]!.candidateId,
    seJob.id,
    [S.UNDER_REVIEW, S.IN_ROUND],
    kavya.id,
  );
  await prisma.application.update({
    where: { id: inRound.id },
    data: { currentRoundId: rounds[1]!.id },
  });
  await prisma.roundResult.create({
    data: {
      applicationId: inRound.id,
      roundId: rounds[0]!.id,
      outcome: RoundOutcome.PASSED,
      score: 78,
      feedback: 'Solid fundamentals.',
      evaluatedById: kavya.id,
      evaluatedAt: new Date(),
    },
  });
  await prisma.roundResult.create({
    data: { applicationId: inRound.id, roundId: rounds[1]!.id, outcome: RoundOutcome.PENDING },
  });

  await apply(verified[3]!.candidateId, seJob.id, [S.UNDER_REVIEW, S.WAITLISTED], kavya.id);
  await apply(verified[4]!.candidateId, seJob.id, [S.UNDER_REVIEW, S.REJECTED], kavya.id);
  await apply(
    verified[5]!.candidateId,
    seJob.id,
    [S.UNDER_REVIEW, S.IN_ROUND, S.OFFERED],
    kavya.id,
  );

  // One student who accepted, with a second application closed by the rule.
  const placed = verified[6]!;
  await apply(
    placed.candidateId,
    seJob.id,
    [S.UNDER_REVIEW, S.IN_ROUND, S.OFFERED, S.ACCEPTED, S.HIRED],
    kavya.id,
  );
  const closed = await prisma.application.create({
    data: { candidateId: placed.candidateId, jobId: daJob.id, placementId: finals.id, status: S.WITHDRAWN },
  });
  await prisma.statusEvent.createMany({
    data: [
      { applicationId: closed.id, toStatus: S.APPLIED, reason: 'applied' },
      {
        applicationId: closed.id,
        fromStatus: S.APPLIED,
        toStatus: S.WITHDRAWN,
        reason: 'auto_placed',
        note: 'Closed automatically: the student accepted an offer in this drive.',
      },
    ],
  });

  await apply(verified[7]!.candidateId, daJob.id, [S.UNDER_REVIEW], nw.id);
  await apply(verified[8]!.candidateId, daJob.id, [], nw.id);

  // --- depth ---------------------------------------------------------------
  // Everything above is one careful example of each thing. This is the volume
  // that makes a chart worth looking at: more cohorts, a finished season to
  // compare against, companies in every state, and applications spread across
  // the whole status table over ten months.
  console.log('Depth layer…');
  const depthLogins = await seedDepth(passwordHash);

  // --- the course catalogue, and who runs what -----------------------------
  await seedPrograms();

  // --- the half of a profile no seed ever filled in ------------------------
  await seedProfileDetail();

  // --- done ---------------------------------------------------------------
  // The shared practice bank. Idempotent on its own, so it is safe even if
  // the tables above were not cleared.
  const bank = await seedAptitude(prisma);
  console.log(`Aptitude bank: ${bank.added} added, ${bank.updated} updated.`);

  const counts = {
    users: await prisma.user.count(),
    colleges: await prisma.college.count(),
    companies: await prisma.company.count(),
    students: await prisma.candidate.count(),
    jobs: await prisma.job.count(),
    applications: await prisma.application.count(),
  };

  const line = '='.repeat(74);
  console.log(`
${line}
  Seeded
${line}`);
  console.table(counts);

  /* --- the credentials, in one place ------------------------------------- */
  //
  // Printed as one table rather than scattered through the log, because the
  // first thing anybody does with a fresh database is go looking for a login
  // and the second is give up and read the seed script.
  const fixed: { email: string; role: string; what: string }[] = [
    { email: 'admin@apli.example', role: 'Admin', what: 'super admin, platform team, every institution' },
    { email: 'ops@demo-university.example', role: 'Admin', what: 'university admin, SPPU only' },
    { email: 'tpo@pict.demo-college.example', role: 'Campus', what: 'placement officer, PICT - the rich college' },
    { email: 'tpo@vit.demo-college.example', role: 'Campus', what: 'placement officer, VIT Pune' },
    { email: 'hiring@zenithlabs.example', role: 'Company', what: 'Zenith Labs - owner (verified)' },
    { email: 'arjun@zenithlabs.example', role: 'Company', what: 'Zenith Labs - recruiter, not an owner' },
    { email: 'talent@northwind.example', role: 'Company', what: 'Northwind Analytics - owner (verified)' },
    { email: 'founder@fledgling.example', role: 'Company', what: 'Fledgling Startup - owner (pending review)' },
  ];

  const all = [...fixed, ...depthLogins];
  const pad = Math.max(...all.map((l) => l.email.length));

  console.log(`
  Every account below signs in with:  ${PASSWORD}
`);
  let currentRole = '';
  for (const l of all.sort((a, b) => a.role.localeCompare(b.role) || a.email.localeCompare(b.email))) {
    if (l.role !== currentRole) {
      currentRole = l.role;
      console.log(`
  ${currentRole.toUpperCase()}`);
    }
    console.log(`    ${l.email.padEnd(pad)}  ${l.what}`);
  }

  console.log(`
  Students not listed follow the pattern`);
  console.log(`    first.last.NN@pict.demo-college.example   (PICT, ${await prisma.candidate.count({ where: { college: { code: 'PICT' } } })} students)`);
  console.log(`    first.last.NN@vit.demo-college.example    (VIT Pune)`);
  console.log(`  and use the same password. The full roster is on the campus login.`);
  console.log(`
${line}`);
  console.log(`  The super admin password is set separately: npm run create:admin
`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
