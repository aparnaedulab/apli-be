/**
 * Demo jobs for SPPU's newer colleges, posted the way people would post them.
 *
 * Nothing here writes to the database directly. It signs in over the HTTP API
 * and clicks through the same steps a person would:
 *
 *   1. each college's placement officer opens a placement drive,
 *   2. each company creates a role, adds its rounds, confirms it charges no
 *      fee, sends it to the colleges whose courses fit, and publishes it,
 *   3. each officer approves the roles sent to their college.
 *
 * Run it against a server whose mail and WhatsApp are switched off, since
 * publishing and approving notify people:
 *
 *   PORT=4100 EMAIL_SNS_URL= EMAIL_SNS_TOKEN= WHATSAPP_TOKEN= SMTP_HOST= SMTP_URL= npx tsx src/index.ts
 *   API=http://localhost:4100/api npx tsx prisma/demo-jobs-flow.ts
 *
 * Safe to re-run: a drive or a role that already exists is reused, not
 * duplicated. Every login is a demo account; the password is the demo one.
 */

const API = process.env.API ?? 'http://localhost:4100/api';
const ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5180';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'CampusHire2026';

const YEAR = new Date().getFullYear();
const DRIVE = `${YEAR}-${String(YEAR + 1).slice(2)} Campus Placements`;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const COLLEGES = ['DIET', 'SACS', 'IIMR', 'GITN', 'SCCA', 'LIT', 'SCCM', 'CIIT'];
const officerOf = (code: string) => `tpo@${code.toLowerCase()}.demo-college.example`;

interface DemoJob {
  company: string; // the owner's login
  title: string;
  description: string;
  location: string;
  workMode: 'ONSITE' | 'HYBRID' | 'REMOTE';
  ctcMin: number;
  ctcMax: number;
  openings: number;
  closesIn: number; // days
  minCgpa?: number;
  courses: string[];
  branches: string[]; // [] = any branch of those courses
  colleges: string[];
  rounds: { name: string; type: string; mode: string }[];
}

