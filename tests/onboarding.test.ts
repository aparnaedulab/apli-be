import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SessionData } from 'express-session';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { makeCollege, makeTenant, systemRole } from './factories.js';
import { saveFeatures } from '../src/modules/tenants/onboarding.service.js';
import { platformRouter } from '../src/modules/tenants/platform.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { CORE_KEYS, planFor, PLANS, resolveModules } from '../src/modules/tenants/catalogue.js';

/**
 * Onboarding an institution, end to end, through the real router.
 *
 * The rules worth a test are the ones a demo would not show: that launch
 * refuses while anything required is missing, that the console is closed to
 * an institution's own admins, and that choosing one module quietly brings
 * the ones it cannot work without.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

type Session = Partial<SessionData>;

function appFor(session: Session) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Session }).session = { ...session };
    next();
  });
  app.use('/platform', platformRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

async function operations(tenantId: string | null) {
  const user = await db.user.create({
    data: { email: `ops-${Math.random()}@test.local`, fullName: 'Platform Ops', passwordHash: 'x', role: Role.ADMIN },
  });
  await db.adminMember.create({
    data: { userId: user.id, roleId: (await systemRole('admin.super')).id, tenantId },
  });
  return user;
}

async function platformCaller() {
  const user = await operations(null);
  return appFor({ userId: user.id, role: Role.ADMIN, isPlatform: true });
}

const identity = (over: Record<string, unknown> = {}) => ({
  name: 'Deccan Technical University',
  shortName: 'DTU',
  slug: 'dtu',
  kind: 'UNIVERSITY',
  legalName: '',
  website: '',
  logoUrl: '',
  brandColor: '#8b1d2c',
  tagline: '',
  city: 'Pune',
  state: 'Maharashtra',
  address: '',
  pincode: '',
  contactName: 'Registrar',
  contactEmail: 'registrar@dtu.test',
  contactPhone: '',
  ...over,
});

describe('the module catalogue', () => {
  it('always includes the core, and pulls in what a module needs, transitively', () => {
    const { enabled, added } = resolveModules(['dev.gd']);
    for (const k of CORE_KEYS) expect(enabled).toContain(k);
    expect(enabled).toEqual(expect.arrayContaining(['dev.gd', 'dev.mockInterview', 'dev.readiness']));
    expect(added).toEqual(['dev.readiness', 'dev.mockInterview']);
  });

  it('drops keys it has never heard of', () => {
    expect(resolveModules(['nope.nothing']).enabled).toEqual(CORE_KEYS);
  });

  it('names a plan only when the selection is exactly that plan', () => {
    const growth = PLANS.find((p) => p.key === 'GROWTH')!;
    const resolved = resolveModules(growth.modules).enabled;
    expect(planFor(resolved)).toBe('GROWTH');
    expect(planFor(resolved.filter((k) => k !== 'ops.atRisk'))).toBe('CUSTOM');
  });
});

describe('onboarding an institution', () => {
  it('walks every step and launches', async () => {
    const call = await platformCaller();
    const course = await db.course.create({ data: { name: `B.Tech ${Math.random()}` } });
    const master = await db.branch.create({ data: { name: `Computer ${Math.random()}` } });
    const branch = await db.specialisation.create({
      data: { name: master.name, courseId: course.id, branchId: master.id },
    });
    await systemRole('campus.officer');

    const created = await call('POST', '/platform/tenants', identity());
    expect(created.status).toBe(201);
    const id = created.body.tenant.id as string;
    expect(created.body.tenant.status).toBe('DRAFT');

    const academics = await call('PUT', `/platform/tenants/${id}/academics`, {
      gradingScale: 'CGPA_10',
      academicYearStartMonth: 6,
      oneOfferDefault: true,
      allowSelfJoin: false,
      programs: [{ courseId: course.id, specialisationIds: [branch.id] }],
    });
    expect(academics.status).toBe(200);
    expect(academics.body.programs[0].specialisationIds).toEqual([branch.id]);

    const colleges = await call('PUT', `/platform/tenants/${id}/colleges`, {
      colleges: [
        {
          name: 'Deccan College of Engineering',
          code: 'dce',
          city: 'Pune',
          state: 'Maharashtra',
          courses: [course.name],
          officerName: 'S. Joshi',
          officerEmail: 'tpo@dce.test',
        },
      ],
      passingYears: [2027, 2028],
    });
    expect(colleges.status).toBe(200);
    expect(colleges.body.result.batchesCreated).toBe(2);
    expect(colleges.body.result.invites).toHaveLength(1);
    expect(colleges.body.colleges[0].code).toBe('DCE');
    expect(colleges.body.colleges[0].officer.status).toBe('invited');

    // Saving the same list again creates nothing twice.
    const again = await call('PUT', `/platform/tenants/${id}/colleges`, {
      colleges: [{ ...colleges.body.colleges[0], courses: [course.name], officerName: '', officerEmail: 'tpo@dce.test', collegeTypeId: '', naacGrade: '' }],
      passingYears: [2027, 2028],
    });
    expect(again.status).toBe(200);
    expect(again.body.result.batchesCreated).toBe(0);
    expect(again.body.result.invites).toHaveLength(0);

    const features = await call('PUT', `/platform/tenants/${id}/features`, { selected: ['dev.aptitude'] });
    expect(features.status).toBe(200);
    expect(features.body.result.added).toEqual(['dev.readiness']);
    expect(features.body.modules).toEqual(expect.arrayContaining([...CORE_KEYS, 'dev.aptitude', 'dev.readiness']));

    const early = await call('POST', `/platform/tenants/${id}/launch`);
    expect(early.status).toBe(409);
    expect(early.body.error.details.missing).toEqual(['people']);

    const admin = await call('POST', `/platform/tenants/${id}/admins`, {
      fullName: 'Registrar',
      email: 'registrar@dtu.test',
      sendEmail: false,
    });
    expect(admin.status).toBe(201);
    expect(admin.body.result.link).toMatch(/\/invite\//);

    const invite = await db.invite.findFirstOrThrow({ where: { email: 'registrar@dtu.test' } });
    expect(invite.tenantId).toBe(id);

    const launched = await call('POST', `/platform/tenants/${id}/launch`);
    expect(launched.status).toBe(200);
    expect(launched.body.tenant.status).toBe('ACTIVE');
    expect(launched.body.tenant.completedSteps).toHaveLength(8);

    const batches = await db.batch.findMany({ where: { tenantId: id } });
    expect(batches.map((b) => b.name).sort()).toEqual([`${course.name} 2027`, `${course.name} 2028`]);
  });

  it('refuses an address that is taken, and offers a free one', async () => {
    const call = await platformCaller();
    await makeTenant('Someone else', { slug: 'dtu' });
    const res = await call('POST', '/platform/tenants', identity());
    expect(res.status).toBe(409);
    expect(res.body.error.details.suggestion).toBe('dtu-2');
  });

  it('refuses a college code another institution already uses', async () => {
    const call = await platformCaller();
    const other = await makeTenant('Other University');
    await makeCollege('Existing College', other.id).then((c) => db.college.update({ where: { id: c.id }, data: { code: 'TAKEN' } }));
    const { body } = await call('POST', '/platform/tenants', identity({ slug: 'fresh-one' }));

    const res = await call('PUT', `/platform/tenants/${body.tenant.id}/colleges`, {
      colleges: [{ name: 'New College', code: 'TAKEN', city: 'Pune', state: 'Maharashtra' }],
      passingYears: [],
    });
    expect(res.status).toBe(409);
    expect(await db.college.count({ where: { tenantId: body.tenant.id } })).toBe(0);
  });

  it('keeps a single-college institution to one college', async () => {
    const call = await platformCaller();
    const { body } = await call('POST', '/platform/tenants', identity({ slug: 'solo', kind: 'COLLEGE' }));
    const res = await call('PUT', `/platform/tenants/${body.tenant.id}/colleges`, {
      colleges: [
        { name: 'One', code: 'ONE', city: 'Pune', state: 'Maharashtra' },
        { name: 'Two', code: 'TWO', city: 'Pune', state: 'Maharashtra' },
      ],
      passingYears: [],
    });
    expect(res.status).toBe(400);
  });
});

describe('branches first, then courses', () => {
  it('keeps one spelling per branch and catches look-alikes', async () => {
    const call = await platformCaller();
    const tag = Math.random().toString(36).slice(2, 6);

    const first = await call('POST', '/platform/branches', { name: `Mechanical Engineering ${tag}` });
    expect(first.status).toBe(201);

    // Same name, different case: the same branch, not a second one.
    const same = await call('POST', '/platform/branches', { name: `mechanical engineering ${tag}` });
    expect(same.status).toBe(200);
    expect(same.body.branch.id).toBe(first.body.branch.id);

    // A short form of it is caught and named.
    const lookalike = await call('POST', '/platform/branches', { name: `Mech Engg ${tag}` });
    expect(lookalike.status).toBe(409);
    expect(lookalike.body.error.details.similar[0].id).toBe(first.body.branch.id);

    // ...and a typo too.
    const typo = await call('POST', '/platform/branches', { name: `Mechancal Engineering ${tag}` });
    expect(typo.status).toBe(409);

    // A person can still insist it is different.
    const forced = await call('POST', '/platform/branches', { name: `Mech Engg ${tag}`, confirm: true });
    expect(forced.status).toBe(201);
  });

  it('builds a course from master branches, spelt exactly as the master list', async () => {
    const call = await platformCaller();
    const tag = Math.random().toString(36).slice(2, 6);
    const cse = (await call('POST', '/platform/branches', { name: `Computer Science ${tag}` })).body.branch;
    const civil = (await call('POST', '/platform/branches', { name: `Civil ${tag}` })).body.branch;

    const name = `B.Voc ${tag}`;
    const created = await call('POST', '/platform/courses', { name, branchIds: [cse.id] });
    expect(created.status).toBe(201);
    expect(created.body.course.specialisations).toEqual([
      expect.objectContaining({ name: cse.name, branchId: cse.id }),
    ]);

    // Adding the same course name again adds branches instead of a duplicate.
    const again = await call('POST', '/platform/courses', { name: name.toUpperCase(), branchIds: [civil.id, cse.id] });
    expect(again.status).toBe(200);
    expect(again.body.course.id).toBe(created.body.course.id);
    expect(again.body.course.specialisations).toHaveLength(2);
    expect(await db.course.count({ where: { name } })).toBe(1);

    // A branch that is not on the master list is refused, not invented.
    const stray = await call('POST', `/platform/courses/${created.body.course.id}/branches`, { branchIds: ['nope'] });
    expect(stray.status).toBe(400);
  });

  it('saves the courses step without grading or academic year', async () => {
    const call = await platformCaller();
    const { body } = await call('POST', '/platform/tenants', identity({ slug: 'no-grading' }));
    const course = await db.course.create({ data: { name: `BBA ${Math.random()}` } });
    const res = await call('PUT', `/platform/tenants/${body.tenant.id}/academics`, {
      oneOfferDefault: true,
      allowSelfJoin: true,
      programs: [{ courseId: course.id, specialisationIds: [] }],
    });
    expect(res.status).toBe(200);
    expect(res.body.tenant.gradingScale).toBe('CGPA_10');
  });
});

describe('adding in bulk', () => {
  it('adds a pasted branch list, holding back look-alikes - even of each other', async () => {
    const call = await platformCaller();
    const t = Math.random().toString(36).slice(2, 6);
    const res = await call('POST', '/platform/branches/bulk', {
      names: [`Aerospace ${t}`, `aerospace ${t}`, `Biotechnology ${t}`, `Biotech ${t}`, '', 'X'],
    });
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.results.map((r: { name: string; status: string }) => [r.name, r.status]));
    expect(byName[`Aerospace ${t}`]).toBe('added');
    expect(byName[`aerospace ${t}`]).toBe('existed');
    expect(byName[`Biotechnology ${t}`]).toBe('added');
    expect(byName[`Biotech ${t}`]).toBe('similar');
    expect(byName['X']).toBe('invalid');
    expect(res.body.added).toBe(2);
  });

  it('previews a pasted course list, then saves exactly what it previewed', async () => {
    const call = await platformCaller();
    const t = Math.random().toString(36).slice(2, 6);
    await call('POST', '/platform/branches', { name: `Mechanical ${t}` });
    const rows = [
      { course: `M.Tech ${t}`, branches: [`mechanical ${t}`, `Mechancal ${t}`, `Robotics ${t}`] },
      { course: `m.tech ${t}`, branches: [`Robotics ${t}`] },
    ];

    const preview = await call('POST', '/platform/courses/bulk', { rows });
    expect(preview.body.preview).toBe(true);
    expect(preview.body.summary).toMatchObject({ courses: 1, newCourses: 1, mapped: 1, missing: 1, newBranches: 0 });
    expect(await db.course.count({ where: { name: `M.Tech ${t}` } })).toBe(0);

    const saved = await call('POST', '/platform/courses/bulk', { rows, addMissingBranches: true, preview: false });
    expect(saved.body.summary).toMatchObject({ newBranches: 1, missing: 0 });
    const names = saved.body.courses[0].specialisations.map((s: { name: string }) => s.name).sort();
    // The typo became the real branch; the unknown one was added once.
    expect(names).toEqual([`Mechanical ${t}`, `Robotics ${t}`]);
    expect(await db.branch.count({ where: { name: `Robotics ${t}` } })).toBe(1);
  });
});

describe('colleges one by one, then batches', () => {
  const college = (over: Record<string, unknown> = {}) => ({
    name: 'Demo College of Engineering',
    code: `DCE${Math.floor(Math.random() * 1e6)}`,
    city: 'Demo City',
    state: 'Maharashtra',
    affiliation: 'THIS_UNIVERSITY',
    pincode: '000000',
    ...over,
  });

  it('adds a college with every field, affiliated to the university by default', async () => {
    const call = await platformCaller();
    const { body } = await call('POST', '/platform/tenants', identity({ slug: `one-${Math.random().toString(36).slice(2, 7)}` }));
    const id = body.tenant.id;

    const res = await call('POST', `/platform/tenants/${id}/colleges`, college({ address: 'Demo Road', naacGrade: 'A', isVerified: true }));
    expect(res.status).toBe(201);
    const saved = res.body.colleges[0];
    expect(saved).toMatchObject({ affiliation: 'Deccan Technical University', address: 'Demo Road', isVerified: true });
    expect(res.body.tenant.completedSteps).toContain('colleges');

    const bad = await call('POST', `/platform/tenants/${id}/colleges`, college({ pincode: '12', affiliation: 'OTHER' }));
    expect(bad.status).toBe(400);

    const clash = await call('POST', `/platform/tenants/${id}/colleges`, college({ code: saved.code }));
    expect(clash.status).toBe(409);
  });

  it('makes a university-wide batch once, and a per-college batch in each college', async () => {
    const call = await platformCaller();
    const { body } = await call('POST', '/platform/tenants', identity({ slug: `bt-${Math.random().toString(36).slice(2, 7)}` }));
    const id = body.tenant.id;
    await call('POST', `/platform/tenants/${id}/colleges`, college());
    await call('POST', `/platform/tenants/${id}/colleges`, college({ name: 'Second Demo College' }));

    const wide = await call('POST', `/platform/tenants/${id}/batches`, { scope: 'UNIVERSITY', name: '2026 Batch', graduationYear: 2026 });
    expect(wide.status).toBe(201);
    expect(wide.body.result.created).toHaveLength(1);
    expect(wide.body.batches[0]).toMatchObject({ name: '2026 Batch', collegeId: null });

    const again = await call('POST', `/platform/tenants/${id}/batches`, { scope: 'UNIVERSITY', name: '2026 Batch' });
    expect(again.body.result.skipped).toHaveLength(1);

    const each = await call('POST', `/platform/tenants/${id}/batches`, { scope: 'ALL_COLLEGES', course: 'B.Tech', graduationYear: 2026 });
    expect(each.body.result.created.map((b: { name: string }) => b.name)).toEqual(['B.Tech 2025-2026', 'B.Tech 2025-2026']);
    expect(each.body.tenant.completedSteps).toContain('batches');

    const empty = await call('POST', `/platform/tenants/${id}/batches`, { scope: 'UNIVERSITY' });
    expect(empty.status).toBe(400);

    const gone = await call('DELETE', `/platform/tenants/${id}/batches/${wide.body.batches[0].id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.batches).toHaveLength(2);
  });

  it('lets batches be skipped, and never blocks launch on them', async () => {
    const call = await platformCaller();
    const { body } = await call('POST', '/platform/tenants', identity({ slug: `sk-${Math.random().toString(36).slice(2, 7)}` }));
    const skipped = await call('POST', `/platform/tenants/${body.tenant.id}/steps/batches/complete`);
    expect(skipped.body.tenant.completedSteps).toContain('batches');
    expect(skipped.body.checklist.find((c: { step: string }) => c.step === 'batches').required).toBe(false);
    expect((await call('POST', `/platform/tenants/${body.tenant.id}/steps/features/complete`)).status).toBe(400);
  });
});

describe('the contact us details', () => {
  it('saves what students and recruiters will see, and refuses a phone that is not one', async () => {
    const call = await platformCaller();
    const bad = await call('POST', '/platform/tenants', identity({ slug: 'contact-bad', supportPhone: 'call me' }));
    expect(bad.status).toBe(400);

    const ok = await call(
      'POST',
      '/platform/tenants',
      identity({
        slug: 'contact-ok',
        supportEmail: 'Placements@demo-university.example',
        supportPhone: '+91 90000 00000',
        supportWhatsapp: '+91 90000 00000',
        officeHours: 'Mon-Fri, 10:00-17:30',
      }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.tenant.supportEmail).toBe('placements@demo-university.example');
    expect(ok.body.tenant.officeHours).toBe('Mon-Fri, 10:00-17:30');
  });
});

describe('the platform console', () => {
  it('is closed to an institution’s own admins', async () => {
    const tenant = await makeTenant();
    const user = await operations(tenant.id);
    const call = appFor({ userId: user.id, role: Role.ADMIN, tenantId: tenant.id });

    expect((await call('GET', '/platform/tenants')).status).toBe(403);
    expect((await call('POST', '/platform/tenants', identity({ slug: 'sneaky' }))).status).toBe(403);
    expect(await db.tenant.count({ where: { slug: 'sneaky' } })).toBe(0);
  });

  it('lets the platform team step into an institution and out again', async () => {
    const call = await platformCaller();
    const tenant = await makeTenant('Stepping Stone University');
    // act-as re-reads the account; the planted session is enough for the rest.
    const res = await call('POST', '/platform/act-as', { tenantId: tenant.id });
    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe(tenant.id);
    expect((await call('POST', '/platform/act-as', { tenantId: 'no-such-tenant' })).status).toBe(404);
  });
});

describe('where features live', () => {
  it('puts every module on a real screen for each audience it serves', async () => {
    const { MODULES: all, MODULE_SCREENS: homes, SCREENS: screens } = await import('../src/modules/tenants/catalogue.js');
    for (const m of all) {
      for (const a of m.audience) {
        const screen = homes[m.key]?.[a];
        expect(screen, `${m.key} has no screen for ${a}`).toBeDefined();
        expect(screens[a].some((sc) => sc.key === screen), `${m.key} -> ${a}:${screen}`).toBe(true);
      }
    }
  });

  it('takes the recruiter-access answer given on the features step', async () => {
    const tenant = await db.tenant.create({
      data: { name: `Feature University ${Math.random()}`, slug: `feat-${Math.random()}`.slice(0, 24) },
    });

    await saveFeatures(tenant.id, ['core.roster'], { unverifiedCompanyAccess: true });
    expect(
      (await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unverifiedCompanyAccess,
    ).toBe(true);

    // Saving the step again without an answer leaves the institution's alone.
    await saveFeatures(tenant.id, ['core.roster']);
    expect(
      (await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unverifiedCompanyAccess,
    ).toBe(true);
  });
});
