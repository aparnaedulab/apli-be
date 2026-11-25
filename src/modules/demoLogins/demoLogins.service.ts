/**
 * Builds, wipes and rebuilds the demo logins (see demoLogins.catalogue.ts).
 *
 * The pack owns one institution (slug "apli-demo"), four fictional companies
 * and every user on *.demo-logins.example. Reset deletes exactly those and
 * builds them again, so whatever somebody did while signed in as a demo login
 * - accepting an offer, passing a round, freezing a student - is undone, and
 * nothing outside the pack is touched.
 *
 * Rows are written with prisma directly, never through a service that sends
 * mail or WhatsApp: rebuilding the demo must not message anybody.
 *
 * Switched off unless DEMO_LOGINS=true, because the pack's simulations are
 * open to every student on the server - right for a demo server, wrong for a
 * live one.
 */
import {
  ApplicationStatus,
  CompanyStatus,
  InternshipOfferStatus,
  JobStatus,
  PostingStatus,
  Role,
  RunStatus,
  WorkSimulationStatus,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';
import { MODULES } from '../tenants/catalogue.js';
import { DEMO_COMPANIES, DEMO_DOMAIN, DEMO_TENANT_SLUG, SCENARIOS, emailOf, type DemoScenario } from './demoLogins.catalogue.js';

const DAY = 24 * 60 * 60 * 1000;
const FINAL_YEAR = 2027;
const FEMALE = new Set(['fresh', 'sim.changes', 'sim.certified', 'interview.round2', 'interview.cleared', 'offer.waiting', 'offer.lapsed', 'job.shortlisted', 'placed']);

export const demoPassword = () => env.DEMO_PASSWORD ?? 'ApliDemo@2026';
export const demoEnabled = () => env.DEMO_LOGINS === true;

/** What the console shows: every login with its situation. */
export async function describeDemoLogins() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: DEMO_TENANT_SLUG }, select: { id: true } });
  const emails = SCENARIOS.map(emailOf);
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true, lastLoginAt: true } });
  const seen = new Map(users.map((u) => [u.email, u]));
  return {
    enabled: demoEnabled(),
    built: !!tenant && users.length > 0,
    builtAt: (await lastBuiltAt()) ?? null,
    password: demoPassword(),
    missing: emails.filter((e) => !seen.has(e)).length,
    logins: SCENARIOS.map((s) => ({
      email: emailOf(s),
      group: s.group,
      name: s.name,
      situation: s.situation,
      tryThis: s.tryThis,
      exists: seen.has(emailOf(s)),
      lastLoginAt: seen.get(emailOf(s))?.lastLoginAt ?? null,
    })),
  };
}

/** When the pack was last built: its first company is made at that moment. */
async function lastBuiltAt() {
  const c = await prisma.company.findUnique({ where: { name: DEMO_COMPANIES.northwind }, select: { createdAt: true } });
  return c?.createdAt ?? null;
}

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

/**
 * Removes the pack, in the order the foreign keys allow: companies first
 * (their jobs, processes, invites, offers and simulations go with them), then
 * the institution's batches and colleges, the institution, and last the
 * pack's users.
 */
