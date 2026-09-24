/**
 * Every module an institution can have, and the plans that bundle them.
 *
 * A module is software, so the catalogue is code: adding one is a release, and
 * a release is when it becomes true that the thing exists. What each tenant
 * has switched on is data (TenantModule rows), chosen during onboarding and
 * changed later from the same screen.
 *
 * `status` is honest about what is built. A tenant can be entitled to a
 * planned module - it is switched on the day it ships - but no screen may
 * pretend a planned module works today.
 */

export type ModuleCategory =
  | 'core'
  | 'trust'
  | 'compliance'
  | 'development'
  | 'proof'
  | 'showcase'
  | 'operations'
  | 'channels';

export type Audience = 'student' | 'college' | 'company';

export interface ModuleDefinition {
  key: string;
  name: string;
  /** One line, in the words a placement officer would use. */
  summary: string;
  category: ModuleCategory;
  audience: Audience[];
  /** live: in the product today. planned: on the roadmap, see PRODUCT.md. */
  status: 'live' | 'planned';
  /** The roadmap phase that ships it. 0 is what exists now. */
  phase: 0 | 1 | 2 | 3;
  /** Always on. The portal is not a portal without these. */
  core?: boolean;
  /** Modules this one cannot work without. Switched on alongside it. */
  requires?: string[];
}

export const CATEGORIES: Record<ModuleCategory, { name: string; blurb: string }> = {
  core: {
    name: 'Placement core',
    blurb: 'Rosters, drives, company requests and the hiring pipeline. Always included.',
  },
  trust: {
    name: 'Trust & transparency',
    blurb: 'Every job real, every offer kept, every student told where they stand.',
  },
  compliance: {
    name: 'Compliance & reporting',
    blurb: 'Accreditation reports, internship credits and data-protection consent.',
  },
  development: {
    name: 'Student development',
    blurb: 'A year-round career gym: practice, confidence and professional presence.',
  },
  proof: {
    name: 'Proof of work',
    blurb: 'What a student can show, not just what they claim.',
  },
  showcase: {
    name: 'Showcase & community',
    blurb: 'Companies earn their reputation; students show their work.',
  },
  operations: {
    name: 'Placement cell tools',
    blurb: 'The CRM, drive-day and analytics a placement office runs on.',
  },
  channels: {
    name: 'Reach',
    blurb: 'Meet students where they already are.',
  },
};

