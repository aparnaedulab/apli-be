import { describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { ALL_PERMISSIONS, SCOPE_PERMISSIONS, SYSTEM_ROLES } from '../src/modules/roles/permissions.js';
import type { Permission } from '../src/modules/roles/permissions.js';

/**
 * Every endpoint, and the capability it demands.
 *
 * Role management was a screen that described powers the server did not
 * apply: the catalogue existed, the roles existed, and twelve of a hundred
 * and thirty-seven handlers actually checked anything. This is what stops
 * that happening again - a new endpoint with no capability fails here, and
 * the failure names the route.
 *
 * The expectations are written out in full rather than derived, because a
 * test that computed the answer the same way the code does would agree with
 * a mistake.
 */

interface Guarded {
  route: string;
  permission: Permission | null;
}

/** Walks a router and reports what each route is guarded by. */
function audit(router: Router): Guarded[] {
  return (router.stack as unknown as RouterLayer[])
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route!;
      const method = Object.keys(route.methods)[0]!.toUpperCase();
      const check = route.stack.find((s) => typeof s.handle.permission === 'string');

      return {
        route: `${method} ${route.path}`,
        permission: (check?.handle.permission as Permission) ?? null,
      };
    });
}

interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: { permission?: Permission } }[];
  };
}

/* -------------------------------------------------------------------------- */

/** Static importers: a computed path makes the bundler guess, and it warns. */
// Modules export more than their router (job.routes also exports its schema),
// so each is read as a bag of exports and the router picked out by name.
const ROUTERS: Record<string, () => Promise<Record<string, unknown>>> = {
  collegesRouter: () => import('../src/modules/admin/colleges.routes.js'),
  coursesRouter: () => import('../src/modules/admin/courses.routes.js'),
  catalogueRouter: () => import('../src/modules/admin/catalogue.routes.js'),
  referenceRouter: () => import('../src/modules/admin/reference.routes.js'),
  skillsRouter: () => import('../src/modules/admin/skills.routes.js'),
  companiesRouter: () => import('../src/modules/admin/companies.routes.js'),
  adminRouter: () => import('../src/modules/admin/admin.routes.js'),
  campusRouter: () => import('../src/modules/campus/campus.routes.js'),
  placementsRouter: () => import('../src/modules/campus/placements.routes.js'),
  postingsRouter: () => import('../src/modules/campus/postings.routes.js'),
  jobRouter: () => import('../src/modules/jobs/job.routes.js'),
  applicationRouter: () => import('../src/modules/applications/application.routes.js'),
  companyAssessmentRouter: () => import('../src/modules/assessments/assessment.routes.js'),
  campusCounsellingRouter: () => import('../src/modules/counselling/counselling.routes.js'),
  // Both halves of counselling live in one module: the student's asking,
  // and the cell's queue.
  counsellingRouter: () => import('../src/modules/counselling/counselling.routes.js'),
  companyRouter: () => import('../src/modules/company/company.routes.js'),
  companyPostsRouter: () => import('../src/modules/showcase/companyPosts.routes.js'),
  campusTeamRouter: () => import('../src/modules/campus/team.routes.js'),
  rolesRouter: () => import('../src/modules/roles/roles.routes.js'),
  accessRouter: () => import('../src/modules/roles/access.routes.js'),
  adminMappingRouter: () => import('../src/modules/mapping/mapping.routes.js'),
  campusMappingRouter: () => import('../src/modules/mapping/mapping.routes.js'),
  platformMappingRouter: () => import('../src/modules/mapping/mapping.routes.js'),
  candidateRouter: () => import('../src/modules/candidates/candidate.routes.js'),
  studentJobsRouter: () => import('../src/modules/candidates/studentJobs.routes.js'),
  notificationRouter: () => import('../src/modules/notifications/notification.routes.js'),
  authRouter: () => import('../src/modules/auth/auth.routes.js'),
};

async function routerNamed(name: string): Promise<Router> {
  const mod = await ROUTERS[name]!();
  return mod[name] as Router;
}

