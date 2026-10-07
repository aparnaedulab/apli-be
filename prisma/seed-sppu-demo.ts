/**
 * Demo data for SPPU, across all nine onboarding steps.
 *
 * `seed.ts` builds SPPU with the minimum the rest of the demo needs. This
 * fills it out so every onboarding screen has something realistic to show:
 * a complete identity, a wider course list, more colleges with placement
 * officers, their mappings with seats, batches for two passing years,
 * students in those batches, the intake rules, more modules and more admins.
 *
 * It goes through the same service functions the wizard calls, so the data
 * is shaped exactly as if somebody had clicked through the screens.
 *
 * Safe to run repeatedly: anything that already exists (a college code, a
 * student email, an admin invite) is left alone, and it never deletes.
 * Every contact value is a demo value: *.example addresses, 90000 phones.
 * It sends no email: officers are created as accounts directly, and admins
 * are invited with email off (the server's mail goes to a real external API).
 *
 *   npm run db:seed:sppu
 */
import { Role } from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import {
  addCoursesInBulk,
  inviteTenantAdmin,
  markStepById,
  officerRole,
  saveAcademics,
  saveFeatures,
  updateIdentity,
} from '../src/modules/tenants/onboarding.service.js';
import { createBatchesFromMapping, createCollege } from '../src/modules/tenants/onboarding.structure.js';
import { collegePrograms, mapStudents, setCollegePrograms } from '../src/modules/mapping/mapping.service.js';
import { savePolicy } from '../src/modules/students/policy.js';

/** The same one every seeded login uses, so there is only one to remember. */
const PASSWORD = process.env.DEMO_PASSWORD ?? 'CampusHire2026';

const YEAR = new Date().getFullYear();
/** Passing years to build batches and students for. */
const PASSING = [YEAR, YEAR + 1];

// ---------------------------------------------------------------------------
// Step 2 - the catalogue SPPU picks from
// ---------------------------------------------------------------------------

/** Course → branches, by name. Branch names reuse the master list's spellings. */
const COURSES: Record<string, string[]> = {
  'B.E.': [
    'Computer Science',
    'Information Technology',
    'Electronics and Telecommunication',
    'Electrical',
    'Mechanical Engineering',
    'Civil',
  ],
  'B.Tech': ['Artificial Intelligence and Machine Learning', 'Data Science'],
  'B.Sc': ['Computer Science', 'Data Science', 'Physics', 'Chemistry', 'Mathematics'],
  BCA: [],
  BBA: [],
  'B.Com': [],
  'M.Sc': ['Computer Science', 'Data Science', 'Physics'],
  'M.Com': [],
  MBA: ['Finance', 'Marketing', 'Human Resources', 'Operations'],
  MCA: ['Computer Science', 'Data Science'],
};

// ---------------------------------------------------------------------------
// Step 3 - colleges (fictional names; demo contacts)
// ---------------------------------------------------------------------------

interface DemoCollege {
  code: string;
  name: string;
  city: string;
  pincode: string;
  naac: string;
  officer: string;
  /** What it runs: course → branches ([] = the course as a whole), with seats each. */
  runs: Record<string, string[]>;
  seats: number;
}

