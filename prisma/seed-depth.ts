/**
 * The depth layer.
 *
 * `seed.ts` builds one careful example of each thing: a college, a drive, a
 * handful of students, one application at every stage. That is enough to read
 * the product and nowhere near enough to read a chart - a placement figure out
 * of seven students, or a funnel three applications wide, tells you the page
 * renders and nothing else.
 *
 * This adds the volume underneath it: six cohorts across two colleges, a
 * finished season from last year to compare this one against, companies in
 * every verification state, roles that are live, closed and still drafts, and
 * around two hundred and fifty applications spread over ten months and across
 * the whole status table - including the students who never applied to
 * anything, who are exactly the ones a placement cell goes looking for.
 *
 * Deterministic. The same world every run, so a number you noticed yesterday
 * is the same number today.
 */
import {
  ApplicationStatus as S,
  CompanySize,
  CompanyStatus,
  JobStatus,
  PlacementType,
  PostingStatus,
  Prisma,
  Role,
  RoundOutcome,
} from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';

/* -------------------------------------------------------------------------- */
/* Small tools                                                                 */
/* -------------------------------------------------------------------------- */

/** Seeded PRNG, so "random" means "varied", not "different every run". */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = prng(20260922);

const between = (min: number, max: number) => min + rng() * (max - min);
const round2 = (n: number) => Math.round(n * 100) / 100;
const intBetween = (min: number, max: number) => Math.floor(between(min, max + 1));
const chance = (p: number) => rng() < p;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

/** Ids we mint ourselves, so whole tables can go in with one insert. */
let counter = 0;
const nid = (prefix: string) => `d${prefix}${(counter++).toString(36).padStart(6, '0')}`;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const daysAhead = (n: number) => new Date(Date.now() + n * DAY);