/** Reads a router's source, for the checks a route table cannot show. */
async function readSource(rel: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL(`../src/modules/${rel}`, import.meta.url));
  return readFile(path, 'utf8');
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  expect(start, `${from} not found`).toBeGreaterThan(-1);
  return end > start ? source.slice(start, end) : source.slice(start);
}

const EXPECTED: Record<string, Record<string, Permission | 'open'>> = {
  'collegesRouter': {
    'GET /': 'college:read',
    'POST /': 'college:write',
    'POST /bulk': 'college:write',
    'GET /bulk/template': 'college:write',
    'POST /bulk/file': 'college:write',
    'GET /:id': 'college:read',
    'PATCH /:id': 'college:write',
    'PATCH /:id/verify': 'college:write',
    'POST /:id/invites': 'login:manage',
    'DELETE /:id/invites/:inviteId': 'login:manage',
    'GET /:id/batches': 'batch:read',
    'POST /:id/batches': 'batch:write',
    'POST /:id/students': 'student:write',
    'GET /:id/students/template': 'student:write',
    'POST /:id/batches/:batchId/students': 'student:write',
  },

  'companiesRouter': {
    'GET /': 'company:read',
    'POST /': 'company:write',
    'GET /:id': 'company:read',
    'PATCH /:id': 'company:write',
    // Putting a recruiter in front of students is its own decision.
    'POST /:id/decision': 'company:verify',
    'POST /:id/invites': 'login:manage',
    'DELETE /:id/invites/:inviteId': 'login:manage',
  },

  'adminRouter': {
    'GET /batches/:id': 'batch:read',
    'POST /batches/:id/students': 'student:write',
    'GET /batches/:id/students/template': 'student:write',
    'POST /batches': 'batch:write',
    // The university's own name, and nothing else.
    'GET /meta': 'open',
    'GET /stats': 'report:read',
    // What is going on rather than how much of it there is - read-only, and
    // behind the same permission as /stats.
    'GET /overview': 'report:read',
    'GET /users': 'login:manage',
    'PATCH /users/:id': 'account:suspend',
    'GET /students': 'student:read',
    'GET /batches': 'batch:read',
    'GET /drives': 'drive:read',
    'GET /jobs': 'job:read',
    'GET /applications': 'application:read',
    'GET /audit': 'audit:read',
    'GET /invites': 'login:manage',
    'DELETE /invites/:id': 'login:manage',
  },

  'companyAssessmentRouter': {
    'GET /': 'application:read',
    'POST /': 'application:advance',
    // Assigning a test is moving a candidate through the process, so it
    // carries the same capability as any other move.
    'POST /:id/assign': 'application:advance',
    'GET /:id/assignments': 'application:read',
    'PATCH /assignments/:id': 'application:advance',
  },

  'campusCounsellingRouter': {
    'GET /': 'student:read',
    'PATCH /:id': 'student:write',
  },

  'campusRouter': {
    // The landing page for every college role, including the narrowest.
    'GET /overview': 'open',
    'GET /batches': 'batch:read',
    'POST /batches': 'batch:write',
    'GET /batches/:id': 'student:read',
    'POST /batches/:id/invites': 'student:invite',
    'POST /students': 'student:write',
    'GET /students/template': 'student:write',
    'POST /batches/:id/students': 'student:write',
    'GET /batches/:id/students/template': 'student:write',
    'POST /batches/:id/join-code': 'student:invite',
    'DELETE /batches/:id/join-code': 'student:invite',
    'DELETE /batches/:id/members/:membershipId': 'student:remove',
    'DELETE /invites/:inviteId': 'student:invite',
    'GET /students/:candidateId': 'student:read',
    // Freezing is the college vouching for a CGPA, not entering one.
    'POST /batches/:id/freeze': 'student:verify',
    'POST /batches/:id/unfreeze': 'student:verify',
  },

  'placementsRouter': {
    'GET /': 'drive:read',
    'POST /': 'drive:write',
    'GET /:id': 'drive:read',
    'PATCH /:id': 'drive:write',
    'PUT /:id/batches': 'drive:write',
    'DELETE /:id': 'drive:write',
    'GET /:id/summary': 'drive:read',
  },

  'postingsRouter': {
    'GET /': 'posting:read',
    'GET /:id': 'posting:read',
    'POST /:id/accept': 'posting:decide',
    'POST /:id/decline': 'posting:decide',
  },

  'jobRouter': {
    'GET /': 'job:read',
    // The courses, branches and skills the eligibility step offers.
    'GET /meta': 'job:read',
    // Adding a choice to one of the growable dropdowns, for this company.
    // Courses, branches and skills are not here: they are university-wide,
    // and operations keeps them under Setup.
    'POST /options': 'job:write',
    'POST /': 'job:write',
    'GET /:id': 'job:read',
    'PATCH /:id': 'job:write',
    'PUT /:id/rounds': 'job:write',
    'GET /:id/targets': 'job:read',
    // How many students the role as written would reach.
    'GET /:id/reach': 'job:read',
    'PUT /:id/targets': 'posting:target',
    // Naming who runs the hire; it grants nobody any new access.
    'PUT /:id/team': 'job:write',
    // The moment students can see it, and the moment they cannot any more.
    'POST /:id/publish': 'job:publish',
    'POST /:id/close': 'job:publish',
    // The recruiter's statement that nothing is charged; required to publish.
    'POST /:id/declare-no-fee': 'job:write',
    'DELETE /:id': 'job:write',
  },

  'applicationRouter': {
    'GET /': 'application:read',
    'GET /:id': 'application:read',
    'POST /:id/review': 'application:advance',
    'POST /:id/shortlist': 'application:advance',
    // Calling somebody to a round is what releases its date and place.
    'POST /:id/invite': 'application:advance',
    'POST /:id/advance': 'application:advance',
    'POST /:id/waitlist': 'application:advance',
    'POST /:id/reject': 'application:advance',
    // An offer is a promise to a person, not another move through a state.
    'POST /:id/offer': 'offer:make',
    'POST /:id/hire': 'offer:make',
  },

  'companyRouter': {
    'GET /overview': 'open',
    'PATCH /profile': 'company:profile',
    'POST /uploads/:kind': 'company:profile',
    // Only lists colleagues; the acts on them are guarded.
    'GET /team': 'open',
    'POST /team/invites': 'team:manage',
    'DELETE /team/invites/:id': 'team:manage',
    // Changing a role is how somebody is made a company admin, so it needs
    // the same capability as adding and removing people.
    'PATCH /team/:memberId': 'team:manage',
    'DELETE /team/:memberId': 'team:manage',
  },

  'companyPostsRouter': {
    // Reading their own posts needs no capability: anybody who works there
    // may see what the company has published and what is still a draft.
    'GET /': 'open',
    'POST /': 'company:profile',
    'PATCH /:id': 'company:profile',
    'DELETE /:id': 'company:profile',
    'POST /:id/pin': 'company:profile',
    'POST /media': 'company:profile',
  },

  'coursesRouter': {
    'GET /': 'college:read',
    'POST /': 'settings:write',
    'POST /:id/branches': 'settings:write',
    'PATCH /:id': 'settings:write',
    'PATCH /branches/:id': 'settings:write',
    'DELETE /:id': 'settings:write',
  },

  'skillsRouter': {
    'GET /': 'college:read',
    'POST /': 'settings:write',
    'PATCH /:id': 'settings:write',
    'DELETE /:id': 'settings:write',
  },

  'referenceRouter': {
    'GET /': 'college:read',
    'POST /:kind': 'settings:write',
    'PATCH /:id': 'settings:write',
    'DELETE /:id': 'settings:write',
  },

  'campusTeamRouter': {
    'GET /': 'open',
    'POST /invites': 'team:manage',
    'DELETE /invites/:id': 'team:manage',
    'PATCH /:memberId': 'team:manage',
    'DELETE /:memberId': 'team:manage',
  },

  'rolesRouter': {
    'GET /': 'role:manage',
    'POST /': 'role:manage',
    'PATCH /:id': 'role:manage',
    'DELETE /:id': 'role:manage',
    // Every admin screen that creates a login needs the list to choose from.
    'GET /assignable': 'open',
  },

  'accessRouter': {
    'GET /': 'login:manage',
    'GET /bulk/template': 'login:manage',
    // These three check per role and per row: handing out a university login
    // takes more than handing out a college one, and one file can hold both.
    'POST /invites': 'open',
    'POST /bulk': 'open',
    'DELETE /invites/:id': 'open',
    'PATCH /:scope/:membershipId': 'login:manage',
  },

  'adminMappingRouter': {
    'GET /': 'college:read',
    'GET /offered': 'college:read',
    'GET /summary': 'college:read',
    'PUT /offered': 'college:write',
    'GET /colleges/:id/programs': 'college:read',
    'PUT /colleges/:id/programs': 'college:write',
    'GET /colleges/:id/students': 'student:read',
    'GET /unplaced': 'student:read',
    'POST /programs/:id/students': 'student:write',
    'POST /unmap': 'student:write',
    'POST /students': 'student:write',
    'GET /students/template': 'student:write',
  },

  'platformMappingRouter': {
    'GET /': 'college:read',
    'GET /summary': 'college:read',
    'GET /colleges/:id/programs': 'college:read',
    'PUT /colleges/:id/programs': 'college:write',
    'GET /colleges/:id/students': 'student:read',
    'POST /programs/:id/students': 'student:write',
    'POST /unmap': 'student:write',
  },

  // A college maps only itself; its programmes are roster structure, so batch:*.
  'campusMappingRouter': {
    'GET /': 'batch:read',
    'PUT /programs': 'batch:write',
    'GET /students': 'student:read',
    'POST /programs/:id/students': 'student:write',
    'POST /unmap': 'student:write',
  },
};

