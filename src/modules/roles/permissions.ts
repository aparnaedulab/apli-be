import { Role } from '@prisma/client';

/**
 * What anyone on the platform may do, named.
 *
 * Code asks for a capability - `can('student:verify')` - never for a role.
 * That is the whole point: roles are data, created and edited by operations,
 * so a handler that checked for "TPO" would refuse a role somebody invented
 * yesterday that ought to be allowed.
 *
 * Two rules decided what is in here:
 *
 *   A permission exists where a real person would be given one thing and not
 *   the other. Verifying a student is a different act from entering one -
 *   freezing is the college telling recruiters a CGPA is real. Publishing a
 *   role is different from drafting it. Exporting a spreadsheet of three
 *   hundred phone numbers is different from looking at one.
 *
 *   A permission does not exist where the split would only ever be noise.
 *   Adding one student and importing three hundred is the same act at
 *   different volumes. Rejecting and advancing are the same move through the
 *   same state machine. Nobody would ever tick one and not the other.
 *
 * Students hold none of these. A candidate arrives on a college roster and
 * their reach is their own record; giving them a row here would invite
 * somebody to grant a student a capability.
 */

export const PERMISSIONS = {
  /* --- colleges ---------------------------------------------------------- */
  'college:read': 'See colleges',
  'college:write': 'Add and edit colleges',
  'college:archive': 'Retire a college',

  /* --- companies --------------------------------------------------------- */
  'company:read': 'See companies',
  'company:write': 'Add and edit companies',
  /** The gate: who may let a recruiter near students. */
  'company:verify': 'Verify, reject and suspend companies',

  /* --- batches ----------------------------------------------------------- */
  'batch:read': 'See batches',
  'batch:write': 'Create and edit batches',
  'batch:delete': 'Delete a batch',

  /* --- students ---------------------------------------------------------- */
  'student:read': 'See the student roster',
  'student:write': 'Add and edit students',
  /** The eligibility gate: the college vouching for what it entered. */
  'student:verify': 'Verify and freeze students',
  'student:invite': 'Send students their activation links',
  'student:remove': 'Remove a student from a batch',

  /* --- drives ------------------------------------------------------------ */
  'drive:read': 'See placement drives',
  'drive:write': 'Create and run placement drives',

  /* --- company requests at a college -------------------------------------- */
  'posting:read': 'See company requests',
  'posting:decide': 'Accept or decline company requests',

  /* --- roles a company is hiring for -------------------------------------- */
  'job:read': 'See roles',
  'job:write': 'Draft and edit roles',
  /** Outward-facing: the moment a role becomes visible to students. */
  'job:publish': 'Publish roles to colleges',
  'posting:target': 'Choose which drives a role goes to',

  /** A company editing its own public page. Its name is what students see. */
  'company:profile': 'Edit the company profile',

  /* --- applications ------------------------------------------------------- */
  'application:read': 'See applications',
  'application:advance': 'Move candidates through rounds',
  'feed:moderate': 'Post as the college, and take down anything on its feed',
  'offer:make': 'Make and withdraw offers',

  /* --- reporting ---------------------------------------------------------- */
  'report:read': 'See placement statistics',
  /** Data leaving the platform is its own decision. */
  'report:export': 'Download rosters and reports',

  /* --- people ------------------------------------------------------------- */
  'team:manage': 'Invite and remove colleagues',
  'login:manage': 'Create logins anywhere on the platform',
  'role:manage': 'Create and edit roles',
  'account:suspend': 'Deactivate any account',

  /* --- the platform -------------------------------------------------------- */
  'settings:write': 'Change platform settings',
  'audit:read': 'Read the audit trail',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * The ceiling for each kind of account.
 *
 * A role belongs to one of these worlds and can never hold a capability from
 * outside it - a college role cannot be given `company:verify` however it is
 * edited, because the college side of the platform has no such power to give.
 */
const CAMPUS: Permission[] = [
  'batch:read',
  'batch:write',
  'batch:delete',
  'student:read',
  'student:write',
  'student:verify',
  'student:invite',
  'student:remove',
  'drive:read',
  'drive:write',
  'posting:read',
  'posting:decide',
  'application:read',
  'application:advance',
  'report:read',
  'report:export',
  'feed:moderate',
  'team:manage',
];

const COMPANY: Permission[] = [
  'company:profile',
  'job:read',
  'job:write',
  'job:publish',
  'posting:target',
  'application:read',
  'application:advance',
  'offer:make',
  'report:read',
  'report:export',
  'team:manage',
];

const ADMIN: Permission[] = [
  'college:read',
  'college:write',
  'college:archive',
  'company:read',
  'company:write',
  'company:verify',
  // Operations works across every college, so it holds the college-side
  // capabilities too - it onboards rosters on a college's behalf.
  'batch:read',
  'batch:write',
  'batch:delete',
  'student:read',
  'student:write',
  'student:verify',
  'student:invite',
  'student:remove',
  'drive:read',
  'posting:read',
  'job:read',
  'application:read',
  'report:read',
  'report:export',
  'login:manage',
  'role:manage',
  'account:suspend',
  'settings:write',
  'audit:read',
];

export const SCOPE_PERMISSIONS: Record<'CAMPUS' | 'COMPANY' | 'ADMIN', Permission[]> = {
  CAMPUS,
  COMPANY,
  ADMIN,
};

export type RoleScope = keyof typeof SCOPE_PERMISSIONS;

/** Which world an account type lives in. Candidates have no role at all. */
export function scopeForRole(role: Role): RoleScope | null {
  switch (role) {
    case Role.ADMIN:
      return 'ADMIN';
    case Role.CAMPUS:
      return 'CAMPUS';
    case Role.COMPANY:
      return 'COMPANY';
    case Role.CANDIDATE:
      return null;
  }
}

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

/** Keeps a role's permissions inside its own world, whatever was submitted. */
export function withinScope(scope: RoleScope, permissions: string[]): Permission[] {
  const allowed = new Set<string>(SCOPE_PERMISSIONS[scope]);
  return permissions.filter((p): p is Permission => isPermission(p) && allowed.has(p));
}

/** Every read in a world, for the roles that look but never touch. */
const readsIn = (scope: RoleScope): Permission[] =>
  SCOPE_PERMISSIONS[scope].filter((p) => p.endsWith(':read'));

/* -------------------------------------------------------------------------- */
/* The roles every deployment starts with                                     */
/* -------------------------------------------------------------------------- */

export interface SystemRole {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: Permission[];
}

/**
 * Seeded, and not deletable.
 *
 * Every world needs one role that can do everything in it, or an organisation
 * could be left with nobody able to act. Those three can be renamed and
 * copied; their permissions cannot be reduced.
 *
 * The rest are starting points. A university that wants its coordinators to
 * verify students edits the role rather than asking for a release.
 */
export const SYSTEM_ROLES: SystemRole[] = [
  /* --- college ----------------------------------------------------------- */
  {
    key: 'campus.officer',
    name: 'Placement officer',
    description:
      'Runs the placement cell. Everything for their own college, including verifying students and managing the team.',
    scope: 'CAMPUS',
    permissions: CAMPUS,
  },
  {
    key: 'campus.coordinator',
    name: 'Coordinator',
    description:
      'Day-to-day placement work: rosters, batches, drives and applications. Cannot verify students or change the team.',
    scope: 'CAMPUS',
    permissions: [
      'batch:read',
      'batch:write',
      'student:read',
      'student:write',
      'student:invite',
      'drive:read',
      'drive:write',
      'posting:read',
      'posting:decide',
      'application:read',
      'application:advance',
      'report:read',
      'feed:moderate',
    ],
  },
  {
    key: 'campus.verifier',
    name: 'Verifier',
    description:
      'Checks marks against college records and freezes students. Changes nothing else - the act of vouching, separated from the act of typing.',
    scope: 'CAMPUS',
    permissions: ['batch:read', 'student:read', 'student:verify'],
  },
  {
    key: 'campus.dataentry',
    name: 'Data entry',
    description:
      'Enters and corrects the roster. Cannot verify students, run drives or see applications.',
    scope: 'CAMPUS',
    permissions: ['batch:read', 'student:read', 'student:write'],
  },
  {
    key: 'campus.viewer',
    name: 'Viewer',
    description: 'Reads everything at their college and changes nothing. For a head of department or principal.',
    scope: 'CAMPUS',
    permissions: readsIn('CAMPUS'),
  },

  /* --- company ----------------------------------------------------------- */
  {
    key: 'company.owner',
    name: 'Owner',
    description: 'Runs the company account. Publishes roles, decides offers, manages the team.',
    scope: 'COMPANY',
    permissions: COMPANY,
  },
  {
    key: 'company.hiringmanager',
    name: 'Hiring manager',
    description:
      'Drafts and publishes roles, runs the pipeline and makes offers. Cannot change the team.',
    scope: 'COMPANY',
    permissions: [
      'job:read',
      'job:write',
      'job:publish',
      'posting:target',
      'application:read',
      'application:advance',
      'offer:make',
      'report:read',
    ],
  },
  {
    key: 'company.recruiter',
    name: 'Recruiter',
    description:
      'Drafts roles and works the pipeline. Cannot publish a role, make an offer or change the team.',
    scope: 'COMPANY',
    permissions: [
      'job:read',
      'job:write',
      'posting:target',
      'application:read',
      'application:advance',
      'report:read',
    ],
  },
  {
    key: 'company.interviewer',
    name: 'Interviewer',
    description: 'Sees applicants and records round outcomes. Cannot draft or publish roles.',
    scope: 'COMPANY',
    permissions: ['application:read', 'application:advance'],
  },
  {
    key: 'company.viewer',
    name: 'Viewer',
    description: 'Reads the company account and changes nothing.',
    scope: 'COMPANY',
    permissions: readsIn('COMPANY'),
  },

  /* --- university -------------------------------------------------------- */
  {
    key: 'admin.super',
    name: 'Super admin',
    description: 'Everything, including creating roles and other logins.',
    scope: 'ADMIN',
    permissions: ADMIN,
  },
  {
    key: 'admin.university',
    name: 'University admin',
    description:
      'Runs the portal day to day: colleges, companies, rosters and reports. Cannot change roles or settings, or deactivate accounts.',
    scope: 'ADMIN',
    permissions: [
      'college:read',
      'college:write',
      'company:read',
      'company:write',
      'company:verify',
      'batch:read',
      'batch:write',
      'student:read',
      'student:write',
      'student:invite',
      'drive:read',
      'posting:read',
      'job:read',
      'application:read',
      'report:read',
      'report:export',
      'login:manage',
      'audit:read',
    ],
  },
  {
    key: 'admin.onboarding',
    name: 'Onboarding officer',
    description:
      'Adds colleges and companies and gets their rosters in. Cannot verify a company - putting a recruiter in front of students is somebody else’s decision.',
    scope: 'ADMIN',
    permissions: [
      'college:read',
      'college:write',
      'company:read',
      'company:write',
      'batch:read',
      'batch:write',
      'student:read',
      'student:write',
      'student:invite',
    ],
  },
  {
    key: 'admin.compliance',
    name: 'Compliance officer',
    description:
      'Vets recruiters: verifies, rejects and suspends companies. Reads everything else and changes none of it.',
    scope: 'ADMIN',
    permissions: [...readsIn('ADMIN'), 'company:verify', 'audit:read'],
  },
  {
    key: 'admin.auditor',
    name: 'Auditor',
    description: 'Reads everything and exports it. Changes nothing anywhere.',
    scope: 'ADMIN',
    permissions: [...readsIn('ADMIN'), 'audit:read', 'report:export'],
  },
];

/** The one role per world that must always keep every permission. */
export const FULL_POWER_KEYS = new Set(['campus.officer', 'company.owner', 'admin.super']);