const JOBS: DemoJob[] = [
  {
    company: 'hiring@zenithlabs.example',
    title: 'Software Engineer',
    description:
      'Build and ship features on our core product with a small team. You will write production code from your first month, with a mentor reviewing every change.',
    location: 'Pune',
    workMode: 'HYBRID',
    ctcMin: 600000,
    ctcMax: 800000,
    openings: 12,
    closesIn: 12,
    minCgpa: 6.5,
    courses: ['B.E.', 'B.Tech', 'M.Tech', 'MCA'],
    branches: ['Computer Science', 'Information Technology', 'Artificial Intelligence and Machine Learning', 'Data Science'],
    colleges: ['DIET', 'GITN', 'LIT', 'CIIT', 'SCCA'],
    rounds: [
      { name: 'Online coding test', type: 'MCQ_TEST', mode: 'ONLINE' },
      { name: 'Technical interview', type: 'LIVE_INTERVIEW', mode: 'ON_CAMPUS' },
      { name: 'HR conversation', type: 'LIVE_INTERVIEW', mode: 'ONLINE' },
    ],
  },
  {
    company: 'hiring@zenithlabs.example',
    title: 'QA Engineer',
    description:
      'Own the quality of a product used by thousands of people a day: write test plans, automate the repetitive ones, and work with developers to fix what you find.',
    location: 'Pune',
    workMode: 'ONSITE',
    ctcMin: 400000,
    ctcMax: 500000,
    openings: 6,
    closesIn: 3,
    courses: ['B.E.', 'B.Tech', 'BCA', 'B.Sc'],
    branches: [],
    colleges: ['DIET', 'LIT', 'CIIT', 'SCCA', 'SACS'],
    rounds: [
      { name: 'Aptitude test', type: 'MCQ_TEST', mode: 'ONLINE' },
      { name: 'Interview', type: 'LIVE_INTERVIEW', mode: 'ON_CAMPUS' },
    ],
  },
  {
    company: 'talent@northwind.example',
    title: 'Data Analyst',
    description:
      'Turn messy business data into answers people act on. SQL every day, dashboards most weeks, and a seat in the meetings where the numbers get used.',
    location: 'Mumbai',
    workMode: 'HYBRID',
    ctcMin: 500000,
    ctcMax: 650000,
    openings: 8,
    closesIn: 15,
    minCgpa: 6,
    courses: ['B.Sc', 'B.Tech', 'M.Sc', 'MCA'],
    branches: ['Data Science', 'Mathematics', 'Computer Science'],
    colleges: ['SACS', 'LIT', 'SCCA', 'CIIT'],
    rounds: [
      { name: 'Case assignment', type: 'ASSIGNMENT', mode: 'ONLINE' },
      { name: 'Panel interview', type: 'LIVE_INTERVIEW', mode: 'AT_OFFICE' },
    ],
  },
  {
    company: 'talent@northwind.example',
    title: 'Business Analyst',
    description:
      'Sit between our clients and our engineers: understand what a client actually needs, write it down clearly, and make sure what we build is that.',
    location: 'Pune',
    workMode: 'ONSITE',
    ctcMin: 600000,
    ctcMax: 700000,
    openings: 5,
    closesIn: 18,
    courses: ['MBA', 'BBA'],
    branches: [],
    colleges: ['IIMR', 'SCCM', 'SACS'],
    rounds: [
      { name: 'Group discussion', type: 'GROUP_DISCUSSION', mode: 'ON_CAMPUS' },
      { name: 'Interview', type: 'LIVE_INTERVIEW', mode: 'ON_CAMPUS' },
    ],
  },
  {
    company: 'hiring@indussystems.example',
    title: 'Graduate Engineer Trainee',
    description:
      'A one-year rotation across our design, production and quality teams before you settle in one. Paid training, a structured programme, and a plant floor to learn on.',
    location: 'Chakan',
    workMode: 'ONSITE',
    ctcMin: 450000,
    ctcMax: 450000,
    openings: 20,
    closesIn: 10,
    minCgpa: 6,
    courses: ['B.E.'],
    branches: ['Electrical', 'Mechanical Engineering', 'Civil', 'Electronics and Telecommunication'],
    colleges: ['DIET', 'GITN', 'LIT'],
    rounds: [
      { name: 'Technical test', type: 'MCQ_TEST', mode: 'ON_CAMPUS' },
      { name: 'Technical interview', type: 'LIVE_INTERVIEW', mode: 'ON_CAMPUS' },
    ],
  },
  {
    company: 'hiring@harbourfintech.example',
    title: 'Finance Associate',
    description:
      'Work on reconciliations, reporting and month-end close for a fast-growing payments company, with a clear path to analyst within two years.',
    location: 'Mumbai',
    workMode: 'ONSITE',
    ctcMin: 500000,
    ctcMax: 600000,
    openings: 6,
    closesIn: 14,
    courses: ['MBA', 'B.Com', 'M.Com'],
    branches: [],
    colleges: ['IIMR', 'SCCM', 'SACS'],
    rounds: [
      { name: 'Aptitude and accounts test', type: 'MCQ_TEST', mode: 'ONLINE' },
      { name: 'Interview', type: 'LIVE_INTERVIEW', mode: 'ONLINE' },
    ],
  },
  {
    company: 'hiring@harbourfintech.example',
    title: 'Relationship Manager',
    description:
      'Look after a portfolio of small-business customers: help them use our products well, and be the person they call when something needs fixing.',
    location: 'Pune',
    workMode: 'ONSITE',
    ctcMin: 450000,
    ctcMax: 550000,
    openings: 10,
    closesIn: 21,
    courses: ['MBA', 'BBA'],
    branches: [],
    colleges: ['IIMR', 'SCCM'],
    rounds: [
      { name: 'Group discussion', type: 'GROUP_DISCUSSION', mode: 'ON_CAMPUS' },
      { name: 'Interview', type: 'LIVE_INTERVIEW', mode: 'ON_CAMPUS' },
    ],
  },
  {
    company: 'hiring@vertexmotors.example',
    title: 'Design Engineer',
    description:
      'Design and validate vehicle components in CAD, then see them built. You will work alongside the testing team and own parts from drawing to production.',
    location: 'Pune',
    workMode: 'ONSITE',
    ctcMin: 550000,
    ctcMax: 550000,
    openings: 4,
    closesIn: 9,
    minCgpa: 6.5,
    courses: ['B.E.'],
    branches: ['Mechanical Engineering'],
    colleges: ['DIET', 'GITN'],
    rounds: [
      { name: 'Design test', type: 'ASSIGNMENT', mode: 'ON_CAMPUS' },
      { name: 'Technical interview', type: 'LIVE_INTERVIEW', mode: 'AT_OFFICE' },
    ],
  },
  {
    company: 'hiring@vertexmotors.example',
    title: 'HR Trainee',
    description:
      'Join our people team across hiring, onboarding and employee engagement for 2,000 people at three plants. A year-long programme with a mentor.',
    location: 'Pune',
    workMode: 'ONSITE',
    ctcMin: 420000,
    ctcMax: 420000,
    openings: 2,
    closesIn: 16,
    courses: ['MBA'],
    branches: ['Human Resources'],
    colleges: ['IIMR'],
    rounds: [
      { name: 'Interview', type: 'LIVE_INTERVIEW', mode: 'AT_OFFICE' },
    ],
  },
];

// ---------------------------------------------------------------------------
// A tiny signed-in client: one cookie per person.
// ---------------------------------------------------------------------------