export const MODULES: ModuleDefinition[] = [
  /* --- core: what exists today ------------------------------------------- */
  {
    key: 'core.roster',
    name: 'Student roster & verification',
    summary: 'Batches, bulk import, join links, and freezing verified records.',
    category: 'core',
    audience: ['college', 'student'],
    status: 'live',
    phase: 0,
    core: true,
  },
  {
    key: 'core.drives',
    name: 'Placement drives',
    summary: 'Final and internship drives, with the one-offer rule.',
    category: 'core',
    audience: ['college'],
    status: 'live',
    phase: 0,
    core: true,
  },
  {
    key: 'core.jobs',
    name: 'Company requests & approvals',
    summary: 'Companies post roles; each college approves what reaches its students.',
    category: 'core',
    audience: ['college', 'company', 'student'],
    status: 'live',
    phase: 0,
    core: true,
  },
  {
    key: 'core.pipeline',
    name: 'Hiring pipeline & offers',
    summary: 'Rounds, shortlists, offers and a full audit trail.',
    category: 'core',
    audience: ['company', 'college', 'student'],
    status: 'live',
    phase: 0,
    core: true,
  },
  {
    key: 'core.notifications',
    name: 'Notifications',
    summary: 'In-app updates for every hand-off.',
    category: 'core',
    audience: ['student', 'college', 'company'],
    status: 'live',
    phase: 0,
    core: true,
  },
  {
    key: 'core.dashboards',
    name: 'Dashboards',
    summary: 'Where every batch, drive and role stands, at a glance.',
    category: 'core',
    audience: ['college', 'company'],
    status: 'live',
    phase: 0,
    core: true,
  },

  /* --- phase 1: the trust core ------------------------------------------- */
  {
    key: 'trust.offerCard',
    name: 'Honest offer card',
    summary: 'Fixed, variable, bond and estimated in-hand pay - shown before anyone applies.',
    category: 'trust',
    audience: ['student', 'company'],
    status: 'live',
    phase: 1,
  },
  {
    key: 'trust.tracker',
    name: 'Live application tracker',
    summary: 'Students see every stage; companies are held to a response deadline.',
    category: 'trust',
    audience: ['student', 'company'],
    status: 'live',
    phase: 1,
    requires: ['core.pipeline'],
  },
  {
    key: 'trust.whyNot',
    name: '"Why can\'t I apply?"',
    summary: 'Tells an ineligible student exactly which bar they missed and what to fix.',
    category: 'trust',
    audience: ['student'],
    status: 'live',
    phase: 1,
  },
  {
    key: 'trust.scamShield',
    name: 'Scam shield',
    summary: 'Automatic company checks and fee-demand detection on every listing.',
    category: 'trust',
    audience: ['student', 'college'],
    status: 'live',
    phase: 1,
  },
  {
    key: 'trust.offerProtection',
    name: 'Offer protection',
    summary: 'Tracks joining dates after acceptance; publishes each company\'s offer-honour rate.',
    category: 'trust',
    audience: ['student', 'college'],
    status: 'live',
    phase: 3,
    requires: ['core.pipeline'],
  },
  {
    key: 'trust.reputation',
    name: 'Two-way reputation',
    summary: 'Students rate the hiring process; companies record reliability. Colleges see both.',
    category: 'trust',
    audience: ['student', 'company', 'college'],
    status: 'live',
    phase: 3,
  },

  /* --- compliance ---------------------------------------------------------- */
  {
    key: 'compliance.reports',
    name: 'NAAC / NIRF / NBA reports',
    summary: 'Placement statistics in the format accreditation bodies ask for, in one click.',
    category: 'compliance',
    audience: ['college'],
    status: 'live',
    phase: 1,
    requires: ['core.dashboards'],
  },
  {
    key: 'compliance.consent',
    name: 'DPDP consent centre',
    summary: 'Students grant each use of their data separately, and can withdraw it.',
    category: 'compliance',
    audience: ['student', 'college'],
    status: 'live',
    phase: 1,
  },
  {
    key: 'compliance.internships',
    name: 'NEP internship management',
    summary: 'Allotment, weekly logs, supervisor evaluation and ABC credits.',
    category: 'compliance',
    audience: ['college', 'student', 'company'],
    status: 'live',
    phase: 2,
  },

  /* --- student development ------------------------------------------------ */
  {
    key: 'dev.readiness',
    name: 'Readiness score & plan',
    summary: 'A six-area diagnostic and a weekly plan - prep appears when a shortlist does.',
    category: 'development',
    audience: ['student', 'college'],
    status: 'live',
    phase: 2,
  },
  {
    key: 'dev.aptitude',
    name: 'Aptitude & technical practice',
    summary: 'Company-pattern mock tests with spaced repetition.',
    category: 'development',
    audience: ['student'],
    status: 'live',
    phase: 2,
    requires: ['dev.readiness'],
  },
  {
    key: 'dev.mockInterview',
    name: 'AI mock interviewer',
    summary: 'HR, technical and managerial practice with feedback - clarity, never accent.',
    category: 'development',
    audience: ['student'],
    status: 'live',
    phase: 2,
    requires: ['dev.readiness'],
  },
  {
    key: 'dev.gd',
    name: 'Group discussion simulator',
    summary: 'Practise a GD against AI participants, and learn to enter and summarise.',
    category: 'development',
    audience: ['student'],
    status: 'live',
    phase: 3,
    requires: ['dev.mockInterview'],
  },
  {
    key: 'dev.confidence',
    name: 'Confidence & wellbeing',
    summary: 'An exposure ladder, a pre-interview warm-up and placement-season check-ins.',
    category: 'development',
    audience: ['student'],
    status: 'live',
    phase: 3,
  },
  {
    key: 'dev.presence',
    name: 'Professional presence',
    summary: 'Dress by industry and budget, etiquette, and a camera-setup check.',
    category: 'development',
    audience: ['student'],
    status: 'live',
    phase: 1,
  },
  {
    key: 'dev.softSkills',
    name: 'Soft skills studio',
    summary: 'Spoken English, presentation and writing - practised, not watched.',
    category: 'development',
    audience: ['student'],
    status: 'live',
    phase: 3,
  },

  /* --- proof of work -------------------------------------------------------- */
  {
    key: 'proof.passport',
    name: 'Verified skills passport',
    summary: 'Every claim labelled: college-verified, employer-verified or self-reported.',
    category: 'proof',
    audience: ['student', 'company'],
    status: 'live',
    phase: 2,
    requires: ['core.roster'],
  },
  {
    key: 'proof.simulations',
    name: 'Virtual work experiences',
    summary: 'Short company-built projects, with an "explain your work" check.',
    category: 'proof',
    audience: ['student', 'company'],
    status: 'live',
    phase: 2,
    requires: ['proof.passport'],
  },
  {
    key: 'proof.microInternships',
    name: 'Micro-internships',
    summary: 'Paid 10-40 hour projects: earn, prove, get hired.',
    category: 'proof',
    audience: ['student', 'company'],
    status: 'live',
    phase: 3,
    requires: ['proof.passport'],
  },

  /* --- showcase ------------------------------------------------------------- */
  {
    key: 'showcase.company',
    name: 'Company showcase',
    summary: 'What the company says, what the platform measures, what seniors say.',
    category: 'showcase',
    audience: ['company', 'student'],
    status: 'live',
    phase: 1,
  },
  {
    key: 'showcase.stories',
    name: 'Campus stories',
    summary: 'Interview experiences and intern diaries, by company, college and year.',
    category: 'showcase',
    audience: ['student'],
    status: 'live',
    phase: 2,
  },
  {
    key: 'showcase.student',
    name: 'Student showcase',
    summary: 'A portfolio recruiters can browse - and invite a student to apply from.',
    category: 'showcase',
    audience: ['student', 'company'],
    status: 'live',
    phase: 2,
    requires: ['proof.passport'],
  },
  {
    key: 'showcase.campusWeeks',
    name: 'Campus weeks',
    summary: 'A company takes over a campus for a week: talk, challenge, alumni, invites.',
    category: 'showcase',
    audience: ['company', 'college', 'student'],
    status: 'live',
    phase: 3,
    requires: ['showcase.company'],
  },
  {
    key: 'community.alumni',
    name: 'Alumni connect',
    summary: 'Ask a senior, alumni mock interviews and referrals.',
    category: 'showcase',
    audience: ['student', 'college'],
    status: 'live',
    phase: 3,
  },

  /* --- placement cell tools -------------------------------------------------- */
  {
    key: 'ops.employerCrm',
    name: 'Employer CRM',
    summary: 'Contacts, conversations, follow-ups and who came back each year.',
    category: 'operations',
    audience: ['college'],
    status: 'live',
    phase: 2,
  },
  {
    key: 'ops.driveDay',
    name: 'Drive-day control centre',
    summary: 'Panels, rooms, QR attendance and a live status board.',
    category: 'operations',
    audience: ['college', 'company'],
    status: 'live',
    phase: 2,
    requires: ['core.drives'],
  },
  {
    key: 'ops.atRisk',
    name: 'At-risk alerts',
    summary: 'Flags students who have stalled, early enough to help.',
    category: 'operations',
    audience: ['college'],
    status: 'live',
    phase: 2,
  },
  {
    key: 'ops.pooledDrives',
    name: 'Pooled drives',
    summary: 'Several smaller colleges run one drive together.',
    category: 'operations',
    audience: ['college', 'company'],
    status: 'live',
    phase: 3,
    requires: ['core.drives'],
  },
  {
    key: 'ops.skillHeatmap',
    name: 'Skill-demand heatmap',
    summary: 'What companies asked for this year against what the curriculum teaches.',
    category: 'operations',
    audience: ['college'],
    status: 'live',
    phase: 3,
  },

  /* --- reach ----------------------------------------------------------------- */
  {
    key: 'channel.whatsapp',
    name: 'WhatsApp notifications',
    summary: 'Drive and deadline alerts where students actually read them.',
    category: 'channels',
    audience: ['student', 'college'],
    status: 'live',
    phase: 1,
    requires: ['core.notifications'],
  },
  {
    key: 'channel.vernacular',
    name: 'Regional languages',
    summary: 'Hindi and Marathi first, for students and practice tools.',
    category: 'channels',
    audience: ['student'],
    status: 'live',
    phase: 3,
  },
];