const COLLEGES: DemoCollege[] = [
  {
    code: 'DIET',
    name: 'Deccan Institute of Engineering and Technology',
    city: 'Pune',
    pincode: '411041',
    naac: 'A',
    officer: 'Prof. Rohan Patwardhan',
    runs: {
      'B.E.': ['Computer Science', 'Information Technology', 'Electronics and Telecommunication', 'Mechanical Engineering'],
      'M.Tech': ['Computer Science'],
    },
    seats: 120,
  },
  {
    code: 'SACS',
    name: 'Sahyadri College of Arts, Science and Commerce',
    city: 'Pune',
    pincode: '411004',
    naac: 'A+',
    officer: 'Dr. Kavita Ranade',
    runs: { 'B.Sc': ['Computer Science', 'Data Science', 'Mathematics'], 'B.Com': [], BBA: [], 'M.Com': [] },
    seats: 90,
  },
  {
    code: 'IIMR',
    name: 'Indrayani Institute of Management and Research',
    city: 'Pune',
    pincode: '411033',
    naac: 'A',
    officer: 'Dr. Sameer Gokhale',
    runs: { MBA: ['Finance', 'Marketing', 'Human Resources', 'Operations'], BBA: [] },
    seats: 60,
  },
  {
    code: 'GITN',
    name: 'Godavari Institute of Technology',
    city: 'Nashik',
    pincode: '422005',
    naac: 'B++',
    officer: 'Prof. Vaishali Bhosale',
    runs: {
      'B.E.': ['Computer Science', 'Electrical', 'Mechanical Engineering', 'Civil'],
      'B.Tech': ['Artificial Intelligence and Machine Learning'],
    },
    seats: 60,
  },
  {
    code: 'SCCA',
    name: 'Sinnar College of Computer Applications',
    city: 'Nashik',
    pincode: '422103',
    naac: 'B+',
    officer: 'Prof. Nikhil Sonawane',
    runs: { BCA: [], MCA: ['Computer Science', 'Data Science'], 'B.Sc': ['Computer Science'] },
    seats: 60,
  },
  {
    code: 'LIT',
    name: 'Lonavala Institute of Technology',
    city: 'Lonavala',
    pincode: '410401',
    naac: 'B++',
    officer: 'Dr. Prakash Jadhav',
    runs: {
      'B.Tech': ['Computer Science', 'Information Technology', 'Data Science'],
      'B.E.': ['Electronics and Telecommunication'],
    },
    seats: 60,
  },
  {
    code: 'SCCM',
    name: 'Shivneri College of Commerce and Management',
    city: 'Junnar',
    pincode: '410502',
    naac: 'B+',
    officer: 'Dr. Smita Kale',
    runs: { 'B.Com': [], BBA: [], 'M.Com': [], MBA: ['Finance', 'Marketing'] },
    seats: 60,
  },
  {
    code: 'CIIT',
    name: 'Chakan Institute of Information Technology',
    city: 'Chakan',
    pincode: '410501',
    naac: 'B++',
    officer: 'Prof. Aditya Shinde',
    runs: { 'B.Tech': ['Computer Science', 'Information Technology'], MCA: ['Computer Science'] },
    seats: 60,
  },
];

// ---------------------------------------------------------------------------
// Step 6 - students
// ---------------------------------------------------------------------------

const FIRST = [
  'Aarav', 'Ananya', 'Vihaan', 'Isha', 'Arjun', 'Diya', 'Kabir', 'Sneha', 'Rohan', 'Pooja',
  'Aditya', 'Shruti', 'Omkar', 'Neha', 'Siddharth', 'Rutuja', 'Pranav', 'Sakshi', 'Tejas', 'Mrunal',
  'Yash', 'Gauri', 'Atharva', 'Prachi', 'Harsh', 'Vaishnavi', 'Soham', 'Tanvi', 'Ninad', 'Aditi',
];
const LAST = [
  'Kulkarni', 'Deshpande', 'Patil', 'Joshi', 'Pawar', 'Shinde', 'Gaikwad', 'Jadhav', 'More', 'Bhosale',
  'Chavan', 'Kale', 'Gokhale', 'Phadke', 'Sawant', 'Naik', 'Mane', 'Salunkhe', 'Thorat', 'Wagh',
];

/** Students per programme per passing year. */
const PER_PROGRAMME = 4;