export async function wipeDemoPack() {
  await prisma.company.deleteMany({ where: { name: { in: Object.values(DEMO_COMPANIES) } } });

  const tenant = await prisma.tenant.findUnique({ where: { slug: DEMO_TENANT_SLUG }, select: { id: true } });
  if (tenant) {
    await prisma.batch.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.college.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  }

  // Every demo user, including anybody a demo login invited with a demo address.
  await prisma.user.deleteMany({ where: { email: { endsWith: DEMO_DOMAIN } } });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

let running = false;

/** Wipe and rebuild. One at a time: a second press while it runs is refused. */
export async function resetDemoPack() {
  if (running) throw conflict('A reset is already running. Give it a few seconds.');
  running = true;
  const started = Date.now();
  try {
    await wipeDemoPack();
    const counts = await buildDemoPack();
    return { ...counts, seconds: Math.round((Date.now() - started) / 100) / 10 };
  } finally {
    running = false;
  }
}

async function roleId(key: string) {
  const role = await prisma.platformRole.findUnique({ where: { key }, select: { id: true } });
  if (!role) throw conflict(`The role "${key}" is missing. Run "npm run sync:roles" on the server first.`);
  return role.id;
}

async function buildDemoPack() {
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * DAY - hours * 3600_000);
  const ahead = (days: number) => new Date(now + days * DAY);
  const passwordHash = await hashPassword(demoPassword());
  const by = new Map(SCENARIOS.map((s) => [`${s.box ?? ''}/${s.local}`, s]));
  const scenario = (local: string, box?: string) => by.get(`${box ?? ''}/${local}`)!;
  let phone = 0;
  const demoPhone = () => `90000${String(10001 + phone++).padStart(5, '0')}`;

  async function user(s: DemoScenario, role: Role) {
    return prisma.user.create({
      data: { email: emailOf(s), fullName: s.name, passwordHash, role, phone: demoPhone(), createdAt: ago(60) },
    });
  }

  // --- the institution ------------------------------------------------------
  const tenant = await prisma.tenant.create({
    data: {
      name: 'Apli Demo University',
      shortName: 'Demo University',
      slug: DEMO_TENANT_SLUG,
      kind: 'UNIVERSITY',
      status: 'ACTIVE',
      brandColor: '#0f766e',
      city: 'Pune',
      state: 'Maharashtra',
      website: `https://www.${DEMO_DOMAIN}`,
      supportEmail: `placements@${DEMO_DOMAIN}`,
      supportPhone: '9000000000',
      plan: 'COMPLETE',
      completedSteps: ['identity', 'academics', 'colleges', 'batches', 'features', 'people', 'review'],
      // No launch date and an old creation date, so a platform admin who signs
      // in is never placed in the demo institution ahead of a real one.
      launchedAt: null,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      modules: { create: MODULES.map((m) => ({ moduleKey: m.key, enabled: true })) },
    },
  });

  for (const [s, key] of [
    [scenario('university'), 'admin.university'],
    [scenario('auditor'), 'admin.auditor'],
  ] as const) {
    const u = await user(s, Role.ADMIN);
    await prisma.adminMember.create({ data: { userId: u.id, roleId: await roleId(key), tenantId: tenant.id } });
  }

  const eng = await prisma.college.create({
    data: { tenantId: tenant.id, name: 'Demo College of Engineering', code: 'DEMO-ENG', city: 'Pune', state: 'Maharashtra', affiliation: 'Apli Demo University', naacGrade: 'A', isVerified: true },
  });
  const com = await prisma.college.create({
    data: { tenantId: tenant.id, name: 'Demo College of Commerce', code: 'DEMO-COM', city: 'Pune', state: 'Maharashtra', affiliation: 'Apli Demo University', isVerified: true },
  });

  const tpoUsers: Record<string, string> = {};
  for (const [s, collegeId, key] of [
    [scenario('tpo', 'eng'), eng.id, 'campus.officer'],
    [scenario('coordinator', 'eng'), eng.id, 'campus.coordinator'],
    [scenario('verifier', 'eng'), eng.id, 'campus.verifier'],
    [scenario('tpo', 'com'), com.id, 'campus.officer'],
  ] as const) {
    const u = await user(s, Role.CAMPUS);
    await prisma.campusMember.create({ data: { userId: u.id, collegeId, roleId: await roleId(key) } });
    tpoUsers[`${s.box}/${s.local}`] = u.id;
  }

  // Courses the college runs, where the shared catalogue has them.
  for (const spec of ['Computer Science', 'Information Technology']) {
    const course = await prisma.course.findUnique({ where: { name: 'B.Tech' }, select: { id: true } });
    const sp = course && (await prisma.specialisation.findFirst({ where: { courseId: course.id, name: spec }, select: { id: true } }));
    if (!course || !sp) continue;
    await prisma.collegeProgram.create({ data: { collegeId: eng.id, courseId: course.id, specialisationId: sp.id, intake: 60 } });
    await prisma.tenantProgram.create({ data: { tenantId: tenant.id, courseId: course.id, specialisationId: sp.id } });
  }

  const cse = await prisma.batch.create({
    data: { collegeId: eng.id, tenantId: tenant.id, name: 'CSE 2027', course: 'B.Tech', specialisation: 'Computer Science', graduationYear: FINAL_YEAR, studyYear: 4, joinCode: 'DEMOCSE27', joinCodeEnabled: true },
  });
  const it = await prisma.batch.create({
    data: { collegeId: eng.id, tenantId: tenant.id, name: 'IT 2028', course: 'B.Tech', specialisation: 'Information Technology', graduationYear: FINAL_YEAR + 1, studyYear: 3 },
  });

  const finals = await prisma.placement.create({
    data: { collegeId: eng.id, name: 'Final Placements 2027', type: 'FINAL', year: FINAL_YEAR, isOpen: true, oneOfferRule: true, batches: { connect: [{ id: cse.id }] } },
  });
  const summer = await prisma.placement.create({
    data: { collegeId: eng.id, name: 'Summer Internships 2027', type: 'INTERNSHIP', year: FINAL_YEAR, isOpen: true, oneOfferRule: false, batches: { connect: [{ id: cse.id }, { id: it.id }] } },
  });

  // --- companies ------------------------------------------------------------
  const ownerRole = await roleId('company.owner');
  const admin = await prisma.user.findFirst({ where: { role: Role.ADMIN, adminMember: { is: { tenantId: null } } }, select: { id: true } });

  async function company(key: keyof typeof DEMO_COMPANIES, status: CompanyStatus, extra: { industry: string; city: string; about: string }) {
    const c = await prisma.company.create({
      data: {
        name: DEMO_COMPANIES[key],
        legalName: `${DEMO_COMPANIES[key].replace(' (Demo)', '')} Private Limited`,
        website: `https://www.${key}.${DEMO_DOMAIN}`,
        industryOther: extra.industry,
        sizeBand: 'MID',
        city: extra.city,
        state: 'Maharashtra',
        about: extra.about,
        headline: extra.about.split('.')[0],
        gstin: '27AAAAA0000A1Z5',
        status,
        appliedAt: ago(status === CompanyStatus.PENDING ? 1 : 90),
        reviewedAt: status === CompanyStatus.VERIFIED ? ago(85) : null,
        reviewedById: status === CompanyStatus.VERIFIED ? (admin?.id ?? null) : null,
      },
    });
    const u = await user(scenario('recruiter', key), Role.COMPANY);
    await prisma.companyMember.create({ data: { userId: u.id, companyId: c.id, roleId: ownerRole } });
    return { id: c.id, name: c.name, recruiterId: u.id };
  }

  const northwind = await company('northwind', CompanyStatus.VERIFIED, {
    industry: 'Data and analytics',
    city: 'Pune',
    about: 'A data analytics firm that helps retailers understand their customers. Fictional company for the Apli.ai demo.',
  });
  const interviewer = await user(scenario('interviewer', 'northwind'), Role.COMPANY);
  await prisma.companyMember.create({ data: { userId: interviewer.id, companyId: northwind.id, roleId: await roleId('company.interviewer') } });
  const bluefin = await company('bluefin', CompanyStatus.VERIFIED, {
    industry: 'Software',
    city: 'Pune',
    about: 'A product company building checkout software for online shops. Fictional company for the Apli.ai demo.',
  });
  await company('kestrel', CompanyStatus.PENDING, {
    industry: 'Food and beverages',
    city: 'Nashik',
    about: 'A packaged-foods maker that has just signed up. Fictional company for the Apli.ai demo.',
  });
  await company('harbor', CompanyStatus.VERIFIED, {
    industry: 'Logistics',
    city: 'Mumbai',
    about: 'A logistics company that has not created anything yet. Fictional company for the Apli.ai demo.',
  });

  // --- simulations ----------------------------------------------------------
  async function simulation(
    c: { id: string; recruiterId: string },
    slug: string,
    title: string,
    field: string,
    status: WorkSimulationStatus,
    summary: string,
    tasks: [string, string, string][],
  ) {
    const sim = await prisma.workSimulation.create({
      data: {
        slug,
        companyId: c.id,
        title,
        summary,
        about: summary,
        field,
        level: 'BEGINNER',
        hours: 3,
        skills: field === 'Data' ? ['Excel', 'Data cleaning', 'Charts'] : ['JavaScript', 'Debugging', 'Testing'],
        status,
        submittedAt: ago(status === WorkSimulationStatus.SUBMITTED ? 1 : 80),
        reviewedAt: status === WorkSimulationStatus.LIVE ? ago(78) : null,
        publishedAt: status === WorkSimulationStatus.LIVE ? ago(78) : null,
        createdById: c.recruiterId,
      },
    });
    const made = [];
    for (const [i, [t, brief, handIn]] of tasks.entries()) {
      made.push(
        await prisma.workSimulationTask.create({
          data: { simulationId: sim.id, position: i + 1, title: t, brief, handIn, minutes: 45, learn: ['Working from a real brief'], steps: ['Read the brief', 'Do the work', 'Hand it in'] },
        }),
      );
    }
    return { id: sim.id, title, slug, tasks: made };
  }

  const sales = await simulation(northwind, 'demo-northwind-sales-analysis', 'Sales Data Analysis', 'Data', WorkSimulationStatus.LIVE,
    'A retail client wants to know which products sell best and why. Clean the sales data, find the pattern and tell the client.',
    [
      ['Clean the sales data', 'Remove duplicates and fix the dates in a month of sales.', 'Your cleaned sheet.'],
      ['Find the best sellers', 'Rank products by revenue and by units sold.', 'A chart and two lines on what it shows.'],
      ['Advise the client', 'Write a short note to the client with one recommendation.', 'The note, under 200 words.'],
    ]);
  await simulation(northwind, 'demo-northwind-churn', 'Customer Churn', 'Data', WorkSimulationStatus.SUBMITTED,
    'Find out why customers of a subscription box stop ordering.',
    [['Explore the data', 'Look at a year of orders.', 'Three findings.'], ['Recommend', 'Suggest one change.', 'A short note.']]);
  const checkout = await simulation(bluefin, 'demo-bluefin-checkout-bug', 'Fix the Checkout Bug', 'Software', WorkSimulationStatus.LIVE,
    'Shoppers are charged twice when they double-click Pay. Find the bug, fix it and prove it is fixed.',
    [
      ['Reproduce the bug', 'Make the double charge happen on your machine.', 'The steps you followed.'],
      ['Fix it', 'Change the code so a double click charges once.', 'Your changed file.'],
    ]);

  // --- Northwind's interview process ------------------------------------------
  const process = await prisma.interviewProcess.create({
    data: { companyId: northwind.id, createdById: northwind.recruiterId, title: 'Data Analyst Intern - 2027', description: 'How Northwind interviews interns.', processType: 'INTERNSHIP', status: 'ACTIVE' },
  });
  const ROUNDS = [
    { order: 1, name: 'Profile and simulation review', type: 'RESUME_SCREEN', isElimination: true },
    { order: 2, name: 'Recorded video interview', type: 'VIDEO_INTERVIEW', isElimination: true },
    { order: 3, name: 'Live interview with the team', type: 'LIVE_INTERVIEW', isElimination: true },
  ];
  for (const r of ROUNDS) {
    const round = await prisma.interviewProcessRound.create({
      data: {
        processId: process.id,
        ...r,
        isOnline: true,
        durationMin: r.order === 1 ? null : r.order === 2 ? 15 : 45,
        meetingLink: r.order === 3 ? `https://meet.${DEMO_DOMAIN}/northwind-interview` : null,
        questionTimeSec: r.order === 2 ? 90 : null,
        prepTimeSec: r.order === 2 ? 30 : null,
        simulationId: r.order === 1 ? sales.id : null,
        description:
          r.order === 1 ? 'We read your profile and your Sales Data Analysis work.' : r.order === 2 ? 'Three questions, answered on video in your own time.' : 'Forty-five minutes with two people from the team.',
      },
    });
    if (r.order === 2) {
      const qs = ['Walk us through how you found the best sellers.', 'Tell us about a time you learned something quickly.', 'Why Northwind, and why this role?'];
      for (const [i, text] of qs.entries()) {
        await prisma.videoInterviewQuestion.create({ data: { roundId: round.id, order: i + 1, text, type: i === 0 ? 'technical' : 'behavioural' } });
      }
    }
  }

  // --- jobs -------------------------------------------------------------------
  async function job(
    c: { id: string; recruiterId: string },
    title: string,
    intern: boolean,
    placementId: string,
    posting: PostingStatus,
  ) {
    const L = 100000;
    const j = await prisma.job.create({
      data: {
        companyId: c.id,
        createdById: c.recruiterId,
        title,
        description: `${title} at a fictional company, for the Apli.ai demo.`,
        responsibilities: 'Work with the team on real client problems from your first week.',
        jobType: intern ? 'INTERNSHIP' : 'FULL_TIME',
        workMode: 'HYBRID',
        location: 'Pune',
        openings: intern ? 4 : 6,
        payPeriod: intern ? 'MONTHLY' : 'YEARLY',
        ctcMin: intern ? null : 6 * L,
        ctcMax: intern ? null : 8 * L,
        ctcFixed: intern ? null : 6 * L,
        ctcVariable: intern ? null : 1 * L,
        stipendPerMonth: intern ? 25000 : null,
        internshipMonths: intern ? 3 : null,
        minCgpa: 6.5,
        maxActiveBacklogs: 0,
        deadline: ahead(30),
        joiningFrom: intern ? ahead(60) : new Date('2027-07-01T00:00:00.000Z'),
        status: JobStatus.PUBLISHED,
        publishedAt: ago(10),
        employerType: 'DIRECT',
        offerLetterDays: 14,
        offerConditional: 'NO',
        noFeeDeclaredAt: ago(10),
        noFeeDeclaredById: c.recruiterId,
        rounds: {
          create: [
            { order: 1, name: 'Online test', type: 'MCQ_TEST', isElimination: true, isOnline: true, durationMin: 60 },
            { order: 2, name: 'Interview', type: 'LIVE_INTERVIEW', isElimination: false, isOnline: true, durationMin: 45 },
          ],
        },
        courses: { create: [{ course: 'B.Tech' }] },
        gradYears: { create: (intern ? [FINAL_YEAR, FINAL_YEAR + 1] : [FINAL_YEAR]).map((year) => ({ year })) },
      },
    });
    await prisma.jobPosting.create({
      data: {
        jobId: j.id,
        placementId,
        status: posting,
        decidedAt: posting === PostingStatus.PENDING ? null : ago(8),
        decidedById: posting === PostingStatus.PENDING ? null : tpoUsers['eng/tpo'],
      },
    });
    return j;
  }

  const analyst = await job(northwind, 'Graduate Data Analyst', false, finals.id, PostingStatus.ACCEPTED);
  const bizAnalyst = await job(northwind, 'Business Analyst', false, finals.id, PostingStatus.ACCEPTED);
  await job(northwind, 'Data Analyst Intern', true, summer.id, PostingStatus.ACCEPTED);
  await job(bluefin, 'Software Engineer Trainee', false, finals.id, PostingStatus.PENDING);

  // --- students ---------------------------------------------------------------
  const students: Record<string, { id: string; userId: string }> = {};
  for (const [i, s] of SCENARIOS.filter((x) => x.group === 'Student').entries()) {
    const fresh = s.local === 'new.student';
    const u = await user(s, Role.CANDIDATE);
    const c = await prisma.candidate.create({
      data: {
        userId: u.id,
        collegeId: eng.id,
        degreeLevel: 'UG',
        course: 'B.Tech',
        specialisation: fresh ? 'Information Technology' : 'Computer Science',
        graduationYear: fresh ? FINAL_YEAR + 1 : FINAL_YEAR,
        startYear: fresh ? FINAL_YEAR - 3 : FINAL_YEAR - 4,
        city: fresh ? null : 'Pune',
        phone: u.phone,
        gender: FEMALE.has(s.local) ? 'Female' : 'Male',
        interests: fresh ? ['Data'] : ['Data', 'Software'],
        cgpa: fresh ? null : (7.2 + (i % 8) * 0.2).toFixed(2),
        tenthPct: 85,
        twelfthPct: 80,
        backlogs: 0,
        activeBacklogs: 0,
        gapYears: 0,
        createdAt: ago(fresh ? 1 : 50),
      },
    });
    await prisma.batchMembership.create({
      data: { batchId: fresh ? it.id : cse.id, candidateId: c.id, isFrozen: !fresh, verifiedAt: fresh ? null : ago(40), joinedAt: ago(fresh ? 1 : 50) },
    });
    students[s.local] = { id: c.id, userId: u.id };
  }

  // --- what each student has done ---------------------------------------------
  let certNo = 0;
  async function run(local: string, sim: typeof sales, status: RunStatus, opts: { done?: number; shareWith?: string[]; days?: number } = {}) {
    const s = students[local]!;
    const days = opts.days ?? 20;
    const submitted = status !== RunStatus.ACTIVE && status !== RunStatus.LEFT;
    const reviewed = status === RunStatus.COMPLETED || status === RunStatus.NEEDS_WORK;
    const r = await prisma.workSimulationRun.create({
      data: {
        simulationId: sim.id,
        candidateId: s.id,
        status,
        startedAt: ago(days),
        lastActiveAt: ago(submitted ? Math.floor(days / 2) : 1),
        submittedAt: submitted ? ago(Math.floor(days / 2)) : null,
        explainHow: submitted ? 'I read the brief twice, listed what the client needed, then worked task by task and checked each result.' : null,
        explainChange: submitted ? 'With more time I would test my answer on a second month of data.' : null,
        reviewedAt: reviewed ? ago(Math.floor(days / 3)) : null,
        reviewedById: reviewed ? northwind.recruiterId : null,
        reviewNote:
          status === RunStatus.NEEDS_WORK
            ? 'Good start. Your note to the client needs the numbers behind the recommendation - add them and send it back.'
            : status === RunStatus.COMPLETED
              ? 'Clear, well-structured work.'
              : null,
        completedAt: status === RunStatus.COMPLETED ? ago(Math.floor(days / 3)) : null,
        certificateCode: status === RunStatus.COMPLETED ? `APLI-DLGN-${String(++certNo).padStart(4, "0")}` : null,
      },
    });
    const count = opts.done ?? (submitted ? sim.tasks.length : 1);
    for (const task of sim.tasks.slice(0, count)) {
      await prisma.workSimulationTaskDone.create({
        data: { runId: r.id, taskId: task.id, answer: `My answer to "${task.title}": done as the brief asked, with my working attached.`, doneAt: ago(Math.floor(days / 2) + 1) },
      });
    }
    for (const companyId of opts.shareWith ?? []) {
      await prisma.workSimulationShare.create({ data: { runId: r.id, companyId } });
    }
    if (status === RunStatus.COMPLETED) {
      await note(s.userId, 'SIMULATION_APPROVED', `Your work on ${sim.title} is approved`, 'Your certificate is ready to share.', '/student/certificates', ago(Math.floor(days / 3)));
    }
    if (status === RunStatus.NEEDS_WORK) {
      await note(s.userId, 'SIMULATION_CHANGES', `Changes asked on ${sim.title}`, 'Your reviewer left a note on what to fix.', `/student/simulations/${sim.slug}`, ago(1));
    }
    return r;
  }

  async function note(userId: string, type: string, title: string, body: string, link: string, at: Date) {
    await prisma.notification.create({ data: { userId, type, title, body, link, createdAt: at } });
  }

  /** An interview at Northwind, stopped at a given point. */
  async function interview(local: string, status: 'PENDING' | 'ACCEPTED' | 'OFFERED' | 'REJECTED', round: number, passed: number, failedAt?: number) {
    const s = students[local]!;
    const inv = await prisma.interviewInvite.create({
      data: {
        companyId: northwind.id,
        candidateId: s.id,
        processId: process.id,
        sentById: northwind.recruiterId,
        role: 'Data Analyst Intern',
        message: 'We liked your work on our Sales Data Analysis simulation and would like to interview you.',
        status,
        currentRoundOrder: round,
        respondedAt: status === 'PENDING' ? null : ago(6),
        createdAt: ago(8),
      },
    });
    for (const r of ROUNDS.filter((x) => x.order <= passed)) {
      await prisma.interviewRoundFeedback.create({
        data: { inviteId: inv.id, roundOrder: r.order, roundName: r.name, outcome: 'PASSED', score: 80, notes: 'Clear thinking, well prepared.' },
      });
    }
    if (failedAt) {
      const r = ROUNDS.find((x) => x.order === failedAt)!;
      await prisma.interviewRoundFeedback.create({
        data: { inviteId: inv.id, roundOrder: r.order, roundName: r.name, outcome: 'FAILED', score: 45, notes: 'Not the right fit for this role right now.' },
      });
    }
    await note(s.userId, 'INTERVIEW_INVITE', `${northwind.name} invited you to interview`, 'Data Analyst Intern', '/student/interviews', ago(8));
  }

  async function offer(local: string, runId: string, kind: 'open' | 'accepted' | 'lapsed') {
    const s = students[local]!;
    await prisma.internshipOffer.create({
      data: {
        companyId: northwind.id,
        candidateId: s.id,
        runId,
        sentById: northwind.recruiterId,
        role: 'Data Analyst Intern',
        about: 'Three months on the retail analytics team in Pune, working on the kind of data you saw in the simulation.',
        workMode: 'HYBRID',
        city: 'Pune',
        months: 3,
        stipend: 25000,
        startsOn: ahead(45),
        respondBy: kind === 'open' ? ahead(7) : kind === 'lapsed' ? ago(3) : ago(2),
        noFeeAt: ago(kind === 'open' ? 2 : 12),
        status: kind === 'accepted' ? InternshipOfferStatus.ACCEPTED : InternshipOfferStatus.SENT,
        respondedAt: kind === 'accepted' ? ago(5) : null,
        studentNote: kind === 'accepted' ? 'Thank you, I am excited to join!' : null,
        createdAt: ago(kind === 'open' ? 2 : 12),
      },
    });
    await note(s.userId, 'INTERNSHIP_OFFER', `${northwind.name} offered you an internship`, 'Data Analyst Intern, 3 months.', '/student/jobs', ago(kind === 'open' ? 2 : 12));
  }

  async function application(local: string, jobId: string, status: ApplicationStatus, days = 6) {
    await prisma.application.create({
      data: { candidateId: students[local]!.id, jobId, placementId: finals.id, status, appliedAt: ago(days), acceptedTermsAt: ago(days) },
    });
  }

  const share = [northwind.id];

  await run('sim.started', sales, RunStatus.ACTIVE, { done: 1, days: 3 });
  await run('sim.review', sales, RunStatus.IN_REVIEW, { days: 6 });
  await run('sim.changes', sales, RunStatus.NEEDS_WORK, { days: 10 });
  await run('sim.certified', sales, RunStatus.COMPLETED, { days: 25 });

  for (const [local, status, round, passed, failedAt] of [
    ['interview.invited', 'PENDING', 1, 0, undefined],
    ['interview.round1', 'ACCEPTED', 1, 0, undefined],
    ['interview.round2', 'ACCEPTED', 2, 1, undefined],
    ['interview.round3', 'ACCEPTED', 3, 2, undefined],
    ['interview.cleared', 'OFFERED', 3, 3, undefined],
    ['interview.rejected', 'REJECTED', 2, 1, 2],
  ] as const) {
    await run(local, sales, RunStatus.COMPLETED, { shareWith: share, days: 30 });
    await interview(local, status, round, passed, failedAt);
  }

  for (const [local, kind] of [
    ['offer.waiting', 'open'],
    ['offer.accepted', 'accepted'],
    ['offer.lapsed', 'lapsed'],
  ] as const) {
    const r = await run(local, sales, RunStatus.COMPLETED, { shareWith: share, days: 35 });
    await offer(local, r.id, kind);
  }

  await application('job.applied', analyst.id, ApplicationStatus.APPLIED, 2);
  await application('job.shortlisted', analyst.id, ApplicationStatus.SHORTLISTED, 7);
  await application('job.offer', analyst.id, ApplicationStatus.OFFERED, 15);
  await application('placed', analyst.id, ApplicationStatus.ACCEPTED, 20);
  await application('placed', bizAnalyst.id, ApplicationStatus.WITHDRAWN, 18);

  const busy = await run('busy', sales, RunStatus.COMPLETED, { shareWith: [northwind.id, bluefin.id], days: 40 });
  await offer('busy', busy.id, 'open');
  await interview('busy', 'ACCEPTED', 2, 1);
  await run('busy', checkout, RunStatus.ACTIVE, { done: 1, days: 4 });
  await application('busy', bizAnalyst.id, ApplicationStatus.UNDER_REVIEW, 5);

  await prisma.user.updateMany({ where: { email: { endsWith: DEMO_DOMAIN } }, data: { lastLoginAt: null } });

  return {
    logins: SCENARIOS.length,
    companies: Object.keys(DEMO_COMPANIES).length,
    students: Object.keys(students).length,
  };
}