/* -------------------------------------------------------------------------- */
/* Where each feature lives                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The tabs each audience sees - the screens of the portal, not its features.
 *
 * A feature almost always lives inside a screen that exists anyway: the honest
 * offer card is part of Jobs, the live tracker part of Applications. A few
 * features need a screen of their own ("Prepare" for the career gym), and such
 * a tab appears only when a switched-on feature puts something in it.
 * `core` tabs are there for everyone, whatever is switched on.
 */
export interface ScreenDefinition {
  key: string;
  label: string;
  core: boolean;
}

export const SCREENS: Record<Audience, ScreenDefinition[]> = {
  student: [
    { key: 'dashboard', label: 'Dashboard', core: true },
    { key: 'jobs', label: 'Jobs', core: true },
    { key: 'applications', label: 'Applications', core: true },
    { key: 'prepare', label: 'Prepare', core: false },
    { key: 'projects', label: 'Projects', core: false },
    { key: 'internships', label: 'Internships', core: false },
    { key: 'community', label: 'Community', core: false },
    { key: 'profile', label: 'Profile', core: true },
  ],
  college: [
    { key: 'dashboard', label: 'Dashboard', core: true },
    { key: 'batches', label: 'Batches', core: true },
    { key: 'drives', label: 'Drives', core: true },
    { key: 'requests', label: 'Company requests', core: true },
    { key: 'internships', label: 'Internships', core: false },
    { key: 'employers', label: 'Employers', core: false },
    { key: 'reports', label: 'Reports', core: false },
    { key: 'team', label: 'Team', core: true },
  ],
  company: [
    { key: 'dashboard', label: 'Dashboard', core: true },
    { key: 'roles', label: 'Roles', core: true },
    { key: 'applicants', label: 'Applicants', core: true },
    { key: 'talent', label: 'Talent', core: false },
    { key: 'page', label: 'Company page', core: false },
    { key: 'team', label: 'Team', core: true },
  ],
};