/** Deterministic "random", so a re-run makes the same people. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rand = seeded(2026);
const between = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---------------------------------------------------------------------------

let hashed: string | null = null;
/** One hash of the demo password, shared by every account this script makes. */
async function officerHash() {
  hashed ??= await hashPassword(PASSWORD);
  return hashed;
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'sppu' } });
  const id = tenant.id;

  // Somebody from the platform team, as the person "doing" the onboarding.
  const actor = await prisma.adminMember.findFirst({ where: { tenantId: null }, select: { userId: true } });
  if (!actor) throw new Error('No platform admin exists to act as. Run the main seed first.');
  const userId = actor.userId;

  // --- 1. identity ----------------------------------------------------------
  console.log('1. Identity…');
  await updateIdentity(id, {
    name: tenant.name,
    shortName: tenant.shortName ?? 'SPPU',
    slug: tenant.slug,
    kind: tenant.kind,
    legalName: tenant.legalName ?? 'Savitribai Phule Pune University (demo record)',
    website: tenant.website ?? 'https://www.demo-university.example',
    logoUrl: tenant.logoUrl ?? '',
    faviconUrl: tenant.faviconUrl ?? '',
    brandColor: tenant.brandColor ?? '#1d3b8b',
    tagline: tenant.tagline ?? 'Placements across every affiliated college, in one place',
    city: tenant.city ?? 'Pune',
    state: tenant.state ?? 'Maharashtra',
    address: tenant.address ?? 'Main Building, University Campus',
    pincode: tenant.pincode ?? '411007',
    contactName: tenant.contactName ?? 'Dr. Asha Kulkarni',
    contactEmail: tenant.contactEmail ?? 'registrar@demo-university.example',
    contactPhone: tenant.contactPhone ?? '+91 90000 10001',
    supportEmail: tenant.supportEmail ?? 'placements@demo-university.example',
    supportPhone: tenant.supportPhone ?? '+91 90000 10002',
    supportAltPhone: tenant.supportAltPhone ?? '+91 90000 10003',
    supportWhatsapp: tenant.supportWhatsapp ?? '+91 90000 10004',
    officeHours: tenant.officeHours ?? 'Mon–Sat, 10:00–17:30',
  });

  // --- 2. academics ---------------------------------------------------------
  console.log('2. Courses and branches…');
  const bulk = await addCoursesInBulk({
    rows: Object.entries(COURSES).map(([course, branches]) => ({ course, branches })),
    addMissingBranches: true,
    preview: false,
  });
  console.log('   catalogue:', JSON.stringify(bulk).slice(0, 200));

  const catalogue = await prisma.course.findMany({
    select: { id: true, name: true, specialisations: { select: { id: true, branch: { select: { name: true } } } } },
  });
  const courseByName = new Map(catalogue.map((c) => [c.name, c]));

  // One row per course and branch; a row with no branch is the whole course.
  const current = await prisma.tenantProgram.findMany({
    where: { tenantId: id },
    select: { courseId: true, specialisationId: true },
  });
  const programs = new Map<string, string[]>();
  for (const p of current) {
    const list = programs.get(p.courseId) ?? [];
    if (p.specialisationId) list.push(p.specialisationId);
    programs.set(p.courseId, list);
  }
  // Every demo course, with all its branches (an empty list means all of them).
  for (const name of Object.keys(COURSES)) {
    const c = courseByName.get(name);
    if (c) programs.set(c.id, []);
  }
  await saveAcademics(id, {
    oneOfferDefault: tenant.oneOfferDefault,
    allowSelfJoin: tenant.allowSelfJoin,
    responseDays: tenant.responseDays ?? 7,
    companyApprovalRequired: tenant.companyApprovalRequired,
    unverifiedCompanyAccess: tenant.unverifiedCompanyAccess,
    programs: [...programs].map(([courseId, specialisationIds]) => ({ courseId, specialisationIds })),
  });

  // --- 3. colleges ----------------------------------------------------------
  console.log('3. Colleges…');
  const colleges: { id: string; demo: DemoCollege }[] = [];
  for (const demo of COLLEGES) {
    const existing = await prisma.college.findFirst({ where: { code: demo.code }, select: { id: true, tenantId: true } });
    if (existing) {
      if (existing.tenantId !== id) {
        console.log(`   ${demo.code} belongs to another institution - skipped`);
        continue;
      }
      colleges.push({ id: existing.id, demo });
      continue;
    }
    const { college } = await createCollege(
      id,
      {
        name: demo.name,
        code: demo.code,
        collegeTypeId: '',
        affiliation: 'THIS_UNIVERSITY',
        affiliationName: '',
        city: demo.city,
        state: 'Maharashtra',
        address: `${demo.name} campus, ${demo.city}`,
        pincode: demo.pincode,
        naacGrade: demo.naac,
        isVerified: true,
        // No officer here: that path emails an invite, and mail goes to a
        // real external service. The officer is made directly below instead.
        officerName: '',
        officerEmail: '',
      },
      userId,
    );
    colleges.push({ id: college.id, demo });

    // The placement officer, as an active account - no invite, no email.
    const officerEmail = `tpo@${slug(demo.code)}.demo-college.example`;
    const officer =
      (await prisma.user.findUnique({ where: { email: officerEmail } })) ??
      (await prisma.user.create({
        data: { email: officerEmail, fullName: demo.officer, passwordHash: await officerHash(), role: Role.CAMPUS },
      }));
    await prisma.campusMember.create({
      data: { userId: officer.id, collegeId: college.id, roleId: (await officerRole()).id },
    });
    console.log(`   + ${demo.code}`);
  }

  // --- 4. mapping -----------------------------------------------------------
  console.log('4. Mapping courses to colleges…');
  for (const { id: collegeId, demo } of colleges) {
    const have = await collegePrograms(collegeId);
    const choices = new Map(
      have.map((p) => [`${p.courseId}|${p.branchId ?? ''}`, { courseId: p.courseId, branchId: p.branchId, intake: p.intake }]),
    );
    for (const [courseName, branches] of Object.entries(demo.runs)) {
      const course = courseByName.get(courseName);
      if (!course) continue;
      if (branches.length === 0) {
        choices.set(`${course.id}|`, { courseId: course.id, branchId: null, intake: demo.seats });
        continue;
      }
      for (const b of branches) {
        const spec = course.specialisations.find((s) => s.branch.name === b);
        if (!spec) {
          console.log(`   ${demo.code}: ${courseName} has no ${b} - skipped`);
          continue;
        }
        choices.set(`${course.id}|${spec.id}`, { courseId: course.id, branchId: spec.id, intake: demo.seats });
      }
    }
    await setCollegePrograms(id, collegeId, [...choices.values()]);
  }
  await markStepById(id, 'mapping');

  // --- 5. batches -----------------------------------------------------------
  console.log('5. Batches from the mapping…');
  const made = await createBatchesFromMapping(id, {
    graduationYears: PASSING,
    collegeIds: colleges.map((c) => c.id),
  });
  console.log(`   created ${made.created.length}, ${made.skipped.length} already existed`);

  // --- 6. students ----------------------------------------------------------
  console.log('6. Intake rules and students…');
  await savePolicy(id, {
    fields: { prn: 'required', programme: 'required', cgpa: 'required', dateOfBirth: 'off' },
    universityMayAdd: true,
    collegeMayAdd: true,
    selfRegister: true,
    selfFields: ['phone', 'programme', 'prn', 'rollNo', 'cgpa', 'tenthPct', 'twelfthPct'],
    selfNeedsApproval: true,
  });
  await markStepById(id, 'students');

  const passwordHash = await officerHash();
  // Phones and PRNs carry on from wherever a previous run stopped.
  let serial = 20000 + (await prisma.user.count({ where: { email: { contains: '.demo-college.example' } } }));
  let added = 0;

  for (const { id: collegeId, demo } of colleges) {
    const progs = await prisma.collegeProgram.findMany({
      where: { collegeId },
      select: { id: true, course: { select: { name: true } }, specialisation: { select: { name: true } } },
    });

    for (const p of progs) {
      for (const year of PASSING) {
        const ids: string[] = [];
        for (let i = 0; i < PER_PROGRAMME; i++) {
          const key = `${slug(demo.code)}.${slug(p.course.name)}${p.specialisation ? '.' + slug(p.specialisation.name) : ''}.${year}.${i}`;
          const email = `${key}@${slug(demo.code)}.demo-college.example`;
          if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) continue;

          const first = FIRST[Math.floor(rand() * FIRST.length)]!;
          const last = LAST[Math.floor(rand() * LAST.length)]!;
          serial++;
          const user = await prisma.user.create({
            data: { email, fullName: `${first} ${last}`, passwordHash, role: Role.CANDIDATE },
          });
          const candidate = await prisma.candidate.create({
            data: {
              userId: user.id,
              collegeId,
              phone: `90000${String(serial).padStart(5, '0')}`,
              prn: `DEMO${YEAR}${String(serial).padStart(6, '0')}`,
              graduationYear: year,
              headline: year === YEAR ? 'Final-year student looking for a first role' : 'Pre-final-year student',
              cgpa: between(6.2, 9.6),
              tenthPct: between(68, 97),
              twelfthPct: between(62, 95),
              backlogs: rand() < 0.1 ? 1 : 0,
            },
          });
          ids.push(candidate.id);
        }
        if (ids.length === 0) continue;

        // Through the mapping, so each lands in its own batch the way the
        // wizard would put them there.
        await mapStudents(id, p.id, ids);

        // Roll numbers, and most of them verified by the college.
        const memberships = await prisma.batchMembership.findMany({
          where: { candidateId: { in: ids }, batch: { collegeId, graduationYear: year } },
          select: { id: true, batchId: true },
        });
        for (const [n, m] of memberships.entries()) {
          const verified = n < memberships.length - 1;
          await prisma.batchMembership.update({
            where: { id: m.id },
            data: {
              rollNo: `${demo.code}-${String(year).slice(2)}-${m.batchId.slice(-4).toUpperCase()}-${String(n + 1).padStart(3, '0')}`,
              isFrozen: verified,
              verifiedAt: verified ? new Date() : null,
            },
          });
        }
        added += ids.length;
      }
    }
  }
  console.log(`   ${added} students added`);

  // --- 7. features ----------------------------------------------------------
  console.log('7. Features…');
  const on = await prisma.tenantModule.findMany({ where: { tenantId: id, enabled: true }, select: { moduleKey: true } });
  const features = await saveFeatures(id, [
    ...new Set([
      ...on.map((m) => m.moduleKey),
      'trust.offerCard',
      'trust.tracker',
      'trust.whyNot',
      'compliance.reports',
      'dev.readiness',
      'dev.mockInterview',
      'ops.atRisk',
    ]),
  ]);
  console.log(`   ${features.enabled.length} modules on (${features.plan})`);

  // --- 8. people ------------------------------------------------------------
  console.log('8. People…');
  const people = [
    { fullName: 'Dr. Neelima Apte', email: 'director.placements@demo-university.example', phone: '+91 90000 10011' },
    { fullName: 'Mr. Kunal Sathe', email: 'placement.desk@demo-university.example', phone: '+91 90000 10012' },
  ];
  for (const p of people) {
    const member = await prisma.adminMember.findFirst({ where: { tenantId: id, user: { email: p.email } } });
    const invited = await prisma.invite.findFirst({
      where: { email: p.email, tenantId: id, acceptedAt: null, revokedAt: null },
      select: { id: true },
    });
    if (member || invited) continue;
    // No email: the invite link is shown in the wizard instead.
    await inviteTenantAdmin(id, { ...p, sendEmail: false }, userId);
    console.log(`   + ${p.fullName}`);
  }

  // --- 9. review ------------------------------------------------------------
  // SPPU is already live; every step it has is now marked done.
  for (const step of ['identity', 'academics', 'colleges', 'mapping', 'batches', 'students', 'features', 'people'] as const) {
    await markStepById(id, step);
  }
  console.log('9. Done - SPPU is live with every step complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
