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
  PostingStatus,
  Role,
  RoundOutcome,
  RoleScope,
} from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { SYSTEM_ROLES } from '../src/modules/roles/permissions.js';
import { CORE_KEYS } from '../src/modules/tenants/catalogue.js';
import { seedAptitude } from '../src/scripts/seedAptitude.js';
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

    await prisma.education.create({
      data: {
        candidateId: candidate.id,
        degree: 'B.Tech Computer Science',
        institution: rait.name,
        startYear: 2022,
        endYear: 2026,
        cgpa: candidate.cgpa,
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