/**
 * Which screen a feature appears on, for each audience it serves.
 *
 * A proposal, kept in one table so it can be changed without touching
 * anything else: the preview in onboarding reads it, and so will the menus
 * once these features are built.
 */
export const MODULE_SCREENS: Record<string, Partial<Record<Audience, string>>> = {
  'core.roster': { student: 'profile', college: 'batches' },
  'core.drives': { college: 'drives' },
  'core.jobs': { student: 'jobs', college: 'requests', company: 'roles' },
  'core.pipeline': { student: 'applications', college: 'drives', company: 'applicants' },
  'core.notifications': { student: 'dashboard', college: 'dashboard', company: 'dashboard' },
  'core.dashboards': { college: 'dashboard', company: 'dashboard' },

  'trust.offerCard': { student: 'jobs', company: 'roles' },
  'trust.tracker': { student: 'applications', company: 'applicants' },
  'trust.whyNot': { student: 'jobs' },
  'trust.scamShield': { student: 'jobs', college: 'requests' },
  'trust.offerProtection': { student: 'applications', college: 'drives' },
  'trust.reputation': { student: 'applications', company: 'dashboard', college: 'reports' },

  'compliance.reports': { college: 'reports' },
  'compliance.consent': { student: 'profile', college: 'batches' },
  'compliance.internships': { student: 'internships', college: 'internships', company: 'applicants' },

  'dev.readiness': { student: 'prepare', college: 'reports' },
  'dev.aptitude': { student: 'prepare' },
  'dev.mockInterview': { student: 'prepare' },
  'dev.gd': { student: 'prepare' },
  'dev.confidence': { student: 'prepare' },
  'dev.presence': { student: 'prepare' },
  'dev.softSkills': { student: 'prepare' },

  'proof.passport': { student: 'profile', company: 'applicants' },
  'proof.simulations': { student: 'projects', company: 'roles' },
  'proof.microInternships': { student: 'projects', company: 'roles' },

  'showcase.company': { student: 'jobs', company: 'page' },
  'showcase.stories': { student: 'community' },
  'showcase.student': { student: 'profile', company: 'talent' },
  'showcase.campusWeeks': { student: 'dashboard', college: 'drives', company: 'page' },
  'community.alumni': { student: 'community', college: 'dashboard' },

  'ops.employerCrm': { college: 'employers' },
  'ops.driveDay': { college: 'drives', company: 'applicants' },
  'ops.atRisk': { college: 'reports' },
  'ops.pooledDrives': { college: 'drives', company: 'roles' },
  'ops.skillHeatmap': { college: 'reports' },

  'channel.whatsapp': { student: 'dashboard', college: 'dashboard' },
  'channel.vernacular': { student: 'dashboard' },
};

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function isModuleKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function moduleByKey(key: string): ModuleDefinition | undefined {
  return BY_KEY.get(key);
}