class Session {
  private cookie = '';
  constructor(readonly who: string) {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(`${this.who} ${method} ${path} → ${res.status}: ${JSON.stringify(data?.error ?? data)}`);
    }
    return data as T;
  }

  static async login(email: string): Promise<Session> {
    const s = new Session(email);
    await s.call('POST', '/auth/login', { email, password: PASSWORD });
    return s;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  // --- 1. officers open their drives --------------------------------------
  console.log(`1. Officers open "${DRIVE}"…`);
  const officers = new Map<string, Session>();
  const drives = new Map<string, string>(); // college code → placement id

  for (const code of COLLEGES) {
    const s = await Session.login(officerOf(code));
    officers.set(code, s);

    const { placements } = await s.call<{ placements: { id: string; name: string; year: number }[] }>('GET', '/campus/placements');
    let drive = placements.find((p) => p.name === DRIVE && p.year === YEAR);
    if (!drive) {
      const { batches } = await s.call<{ batches: { id: string; name: string }[] }>('GET', '/campus/batches');
      const ids = batches.filter((b) => b.name !== 'Unassigned').map((b) => b.id);
      const created = await s.call<{ placement: { id: string; name: string; year: number } }>('POST', '/campus/placements', {
        name: DRIVE,
        type: 'FINAL',
        year: YEAR,
        oneOfferRule: true,
        batchIds: ids,
      });
      drive = created.placement;
      console.log(`   ${code}: opened, with ${ids.length} batches`);
    } else {
      console.log(`   ${code}: already open`);
    }
    drives.set(code, drive.id);
  }

  // --- 2. companies post their roles ---------------------------------------
  console.log('2. Companies post roles…');
  const companies = new Map<string, Session>();
  const posted: string[] = [];

  for (const j of JOBS) {
    const s = companies.get(j.company) ?? (await Session.login(j.company));
    companies.set(j.company, s);

    // Our own role, recognised by its description: the company may already
    // have a role with the same title from another season or college.
    const { jobs } = await s.call<{ jobs: { id: string; title: string; status: string }[] }>('GET', '/company/jobs');
    let existing: { id: string; status: string } | undefined;
    for (const x of jobs.filter((x) => x.title === j.title && x.status !== 'CLOSED')) {
      const detail = await s.call<{ job: { description: string } }>('GET', `/company/jobs/${x.id}`);
      if (detail.job.description === j.description) {
        existing = x;
        break;
      }
    }
    if (existing?.status === 'PUBLISHED') {
      console.log(`   ${j.title} (${j.company.split('@')[1]}): already published`);
      posted.push(j.title);
      continue;
    }

    const job =
      existing ??
      (
        await s.call<{ job: { id: string } }>('POST', '/company/jobs', {
          title: j.title,
          description: j.description,
          jobType: 'FULL_TIME',
          workMode: j.workMode,
          location: j.location,
          openings: j.openings,
          deadline: inDays(j.closesIn),
          payPeriod: 'YEARLY',
          ctcMin: j.ctcMin,
          ctcMax: j.ctcMax,
          ctcFixed: j.ctcMin,
          minCgpa: j.minCgpa,
          maxBacklogs: 0,
          allowedCourses: j.courses,
          allowedSpecialisations: j.branches,
          graduationYears: [YEAR, YEAR + 1],
          employerType: 'DIRECT',
          offerLetterDays: 14,
          offerConditional: 'NO',
          resultDays: 7,
          terms: ['No fee is charged to students at any stage.'],
        })
      ).job;

    await s.call('PUT', `/company/jobs/${job.id}/rounds`, {
      rounds: j.rounds.map((r, i) => ({
        name: r.name,
        type: r.type,
        mode: r.mode,
        isElimination: i < j.rounds.length - 1,
        isOnline: r.mode === 'ONLINE',
        durationMin: r.type === 'LIVE_INTERVIEW' ? 30 : 60,
      })),
    });

    const targets = j.colleges.map((c) => drives.get(c)).filter((id): id is string => Boolean(id));
    await s.call('PUT', `/company/jobs/${job.id}/targets`, {
      targets: targets.map((placementId) => ({ placementId, batchIds: [] })),
    });
    await s.call('POST', `/company/jobs/${job.id}/declare-no-fee`).catch(() => undefined);
    await s.call('POST', `/company/jobs/${job.id}/publish`);
    console.log(`   + ${j.title} (${j.company.split('@')[1]}) → ${j.colleges.join(', ')}`);
    posted.push(j.title);
  }

  // --- 3. officers approve what was sent to them ---------------------------
  console.log('3. Officers approve…');
  for (const [code, s] of officers) {
    const { postings } = await s.call<{ postings: { id: string; title: string }[] }>('GET', '/campus/postings?status=PENDING');
    const ours = postings.filter((p) => posted.includes(p.title));
    for (const p of ours) await s.call('POST', `/campus/postings/${p.id}/accept`);
    console.log(`   ${code}: approved ${ours.length}`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