/** Deterministic shuffle, so each role draws a different slice of the cohort. */
function shuffled<T>(xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const FIRST = [
  'Aarav', 'Saanvi', 'Vivaan', 'Anika', 'Reyansh', 'Myra', 'Advait', 'Kiara',
  'Ishaan', 'Aadhya', 'Atharva', 'Tanvi', 'Kabir', 'Riya', 'Shaurya', 'Sara',
  'Aryan', 'Ira', 'Dhruv', 'Avni', 'Yash', 'Prisha', 'Om', 'Diya',
  'Sarthak', 'Nandini', 'Parth', 'Mitali', 'Soham', 'Gauri', 'Rudra', 'Shreya',
  'Veer', 'Anushka', 'Krish', 'Trisha', 'Harsh', 'Pooja', 'Manas', 'Ketki',
];
const LAST = [
  'Deshmukh', 'Kulkarni', 'Patil', 'Joshi', 'Pawar', 'Shinde', 'Bhosale',
  'Gokhale', 'Chavan', 'Sawant', 'Naik', 'Thorat', 'Mane', 'Salunke',
  'Wagh', 'Jadhav', 'Kadam', 'Phadke', 'Gaikwad', 'Ranade',
];

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface Student {
  candidateId: string;
  userId: string;
  name: string;
  email: string;
  cgpa: number;
  frozen: boolean;
}

interface JobHandle {
  id: string;
  title: string;
  roundIds: string[];
  companyName: string;
}

export interface SeededLogin {
  email: string;
  role: string;
  what: string;
}

/* -------------------------------------------------------------------------- */
/* The status chains                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How an application actually got where it is.
 *
 * Every step here is legal under `ALLOWED` in applications/state.ts. A seeded
 * history the state machine would have refused is worse than none: the audit
 * trail on screen would be describing moves the product cannot make.
 */
const CHAIN: Record<S, S[]> = {
  [S.APPLIED]: [],
  [S.UNDER_REVIEW]: [S.UNDER_REVIEW],
  [S.SHORTLISTED]: [S.UNDER_REVIEW, S.SHORTLISTED],
  [S.IN_ROUND]: [S.UNDER_REVIEW, S.SHORTLISTED, S.IN_ROUND],
  [S.WAITLISTED]: [S.UNDER_REVIEW, S.WAITLISTED],
  [S.OFFERED]: [S.UNDER_REVIEW, S.SHORTLISTED, S.IN_ROUND, S.OFFERED],
  [S.ACCEPTED]: [S.UNDER_REVIEW, S.SHORTLISTED, S.IN_ROUND, S.OFFERED, S.ACCEPTED],
  [S.HIRED]: [S.UNDER_REVIEW, S.SHORTLISTED, S.IN_ROUND, S.OFFERED, S.ACCEPTED, S.HIRED],
  [S.DECLINED]: [S.UNDER_REVIEW, S.SHORTLISTED, S.IN_ROUND, S.OFFERED, S.DECLINED],
  [S.REJECTED]: [S.UNDER_REVIEW, S.REJECTED],
  [S.WITHDRAWN]: [S.WITHDRAWN],
};

/** Took the offer. One of these per student per drive, and no more. */
const TOOK_IT = new Set<S>([S.ACCEPTED, S.HIRED]);
/** Sat in a round, so there is a round result to show. */
const SAT_A_ROUND = new Set<S>([S.IN_ROUND, S.OFFERED, S.ACCEPTED, S.DECLINED, S.HIRED]);

/* -------------------------------------------------------------------------- */
/* The build                                                                   */
/* -------------------------------------------------------------------------- */

export async function seedDepth(passwordHash: string): Promise<SeededLogin[]> {
  const logins: SeededLogin[] = [];

  /* --- what seed.ts already built ---------------------------------------- */
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'sppu' } });
  const pict = await prisma.college.findFirstOrThrow({ where: { code: 'PICT' } });
  const vit = await prisma.college.findFirstOrThrow({ where: { code: 'VIT-PUNE' } });
  const skills = await prisma.skill.findMany({ select: { id: true } });

  const tpo = await prisma.user.findFirstOrThrow({
    where: { email: 'tpo@pict.demo-college.example' },
  });
  const tpo2 = await prisma.user.findFirstOrThrow({
    where: { email: 'tpo@vit.demo-college.example' },
  });

  const finals = await prisma.placement.findFirstOrThrow({
    where: { collegeId: pict.id, name: '2026 Final Placements' },
  });
  const interns = await prisma.placement.findFirstOrThrow({
    where: { collegeId: pict.id, name: '2026 Summer Internships' },
  });
  const vitDrive = await prisma.placement.findFirstOrThrow({
    where: { collegeId: vit.id, name: '2026 Final Placements' },
  });

  const industry = async (name: string) =>
    (await prisma.industry.findUniqueOrThrow({ where: { name }, select: { id: true } })).id;

  const roleId = async (key: string) =>
    (await prisma.platformRole.findUniqueOrThrow({ where: { key }, select: { id: true } })).id;
  const ownerRole = await roleId('company.owner');
  const recruiterRole = await roleId('company.recruiter');
  const officerRole = await roleId('campus.officer');

  /* --- batches ------------------------------------------------------------ */
  console.log('Depth: batches…');

  const mkBatch = (
    collegeId: string,
    name: string,
    course: string,
    specialisation: string,
    graduationYear: number,
    headOfDept: string,
  ) =>
    prisma.batch.create({
      data: {
        id: nid('b'),
        collegeId,
        tenantId: tenant.id,
        name,
        course,
        specialisation,
        graduationYear,
        headOfDept,
      },
    });

  const pictCse = await prisma.batch.findFirstOrThrow({
    where: { collegeId: pict.id, name: 'CSE 2026' },
  });
  const pictIt = await prisma.batch.findFirstOrThrow({
    where: { collegeId: pict.id, name: 'IT 2026' },
  });
  const pictEntc = await mkBatch(
    pict.id, 'ENTC 2026', 'B.Tech', 'Electronics and Telecommunication', 2026, 'Dr. R. Apte',
  );
  const pictCse25 = await mkBatch(
    pict.id, 'CSE 2025', 'B.Tech', 'Computer Science', 2025, 'Dr. S. Deshmukh',
  );
  const vitCse = await mkBatch(
    vit.id, 'CSE 2026', 'B.Tech', 'Computer Science', 2026, 'Dr. A. Gokhale',
  );
  const vitMech = await mkBatch(
    vit.id, 'MECH 2026', 'B.Tech', 'Mechanical Engineering', 2026, 'Dr. P. Kale',
  );

  // The drives the new batches belong to.
  await prisma.placement.update({
    where: { id: finals.id },
    data: { batches: { connect: [{ id: pictEntc.id }] } },
  });
  await prisma.placement.update({
    where: { id: interns.id },
    data: { batches: { connect: [{ id: pictIt.id }, { id: pictEntc.id }] } },
  });
  await prisma.placement.update({
    where: { id: vitDrive.id },
    data: { batches: { connect: [{ id: vitCse.id }, { id: vitMech.id }] } },
  });

  // Last season, closed. The only way a year-on-year comparison has two years.
  const lastYear = await prisma.placement.create({
    data: {
      id: nid('p'),
      collegeId: pict.id,
      name: '2025 Final Placements',
      type: PlacementType.FINAL,
      year: 2025,
      isOpen: false,
      oneOfferRule: true,
      createdAt: daysAgo(430),
      batches: { connect: [{ id: pictCse25.id }] },
    },
  });

  /* --- students ----------------------------------------------------------- */
  console.log('Depth: students…');

  const users: Prisma.UserCreateManyInput[] = [];
  const candidates: Prisma.CandidateCreateManyInput[] = [];
  const memberships: Prisma.BatchMembershipCreateManyInput[] = [];
  const educations: Prisma.EducationCreateManyInput[] = [];
  const candidateSkills: Prisma.CandidateSkillCreateManyInput[] = [];

  let serial = 20; // seed.ts used 0-13; start clear of it.

  function cohort(opts: {
    batchId: string;
    collegeId: string;
    domain: string;
    rollPrefix: string;
    course: string;
    specialisation: string;
    graduationYear: number;
    count: number;
    /** Share of the cohort the college has verified. */
    verifiedShare: number;
    cgpaRange: [number, number];
  }): Student[] {
    const out: Student[] = [];
    for (let i = 0; i < opts.count; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const [f, l] = name.toLowerCase().split(' ') as [string, string];
      const n = serial++;
      const email = `${f}.${l}.${n}@${opts.domain}`;
      const userId = nid('u');
      const candidateId = nid('c');
      const frozen = i < Math.round(opts.count * opts.verifiedShare);
      const cgpa = round2(between(opts.cgpaRange[0], opts.cgpaRange[1]));
      const backlogs = chance(0.16) ? intBetween(1, 3) : 0;

      users.push({ id: userId, email, fullName: name, passwordHash, role: Role.CANDIDATE });
      candidates.push({
        id: candidateId,
        userId,
        collegeId: opts.collegeId,
        phone: `98${String(10000000 + n).slice(0, 8)}`,
        gender: chance(0.42) ? 'Female' : 'Male',
        graduationYear: opts.graduationYear,
        course: opts.course,
        specialisation: opts.specialisation,
        headline: `Final-year ${opts.specialisation} student`,
        cgpa,
        tenthPct: round2(between(62, 97)),
        twelfthPct: round2(between(58, 95)),
        backlogs,
        activeBacklogs: backlogs > 0 && chance(0.5) ? 1 : 0,
        gapYears: chance(0.07) ? 1 : 0,
        isLateralEntry: chance(0.12),
        prn: `PRN${opts.graduationYear}${String(n).padStart(5, '0')}`,
        resumeUrl: chance(0.85) ? `https://example.com/resumes/${n}.pdf` : null,
      });
      memberships.push({
        id: nid('m'),
        batchId: opts.batchId,
        candidateId,
        // Numbered off the global serial, not off `i`: seed.ts already put
        // CS22-101 upwards into two of these batches.
        rollNo: `${opts.rollPrefix}-${String(200 + n).padStart(3, '0')}`,
        division: i % 2 === 0 ? 'A' : 'B',
        isFrozen: frozen,
        verifiedAt: frozen ? daysAgo(intBetween(60, 300)) : null,
      });
      educations.push({
        id: nid('e'),
        candidateId,
        degree: `${opts.course} ${opts.specialisation}`,
        institution: opts.collegeId === pict.id ? pict.name : vit.name,
        startYear: opts.graduationYear - 4,
        endYear: opts.graduationYear,
        cgpa,
      });
      for (const s of shuffled(skills).slice(0, intBetween(3, 6))) {
        candidateSkills.push({ candidateId, skillId: s.id });
      }

      out.push({ candidateId, userId, name, email, cgpa, frozen });
    }
    return out;
  }

  const cseCohort = cohort({
    batchId: pictCse.id, collegeId: pict.id, domain: 'pict.demo-college.example',
    rollPrefix: 'CS22', course: 'B.Tech', specialisation: 'Computer Science',
    graduationYear: 2026, count: 24, verifiedShare: 0.88, cgpaRange: [6.0, 9.6],
  });
  const itCohort = cohort({
    batchId: pictIt.id, collegeId: pict.id, domain: 'pict.demo-college.example',
    rollPrefix: 'IT22', course: 'B.Tech', specialisation: 'Information Technology',
    graduationYear: 2026, count: 16, verifiedShare: 0.81, cgpaRange: [5.8, 9.2],
  });
  const entcCohort = cohort({
    batchId: pictEntc.id, collegeId: pict.id, domain: 'pict.demo-college.example',
    rollPrefix: 'EN22', course: 'B.Tech', specialisation: 'Electronics and Telecommunication',
    graduationYear: 2026, count: 14, verifiedShare: 0.71, cgpaRange: [5.6, 8.9],
  });
  const cse25Cohort = cohort({
    batchId: pictCse25.id, collegeId: pict.id, domain: 'pict.demo-college.example',
    rollPrefix: 'CS21', course: 'B.Tech', specialisation: 'Computer Science',
    graduationYear: 2025, count: 22, verifiedShare: 1, cgpaRange: [6.1, 9.5],
  });
  const vitCseCohort = cohort({
    batchId: vitCse.id, collegeId: vit.id, domain: 'vit.demo-college.example',
    rollPrefix: 'VCS22', course: 'B.Tech', specialisation: 'Computer Science',
    graduationYear: 2026, count: 18, verifiedShare: 0.83, cgpaRange: [6.0, 9.4],
  });
  const vitMechCohort = cohort({
    batchId: vitMech.id, collegeId: vit.id, domain: 'vit.demo-college.example',
    rollPrefix: 'VME22', course: 'B.Tech', specialisation: 'Mechanical Engineering',
    graduationYear: 2026, count: 12, verifiedShare: 0.75, cgpaRange: [5.5, 8.6],
  });

  await prisma.user.createMany({ data: users });
  await prisma.candidate.createMany({ data: candidates });
  await prisma.batchMembership.createMany({ data: memberships });
  await prisma.education.createMany({ data: educations });
  await prisma.candidateSkill.createMany({ data: candidateSkills, skipDuplicates: true });

  /* --- companies ---------------------------------------------------------- */
  console.log('Depth: companies…');

  async function company(opts: {
    name: string;
    legalName: string;
    industry: string;
    size: CompanySize;
    city: string;
    state: string;
    about: string;
    status: CompanyStatus;
    rejectionReason?: string;
    owner: { email: string; name: string };
    recruiter?: { email: string; name: string };
  }) {
    const c = await prisma.company.create({
      data: {
        id: nid('co'),
        name: opts.name,
        legalName: opts.legalName,
        website: `https://${opts.name.toLowerCase().replace(/[^a-z]/g, '')}.example`,
        about: opts.about,
        industryId: await industry(opts.industry),
        sizeBand: opts.size,
        foundedYear: intBetween(1998, 2022),
        city: opts.city,
        state: opts.state,
        status: opts.status,
        appliedAt: opts.status === CompanyStatus.PENDING ? daysAgo(intBetween(2, 18)) : null,
        reviewedAt: opts.status === CompanyStatus.PENDING ? null : daysAgo(intBetween(30, 300)),
        rejectionReason: opts.rejectionReason ?? null,
      },
    });

    const owner = await prisma.user.create({
      data: {
        id: nid('u'),
        email: opts.owner.email,
        fullName: opts.owner.name,
        passwordHash,
        role: Role.COMPANY,
      },
    });
    await prisma.companyMember.create({
      data: { userId: owner.id, companyId: c.id, roleId: ownerRole },
    });
    logins.push({
      email: opts.owner.email,
      role: 'Company',
      what: `${opts.name} - owner (${opts.status.toLowerCase()})`,
    });

    let recruiterId: string | null = null;
    if (opts.recruiter) {
      const r = await prisma.user.create({
        data: {
          id: nid('u'),
          email: opts.recruiter.email,
          fullName: opts.recruiter.name,
          passwordHash,
          role: Role.COMPANY,
        },
      });
      await prisma.companyMember.create({
        data: { userId: r.id, companyId: c.id, roleId: recruiterRole },
      });
      recruiterId = r.id;
      logins.push({
        email: opts.recruiter.email,
        role: 'Company',
        what: `${opts.name} - recruiter, not an owner`,
      });
    }

    return { id: c.id, name: c.name, ownerId: owner.id, recruiterId: recruiterId ?? owner.id };
  }

  const indus = await company({
    name: 'Indus Systems', legalName: 'Indus Systems Limited',
    industry: 'Information Technology', size: CompanySize.ENTERPRISE,
    city: 'Pune', state: 'Maharashtra',
    about: 'IT services and platform engineering. Hires across campuses every winter.',
    status: CompanyStatus.VERIFIED,
    owner: { email: 'hiring@indussystems.example', name: 'Latika Menon' },
    recruiter: { email: 'campus@indussystems.example', name: 'Devendra Pathak' },
  });
  const harbour = await company({
    name: 'Harbour Fintech', legalName: 'Harbour Financial Technologies Pvt Ltd',
    industry: 'Banking and Financial Services', size: CompanySize.MID,
    city: 'Mumbai', state: 'Maharashtra',
    about: 'Payments infrastructure for banks and lenders.',
    status: CompanyStatus.VERIFIED,
    owner: { email: 'hiring@harbourfintech.example', name: 'Nilesh Bhatt' },
  });
  const vertex = await company({
    name: 'Vertex Motors', legalName: 'Vertex Motors India Limited',
    industry: 'Automotive', size: CompanySize.ENTERPRISE,
    city: 'Chakan', state: 'Maharashtra',
    about: 'Electric drivetrains, built and tested in Maharashtra.',
    status: CompanyStatus.VERIFIED,
    owner: { email: 'hiring@vertexmotors.example', name: 'Shalini Rao' },
  });
  const solace = await company({
    name: 'Solace Health', legalName: 'Solace Health Sciences LLP',
    industry: 'Pharmaceuticals and Life Sciences', size: CompanySize.SMALL,
    city: 'Pune', state: 'Maharashtra',
    about: 'Clinical data management for mid-size trials.',
    status: CompanyStatus.VERIFIED,
    owner: { email: 'hiring@solacehealth.example', name: 'Imran Shaikh' },
  });
  await company({
    name: 'Greycell Consulting', legalName: 'Greycell Advisory Services Pvt Ltd',
    industry: 'Consulting', size: CompanySize.MID,
    city: 'Bengaluru', state: 'Karnataka',
    about: 'Operations consulting. Suspended pending a compliance check.',
    status: CompanyStatus.SUSPENDED,
    owner: { email: 'hiring@greycell.example', name: 'Tara Venkatesh' },
  });
  await company({
    name: 'Brightpath EdTech', legalName: 'Brightpath Learning Pvt Ltd',
    industry: 'Education and EdTech', size: CompanySize.STARTUP,
    city: 'Nagpur', state: 'Maharashtra',
    about: 'Signed up last week. Wants three interns for a content tooling team.',
    status: CompanyStatus.PENDING,
    owner: { email: 'founder@brightpath.example', name: 'Ameya Kale' },
  });
  await company({
    name: 'Orbit Retail', legalName: 'Orbit Retail Ventures',
    industry: 'E-commerce and Retail', size: CompanySize.SMALL,
    city: 'Indore', state: 'Madhya Pradesh',
    about: 'Applied and was turned down - no verifiable registration details.',
    status: CompanyStatus.REJECTED,
    rejectionReason:
      'Could not verify the registered entity. Re-apply with a GSTIN and incorporation certificate.',
    owner: { email: 'hiring@orbitretail.example', name: 'Sanjay Bhandari' },
  });

  /* --- roles -------------------------------------------------------------- */
  console.log('Depth: roles and postings…');

  async function makeJob(opts: {
    company: { id: string; name: string };
    createdById: string;
    title: string;
    description: string;
    status?: JobStatus;
    openedDaysAgo: number;
    deadlineInDays: number;
    openings?: number;
    minCgpa?: number;
    maxBacklogs?: number;
    ctcFixed?: number;
    ctcVariable?: number;
    ctcMin?: number;
    ctcMax?: number;
    stipend?: number;
    internshipMonths?: number;
    gradYears?: number[];
    rounds: [string, string][];
  }): Promise<JobHandle> {
    const id = nid('j');
    const status = opts.status ?? JobStatus.PUBLISHED;
    await prisma.job.create({
      data: {
        id,
        companyId: opts.company.id,
        createdById: opts.createdById,
        title: opts.title,
        description: opts.description,
        jobType: opts.stipend ? 'INTERNSHIP' : 'FULL_TIME',
        workMode: pick(['On-site', 'Hybrid', 'Remote']),
        location: pick(['Pune', 'Mumbai', 'Bengaluru', 'Hyderabad']),
        openings: opts.openings ?? intBetween(2, 20),
        ctcMin: opts.ctcMin ?? null,
        ctcMax: opts.ctcMax ?? null,
        ctcFixed: opts.ctcFixed ?? null,
        ctcVariable: opts.ctcVariable ?? null,
        stipendPerMonth: opts.stipend ?? null,
        internshipMonths: opts.internshipMonths ?? null,
        minCgpa: opts.minCgpa ?? null,
        maxBacklogs: opts.maxBacklogs ?? null,
        deadline: daysAhead(opts.deadlineInDays),
        status,
        publishedAt: status === JobStatus.DRAFT ? null : daysAgo(opts.openedDaysAgo),
        createdAt: daysAgo(opts.openedDaysAgo + 3),
        courses: { create: [{ course: 'B.Tech' }] },
        gradYears: { create: (opts.gradYears ?? [2026]).map((year) => ({ year })) },
      },
    });

    const roundIds: string[] = [];
    for (const [i, [name, type]] of opts.rounds.entries()) {
      const rid = nid('r');
      roundIds.push(rid);
      await prisma.round.create({
        data: { id: rid, jobId: id, order: i + 1, name, type, isElimination: true },
      });
    }
    return { id, title: opts.title, roundIds, companyName: opts.company.name };
  }

  const posting = (
    jobId: string,
    placementId: string,
    status: PostingStatus,
    decidedBy: string | null,
    daysBack: number,
  ) =>
    prisma.jobPosting.create({
      data: {
        id: nid('jp'),
        jobId,
        placementId,
        status,
        decidedById: status === PostingStatus.PENDING ? null : decidedBy,
        decidedAt: status === PostingStatus.PENDING ? null : daysAgo(daysBack),
        declineReason:
          status === PostingStatus.DECLINED
            ? 'Clashes with a drive already booked for that week.'
            : null,
        createdAt: daysAgo(daysBack + 4),
      },
    });

  const TECH_ROUNDS: [string, string][] = [
    ['Resume screen', 'RESUME_SCREEN'],
    ['Online test', 'MCQ_TEST'],
    ['Technical interview', 'LIVE_INTERVIEW'],
    ['HR round', 'LIVE_INTERVIEW'],
  ];
  const SHORT_ROUNDS: [string, string][] = [
    ['Resume screen', 'RESUME_SCREEN'],
    ['Interview', 'LIVE_INTERVIEW'],
  ];

  // --- Indus Systems: the volume recruiter --------------------------------
  const indusSde = await makeJob({
    company: indus, createdById: indus.recruiterId,
    title: 'Graduate Engineer Trainee',
    description:
      'Our largest campus intake. Backend, platform and QA tracks after a twelve-week academy.',
    openedDaysAgo: 210, deadlineInDays: 12, openings: 40,
    minCgpa: 6.0, maxBacklogs: 2,
    ctcFixed: 620000, ctcVariable: 80000, ctcMin: 620000, ctcMax: 700000,
    rounds: TECH_ROUNDS,
  });
  const indusData = await makeJob({
    company: indus, createdById: indus.ownerId,
    title: 'Data Engineer',
    description: 'Pipelines and warehousing for the analytics practice.',
    openedDaysAgo: 150, deadlineInDays: 20, openings: 8,
    minCgpa: 7.0,
    ctcFixed: 950000, ctcVariable: 150000, ctcMin: 950000, ctcMax: 1250000,
    rounds: TECH_ROUNDS,
  });
  const indusIntern = await makeJob({
    company: indus, createdById: indus.recruiterId,
    title: 'Summer Intern - Platform',
    description: 'Eight weeks on the platform team, with a pre-placement offer for the strongest.',
    openedDaysAgo: 120, deadlineInDays: 25, openings: 15,
    stipend: 35000, internshipMonths: 2, minCgpa: 6.5,
    rounds: SHORT_ROUNDS,
  });
  const indusClosed = await makeJob({
    company: indus, createdById: indus.ownerId,
    title: 'Systems Engineer (2025 intake)',
    description: 'Last season’s intake. Closed once every seat was filled.',
    status: JobStatus.CLOSED,
    openedDaysAgo: 400, deadlineInDays: -300, openings: 25,
    minCgpa: 6.0,
    ctcFixed: 560000, ctcMin: 560000, ctcMax: 640000,
    gradYears: [2025],
    rounds: TECH_ROUNDS,
  });

  // --- Harbour Fintech ----------------------------------------------------
  const harbourSde = await makeJob({
    company: harbour, createdById: harbour.ownerId,
    title: 'Backend Engineer - Payments',
    description: 'Ledgers, reconciliation and the settlement path. Go and Postgres.',
    openedDaysAgo: 95, deadlineInDays: 18, openings: 6,
    minCgpa: 7.5,
    ctcFixed: 1400000, ctcVariable: 300000, ctcMin: 1400000, ctcMax: 1900000,
    rounds: TECH_ROUNDS,
  });
  const harbourRisk = await makeJob({
    company: harbour, createdById: harbour.ownerId,
    title: 'Risk Analyst',
    description: 'Fraud patterns and merchant underwriting.',
    openedDaysAgo: 70, deadlineInDays: 22, openings: 4,
    minCgpa: 7.0,
    ctcFixed: 900000, ctcMin: 900000, ctcMax: 1100000,
    rounds: SHORT_ROUNDS,
  });
  await makeJob({
    company: harbour, createdById: harbour.ownerId,
    title: 'Mobile Engineer',
    description: 'Still being written up - no rounds decided yet.',
    status: JobStatus.DRAFT,
    openedDaysAgo: 6, deadlineInDays: 45,
    rounds: [['Resume screen', 'RESUME_SCREEN']],
  });

  // --- Vertex Motors ------------------------------------------------------
  const vertexDesign = await makeJob({
    company: vertex, createdById: vertex.ownerId,
    title: 'Design Engineer - Drivetrain',
    description: 'CAD, tolerance stacks and test rigs for the motor assembly.',
    openedDaysAgo: 130, deadlineInDays: 15, openings: 12,
    minCgpa: 6.5,
    ctcFixed: 680000, ctcMin: 680000, ctcMax: 780000,
    rounds: SHORT_ROUNDS,
  });
  const vertexEmbedded = await makeJob({
    company: vertex, createdById: vertex.ownerId,
    title: 'Embedded Software Engineer',
    description: 'Firmware for the battery management system.',
    openedDaysAgo: 105, deadlineInDays: 28, openings: 6,
    minCgpa: 7.0,
    ctcFixed: 850000, ctcVariable: 100000, ctcMin: 850000, ctcMax: 1050000,
    rounds: TECH_ROUNDS,
  });

  // --- Solace Health ------------------------------------------------------
  const solaceAnalyst = await makeJob({
    company: solace, createdById: solace.ownerId,
    title: 'Clinical Data Associate',
    description: 'Cleaning and coding trial data to a deadline that does not move.',
    openedDaysAgo: 60, deadlineInDays: 30, openings: 5,
    minCgpa: 6.0,
    ctcFixed: 520000, ctcMin: 520000, ctcMax: 600000,
    rounds: SHORT_ROUNDS,
  });
  const solaceIntern = await makeJob({
    company: solace, createdById: solace.ownerId,
    title: 'Research Intern',
    description: 'Three months alongside the biostatistics team.',
    openedDaysAgo: 80, deadlineInDays: 16, openings: 4,
    stipend: 18000, internshipMonths: 3,
    rounds: SHORT_ROUNDS,
  });

  /* --- who each college let in -------------------------------------------- */
  await posting(indusSde.id, finals.id, PostingStatus.ACCEPTED, tpo.id, 200);
  await posting(indusData.id, finals.id, PostingStatus.ACCEPTED, tpo.id, 145);
  await posting(indusIntern.id, interns.id, PostingStatus.ACCEPTED, tpo.id, 115);
  await posting(indusClosed.id, lastYear.id, PostingStatus.ACCEPTED, tpo.id, 395);
  await posting(indusSde.id, vitDrive.id, PostingStatus.ACCEPTED, tpo2.id, 190);

  await posting(harbourSde.id, finals.id, PostingStatus.ACCEPTED, tpo.id, 90);
  await posting(harbourRisk.id, finals.id, PostingStatus.PENDING, null, 6);
  await posting(harbourSde.id, vitDrive.id, PostingStatus.DECLINED, tpo2.id, 80);

  await posting(vertexDesign.id, finals.id, PostingStatus.ACCEPTED, tpo.id, 125);
  await posting(vertexDesign.id, vitDrive.id, PostingStatus.ACCEPTED, tpo2.id, 120);
  await posting(vertexEmbedded.id, finals.id, PostingStatus.ACCEPTED, tpo.id, 100);

  await posting(solaceAnalyst.id, finals.id, PostingStatus.ACCEPTED, tpo.id, 55);
  await posting(solaceIntern.id, interns.id, PostingStatus.ACCEPTED, tpo.id, 75);
  await posting(solaceAnalyst.id, vitDrive.id, PostingStatus.PENDING, null, 9);

  /* --- applications ------------------------------------------------------- */
  console.log('Depth: applications…');

  const apps: Prisma.ApplicationCreateManyInput[] = [];
  const events: Prisma.StatusEventCreateManyInput[] = [];
  const results: Prisma.RoundResultCreateManyInput[] = [];
  /** One accepted offer per student per drive, enforced as the product does. */
  const placedIn = new Map<string, Set<string>>();
  const currentRound = new Map<string, string>();
  /** The unique key the schema holds: a student applies to a role once. */
  const alreadyApplied = new Set<string>();

  function applyMany(opts: {
    job: JobHandle;
    placementId: string;
    oneOfferRule: boolean;
    pool: Student[];
    spread: Array<[S, number]>;
    actorId: string;
    openedDaysAgo: number;
  }) {
    const placed = placedIn.get(opts.placementId) ?? new Set<string>();
    placedIn.set(opts.placementId, placed);

    const eligible = shuffled(opts.pool.filter((s) => s.frozen));
    let cursor = 0;

    for (const [wanted, count] of opts.spread) {
      for (let i = 0; i < count; i++) {
        let student: Student | undefined;
        while ((student = eligible[cursor++])) {
          if (!alreadyApplied.has(`${student.candidateId}:${opts.job.id}`)) break;
        }
        if (!student) return; // cohort exhausted; nothing worth forcing
        alreadyApplied.add(`${student.candidateId}:${opts.job.id}`);

        // The one-offer rule, written into history rather than applied after.
        let status = wanted;
        let reason: string | null = null;
        if (opts.oneOfferRule && placed.has(student.candidateId)) {
          status = S.WITHDRAWN;
          reason = 'auto_placed';
        } else if (TOOK_IT.has(wanted)) {
          placed.add(student.candidateId);
        }

        const appId = nid('a');
        const appliedAt = daysAgo(Math.max(1, opts.openedDaysAgo - intBetween(0, 14)));
        apps.push({
          id: appId,
          candidateId: student.candidateId,
          jobId: opts.job.id,
          placementId: opts.placementId,
          status,
          appliedAt,
          acceptedTermsAt: appliedAt,
          resumeUrl: `https://example.com/resumes/${student.email.split('@')[0]}.pdf`,
        });
        events.push({
          id: nid('ev'),
          applicationId: appId,
          toStatus: S.APPLIED,
          reason: 'applied',
          actorId: null,
          createdAt: appliedAt,
        });

        let from: S = S.APPLIED;
        let at = appliedAt.getTime();
        for (const next of CHAIN[status]) {
          at = Math.min(at + intBetween(2, 9) * DAY, Date.now() - DAY);
          events.push({
            id: nid('ev'),
            applicationId: appId,
            fromStatus: from,
            toStatus: next,
            actorId: opts.actorId,
            reason: next === S.WITHDRAWN ? reason : null,
            note:
              next === S.WITHDRAWN && reason === 'auto_placed'
                ? 'Closed automatically: the student accepted an offer in this drive.'
                : null,
            createdAt: new Date(at),
          });
          from = next;
        }

        // A round somebody actually sat, so the recruiter's view is not empty.
        if (SAT_A_ROUND.has(status) && opts.job.roundIds[0]) {
          results.push({
            id: nid('rr'),
            applicationId: appId,
            roundId: opts.job.roundIds[0]!,
            outcome: RoundOutcome.PASSED,
            score: intBetween(62, 96),
            feedback: pick([
              'Strong fundamentals, clear explanations.',
              'Good problem decomposition, a little slow on SQL.',
              'Confident on systems, thin on testing.',
              'Solid all round.',
            ]),
            evaluatedById: opts.actorId,
            evaluatedAt: new Date(at),
          });
          if (status === S.IN_ROUND && opts.job.roundIds[1]) {
            results.push({
              id: nid('rr'),
              applicationId: appId,
              roundId: opts.job.roundIds[1]!,
              outcome: RoundOutcome.PENDING,
            });
            currentRound.set(appId, opts.job.roundIds[1]!);
          }
        }
      }
    }
  }

  const pictFinalPool = [...cseCohort, ...itCohort, ...entcCohort];

  // The big intake: wide at the top, narrow at the bottom, like a real funnel.
  applyMany({
    job: indusSde, placementId: finals.id, oneOfferRule: true,
    pool: pictFinalPool, actorId: indus.recruiterId, openedDaysAgo: 200,
    spread: [
      [S.HIRED, 5], [S.ACCEPTED, 4], [S.OFFERED, 3], [S.DECLINED, 2],
      [S.IN_ROUND, 5], [S.SHORTLISTED, 4], [S.WAITLISTED, 3],
      [S.UNDER_REVIEW, 5], [S.APPLIED, 4], [S.REJECTED, 7],
    ],
  });
  applyMany({
    job: indusData, placementId: finals.id, oneOfferRule: true,
    pool: cseCohort, actorId: indus.ownerId, openedDaysAgo: 145,
    spread: [
      [S.ACCEPTED, 2], [S.OFFERED, 2], [S.IN_ROUND, 3],
      [S.REJECTED, 4], [S.UNDER_REVIEW, 3], [S.APPLIED, 2],
    ],
  });
  applyMany({
    job: harbourSde, placementId: finals.id, oneOfferRule: true,
    pool: [...cseCohort, ...itCohort], actorId: harbour.ownerId, openedDaysAgo: 88,
    spread: [
      [S.HIRED, 2], [S.ACCEPTED, 2], [S.OFFERED, 2], [S.IN_ROUND, 4],
      [S.WAITLISTED, 2], [S.REJECTED, 5], [S.UNDER_REVIEW, 3], [S.APPLIED, 3],
    ],
  });
  applyMany({
    job: vertexDesign, placementId: finals.id, oneOfferRule: true,
    pool: [...entcCohort, ...itCohort], actorId: vertex.ownerId, openedDaysAgo: 122,
    spread: [
      [S.ACCEPTED, 3], [S.OFFERED, 2], [S.IN_ROUND, 3],
      [S.REJECTED, 4], [S.UNDER_REVIEW, 2], [S.APPLIED, 3],
    ],
  });
  applyMany({
    job: vertexEmbedded, placementId: finals.id, oneOfferRule: true,
    pool: entcCohort, actorId: vertex.ownerId, openedDaysAgo: 98,
    spread: [[S.ACCEPTED, 2], [S.IN_ROUND, 2], [S.SHORTLISTED, 2], [S.REJECTED, 3], [S.APPLIED, 2]],
  });
  applyMany({
    job: solaceAnalyst, placementId: finals.id, oneOfferRule: true,
    pool: [...itCohort, ...entcCohort], actorId: solace.ownerId, openedDaysAgo: 55,
    spread: [
      [S.ACCEPTED, 2], [S.OFFERED, 1], [S.IN_ROUND, 2],
      [S.UNDER_REVIEW, 4], [S.APPLIED, 4], [S.REJECTED, 2],
    ],
  });

  // Internships: a student may hold more than one, so no cascade here.
  applyMany({
    job: indusIntern, placementId: interns.id, oneOfferRule: false,
    pool: [...cseCohort, ...itCohort], actorId: indus.recruiterId, openedDaysAgo: 115,
    spread: [
      [S.ACCEPTED, 5], [S.OFFERED, 3], [S.IN_ROUND, 4],
      [S.REJECTED, 5], [S.UNDER_REVIEW, 4], [S.APPLIED, 4],
    ],
  });
  applyMany({
    job: solaceIntern, placementId: interns.id, oneOfferRule: false,
    pool: [...cseCohort, ...entcCohort], actorId: solace.ownerId, openedDaysAgo: 75,
    spread: [[S.ACCEPTED, 3], [S.IN_ROUND, 2], [S.UNDER_REVIEW, 3], [S.APPLIED, 3], [S.REJECTED, 2]],
  });

  // VIT Pune, so the second placement officer has a season of their own.
  applyMany({
    job: indusSde, placementId: vitDrive.id, oneOfferRule: true,
    pool: [...vitCseCohort, ...vitMechCohort], actorId: indus.recruiterId, openedDaysAgo: 188,
    spread: [
      [S.HIRED, 3], [S.ACCEPTED, 3], [S.OFFERED, 2], [S.IN_ROUND, 3],
      [S.REJECTED, 5], [S.UNDER_REVIEW, 3], [S.APPLIED, 3],
    ],
  });
  applyMany({
    job: vertexDesign, placementId: vitDrive.id, oneOfferRule: true,
    pool: vitMechCohort, actorId: vertex.ownerId, openedDaysAgo: 118,
    spread: [[S.ACCEPTED, 3], [S.OFFERED, 1], [S.IN_ROUND, 2], [S.REJECTED, 2], [S.APPLIED, 2]],
  });

  // Last season, finished. 17 of 22 placed - something for this year to beat.
  applyMany({
    job: indusClosed, placementId: lastYear.id, oneOfferRule: true,
    pool: cse25Cohort, actorId: indus.ownerId, openedDaysAgo: 390,
    spread: [[S.HIRED, 14], [S.ACCEPTED, 3], [S.DECLINED, 1], [S.REJECTED, 3], [S.WAITLISTED, 1]],
  });

  // Insert in chunks. One statement per table would be a very long single query.
  const chunk = <T>(xs: T[], size = 500) =>
    Array.from({ length: Math.ceil(xs.length / size) }, (_, i) =>
      xs.slice(i * size, i * size + size),
    );

  for (const part of chunk(apps)) await prisma.application.createMany({ data: part });
  for (const part of chunk(events)) await prisma.statusEvent.createMany({ data: part });
  for (const part of chunk(results)) {
    await prisma.roundResult.createMany({ data: part, skipDuplicates: true });
  }

  for (const [appId, roundId] of currentRound) {
    await prisma.application.update({ where: { id: appId }, data: { currentRoundId: roundId } });
  }

  /* --- a second officer, so a team view is not a list of one -------------- */
  const coordinator = await prisma.user.create({
    data: {
      id: nid('u'),
      email: 'coordinator@pict.demo-college.example',
      fullName: 'Rupali Gokhale',
      passwordHash,
      role: Role.CAMPUS,
    },
  });
  await prisma.campusMember.create({
    data: { userId: coordinator.id, collegeId: pict.id, roleId: officerRole },
  });
  logins.push({
    email: coordinator.email,
    role: 'Campus',
    what: 'PICT - second officer on the same college',
  });

  /* --- the student logins worth handing out ------------------------------- */
  const withApps = new Set(apps.map((a) => a.candidateId as string));
  const byId = new Map(
    [...pictFinalPool, ...cse25Cohort, ...vitCseCohort, ...vitMechCohort].map((s) => [
      s.candidateId,
      s,
    ]),
  );
  const firstWith = (status: S, placementId?: string) =>
    byId.get(
      apps.find(
        (a) => a.status === status && (!placementId || a.placementId === placementId),
      )?.candidateId as string,
    );

  const add = (s: Student | undefined, what: string) => {
    if (s) logins.push({ email: s.email, role: 'Student', what });
  };
  add(firstWith(S.HIRED, finals.id), 'hired - accepted an offer, siblings auto-closed');
  add(firstWith(S.OFFERED, finals.id), 'has a live offer to accept or decline');
  add(firstWith(S.IN_ROUND, finals.id), 'mid-process, sitting in a round');
  add(firstWith(S.WAITLISTED, finals.id), 'waitlisted');
  add(firstWith(S.REJECTED, finals.id), 'rejected - the view nobody designs for');
  add(
    pictFinalPool.find((s) => s.frozen && !withApps.has(s.candidateId)),
    'verified, has applied to nothing yet',
  );
  add(
    pictFinalPool.find((s) => !s.frozen),
    'not yet verified by the college - cannot apply',
  );
  add(firstWith(S.HIRED, vitDrive.id), 'VIT Pune - hired, the other college’s drive');

  return logins;
}