export const CORE_KEYS = MODULES.filter((m) => m.core).map((m) => m.key);

/* -------------------------------------------------------------------------- */
/* Plans                                                                       */
/* -------------------------------------------------------------------------- */

export type PlanKey = 'STARTER' | 'GROWTH' | 'COMPLETE';

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  pitch: string;
  modules: string[];
}

const STARTER_MODULES = [
  ...CORE_KEYS,
  'trust.offerCard',
  'trust.tracker',
  'trust.whyNot',
  'compliance.consent',
];

const GROWTH_MODULES = [
  ...STARTER_MODULES,
  'trust.scamShield',
  'compliance.reports',
  'compliance.internships',
  'dev.readiness',
  'dev.aptitude',
  'dev.presence',
  'showcase.company',
  'showcase.stories',
  'ops.employerCrm',
  'ops.atRisk',
  'channel.whatsapp',
];

export const PLANS: PlanDefinition[] = [
  {
    key: 'STARTER',
    name: 'Starter',
    pitch: 'Run placements honestly: the core, plus the trust basics.',
    modules: STARTER_MODULES,
  },
  {
    key: 'GROWTH',
    name: 'Growth',
    pitch: 'Add accreditation reports, internships and student preparation.',
    modules: GROWTH_MODULES,
  },
  {
    key: 'COMPLETE',
    name: 'Complete',
    pitch: 'Everything, including proof of work, showcases and the career gym.',
    modules: MODULES.map((m) => m.key),
  },
];

export function isPlanKey(value: string): value is PlanKey {
  return PLANS.some((p) => p.key === value);
}

/* -------------------------------------------------------------------------- */
/* Resolving a selection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Turns what somebody ticked into what will actually be switched on.
 *
 * Unknown keys are dropped, core modules are always added, and every module's
 * requirements are pulled in - transitively, so ticking the GD simulator also
 * brings the mock interviewer and the readiness plan it builds on. The
 * returned `added` list is what the screen explains ("also switched on, because
 * X needs it"), so nothing appears without a reason.
 */
export function resolveModules(selected: Iterable<string>): { enabled: string[]; added: string[] } {
  const chosen = new Set<string>();
  for (const key of selected) if (BY_KEY.has(key)) chosen.add(key);

  const enabled = new Set<string>([...CORE_KEYS, ...chosen]);
  const queue = [...enabled];
  while (queue.length > 0) {
    const key = queue.pop()!;
    for (const dep of BY_KEY.get(key)?.requires ?? []) {
      if (!enabled.has(dep)) {
        enabled.add(dep);
        queue.push(dep);
      }
    }
  }

  // Catalogue order, so two equal selections always serialise the same way.
  const ordered = MODULES.map((m) => m.key).filter((k) => enabled.has(k));
  const added = ordered.filter((k) => !chosen.has(k) && !CORE_KEYS.includes(k));
  return { enabled: ordered, added };
}

/**
 * Which plan a set of modules is, if it is exactly one of them.
 *
 * A tenant that started on Growth and then switched one module off is no
 * longer on Growth, and the screen should say CUSTOM rather than pretend.
 */
export function planFor(enabled: string[]): PlanKey | 'CUSTOM' {
  const set = new Set(enabled);
  for (const plan of PLANS) {
    const resolved = resolveModules(plan.modules).enabled;
    if (resolved.length === set.size && resolved.every((k) => set.has(k))) return plan.key;
  }
  return 'CUSTOM';
}