describe('every endpoint names the capability it needs', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} is guarded exactly as intended`, async () => {
      const found = audit(await routerNamed(name));

      const actual = Object.fromEntries(
        found.map((g) => [g.route, g.permission ?? 'open']),
      );

      expect(actual).toEqual(expected);
    });
  }
});

describe('endpoints that do more than their name says', () => {
  /*
   * A route carries one capability, but two of them change what they do
   * depending on the request. A static audit of the router cannot see that,
   * so these name the second check in each - the ones a reader of the route
   * table would miss.
   */

  it('needs offer:make to pass the final round, not just application:advance', async () => {
    const source = await readSource('applications/application.routes.ts');
    const advance = between(source, "'/:id/advance',", "'/:id/waitlist',");

    // Passing the last round moves the application to OFFERED, which is an
    // offer made to a person - not another step through the pipeline.
    expect(advance).toContain('S.OFFERED');
    expect(advance).toContain("hasPermission(req, 'offer:make')");
  });

  it('needs feed:moderate to speak as the college or take somebody else down', async () => {
    const source = await readSource('feed/feed.routes.ts');

    // Posting as the college, and removing a post that is not your own.
    expect(source).toContain("body.asCollege && !(await hasPermission(req, 'feed:moderate'))");
    expect(source).toContain("!mine && !(await hasPermission(req, 'feed:moderate'))");
  });

  it('needs the university gate to re-role a university account', async () => {
    const source = await readSource('roles/access.routes.ts');
    const patch = source.slice(source.indexOf("'/:scope/:membershipId',"));

    // Otherwise an account that may not create a university login could
    // promote one that exists and reach everything through it.
    expect(patch).toContain('hasPermission(req, PERMISSION_FOR[scope])');
  });
});

describe('the routes a student reaches', () => {
  /*
   * Candidates hold no role at all, so none of their endpoints can carry a
   * capability - `can()` would refuse every student on the platform. Their
   * fence is `requireRole('CANDIDATE')` plus a where-clause on their own id.
   */
  it('carry no capability check, because a student has no role to check', async () => {
    for (const name of [
      'candidateRouter',
      'studentJobsRouter',
      'notificationRouter',
      'authRouter',
      // Course names, which every staff account needs and none could misuse.
      'catalogueRouter',
      'counsellingRouter',
    ]) {
      const guarded = audit(await routerNamed(name)).filter((g) => g.permission !== null);

      expect(guarded, `${name} should hold no capability checks`).toEqual([]);
    }
  });
});

/** Capabilities a handler checks for itself. Each one is proved above. */
const CHECKED_IN_HANDLER = ['offer:make', 'feed:moderate'];

describe('the permissions the endpoints actually ask for', () => {
  it('all exist in the catalogue', () => {
    const asked = new Set(
      Object.values(EXPECTED)
        .flatMap((routes) => Object.values(routes))
        .filter((p): p is Permission => p !== 'open'),
    );

    for (const p of asked) {
      expect(ALL_PERMISSIONS, `${p} is demanded by a route`).toContain(p);
    }
  });

  it('leaves no permission in the catalogue that nothing ever checks', () => {
    const asked = new Set([
      ...Object.values(EXPECTED)
        .flatMap((routes) => Object.values(routes))
        .filter((p) => p !== 'open'),
      /*
       * Checked inside a handler rather than as route middleware, because
       * what each one guards depends on the request: whether passing this
       * round makes an offer, whether this post is your own. A static audit
       * of the router cannot see them, so they are named here - and the
       * tests above read the source to prove each one is really there.
       */
      ...CHECKED_IN_HANDLER,
    ]);

    /*
     * A permission nothing checks is a promise the portal does not keep: it
     * appears on the role editor, somebody grants it, and it does nothing.
     * These are the ones still outstanding - the list shrinks, never grows.
     */
    const notYetEnforced = [
      'college:archive', // no archive endpoint yet
      'batch:delete', // no delete-a-batch endpoint yet
      'report:export', // no export exists yet
      'settings:write', // only the reference lists use it
      'account:suspend',
      'audit:read',
      'login:manage',
      'role:manage',
    ];

    const unchecked = ALL_PERMISSIONS.filter((p) => !asked.has(p));

    for (const p of unchecked) {
      expect(notYetEnforced, `${p} is granted but nothing checks it`).toContain(p);
    }
  });
});

describe('the roles that ship can still do their jobs', () => {
  /*
   * The risk in guarding a hundred endpoints at once is locking somebody out
   * of work they have always done. These name the acts each role exists for.
   */
  const role = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;

  it('lets a placement officer run their college end to end', () => {
    const officer = role('campus.officer');
    for (const p of [
      'batch:write',
      'student:write',
      'student:verify',
      'student:invite',
      'student:remove',
      'drive:write',
      'posting:decide',
      'team:manage',
    ] as Permission[]) {
      expect(officer, `a placement officer needs ${p}`).toContain(p);
    }
  });

  it('lets a data-entry clerk type a roster and nothing more', () => {
    const entry = role('campus.dataentry');

    expect(entry).toContain('student:write');
    expect(entry).not.toContain('student:verify');
    expect(entry).not.toContain('student:remove');
    expect(entry).not.toContain('drive:write');
    expect(entry).not.toContain('posting:decide');
  });

  it('lets a recruiter work the pipeline but never publish or offer', () => {
    const recruiter = role('company.recruiter');

    expect(recruiter).toContain('job:write');
    expect(recruiter).toContain('application:advance');
    expect(recruiter).not.toContain('job:publish');
    expect(recruiter).not.toContain('offer:make');
    expect(recruiter).not.toContain('company:profile');
  });

  it('lets an interviewer reach applications and nothing else', () => {
    const interviewer = role('company.interviewer');

    expect(interviewer).toEqual(['application:read', 'application:advance']);
  });

  it('gives the company profile only to the role that runs the account', () => {
    expect(role('company.owner')).toContain('company:profile');
    expect(role('company.hiringmanager')).not.toContain('company:profile');
    expect(SCOPE_PERMISSIONS.COMPANY).toContain('company:profile');

    // It is a company's own page, so no other world can hold it.
    expect(SCOPE_PERMISSIONS.CAMPUS).not.toContain('company:profile');
    expect(SCOPE_PERMISSIONS.ADMIN).not.toContain('company:profile');
  });

  it('lets an auditor read every list without holding a single write', () => {
    const auditor = role('admin.auditor');

    for (const p of [
      'college:read',
      'company:read',
      'batch:read',
      'student:read',
      'drive:read',
      'job:read',
      'application:read',
      'report:read',
    ] as Permission[]) {
      expect(auditor, `an auditor needs ${p} to open that screen`).toContain(p);
    }
  });
});
