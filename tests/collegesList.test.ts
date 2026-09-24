import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { db } from './setup.js';
import { defaultTenant, systemRole } from './factories.js';
import { collegeQuerySchema, listColleges } from '../src/modules/admin/colleges.list.js';
import { env } from '../src/config/env.js';

/**
 * The colleges screen. What these hold: the count is the real total rather
 * than the page length, filters resolve in SQL, and every filter narrows what
 * it claims to narrow.
 */
const query = (over: Record<string, unknown> = {}) => collegeQuerySchema.parse(over);

/** The list as the default test tenant sees it. */
const listIn = async (q: ReturnType<typeof query>) => listColleges(q, (await defaultTenant()).id);

async function makeCollege(over: Record<string, unknown> = {}) {
  return db.college.create({
    data: {
      name: `College ${Math.random()}`,
      code: `C${Math.floor(Math.random() * 1e9)}`,
      city: 'Pune',
      state: 'Maharashtra',
      tenantId: (await defaultTenant()).id,
      ...over,
    },
  });
}

async function giveOfficer(collegeId: string) {
  const user = await db.user.create({
    data: {
      email: `tpo-${Math.random()}@test.local`,
      fullName: 'Officer',
      passwordHash: 'x',
      role: Role.CAMPUS,
    },
  });
  await db.campusMember.create({
    data: { userId: user.id, collegeId, roleId: (await systemRole('campus.officer')).id },
  });
}

describe('listing colleges', () => {
  it('pages without lying about the total', async () => {
    for (let i = 0; i < 12; i++) await makeCollege();

    const first = await listIn(query({ limit: 5, page: 1 }));
    const last = await listIn(query({ limit: 5, page: 3 }));

    expect(first.colleges).toHaveLength(5);
    expect(first.total).toBe(12);
    expect(first.pages).toBe(3);

    expect(last.colleges).toHaveLength(2);
    expect(last.total).toBe(12);
  });

  it('returns no rows past the end, and still the right total', async () => {
    await makeCollege();

    const result = await listIn(query({ limit: 10, page: 9 }));

    expect(result.colleges).toEqual([]);
    expect(result.total).toBe(1);
  });

  it('never repeats or drops a college across pages', async () => {
    for (let i = 0; i < 9; i++) await makeCollege();

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const result = await listIn(query({ limit: 3, page }));
      seen.push(...result.colleges.map((c) => c.id));
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it('searches the name, the code and the city with one box', async () => {
    await makeCollege({ name: 'Fergusson College', code: 'FC', city: 'Pune' });
    await makeCollege({ name: 'Walchand College', code: 'WCE', city: 'Sangli' });

    expect((await listIn(query({ q: 'fergusson' }))).total).toBe(1);
    expect((await listIn(query({ q: 'WCE' }))).total).toBe(1);
    expect((await listIn(query({ q: 'Sangli' }))).total).toBe(1);
    expect((await listIn(query({ q: 'College' }))).total).toBe(2);
    expect((await listIn(query({ q: 'nothing here' }))).total).toBe(0);
  });

  it('filters by type', async () => {
    const engineering = await db.collegeType.create({ data: { name: 'Engineering' } });
    const law = await db.collegeType.create({ data: { name: 'Law' } });
    await makeCollege({ collegeTypeId: engineering.id });
    await makeCollege({ collegeTypeId: engineering.id });
    await makeCollege({ collegeTypeId: law.id });

    expect((await listIn(query({ typeId: engineering.id }))).total).toBe(2);
    expect((await listIn(query({ typeId: law.id }))).total).toBe(1);
  });

  it('tells affiliated colleges from autonomous ones', async () => {
    await makeCollege({ affiliation: env.HOME_UNIVERSITY });
    await makeCollege({ affiliation: 'Shivaji University' });
    await makeCollege({ affiliation: null });

    expect((await listIn(query({ affiliated: 'yes' }))).total).toBe(2);
    expect((await listIn(query({ affiliated: 'no' }))).total).toBe(1);
  });

  it('finds the colleges nobody can sign in to yet', async () => {
    const staffed = await makeCollege();
    await giveOfficer(staffed.id);
    await makeCollege();
    await makeCollege();

    const waiting = await listIn(query({ hasTeam: 'no' }));
    expect(waiting.total).toBe(2);
    expect(waiting.colleges.every((c) => c.memberCount === 0)).toBe(true);

    expect((await listIn(query({ hasTeam: 'yes' }))).total).toBe(1);
  });

  it('combines a search with a filter rather than choosing one', async () => {
    const engineering = await db.collegeType.create({ data: { name: 'Engineering' } });
    // Distinct cities, because the search box matches the city too - two of
    // these would otherwise match "Pune" on a column the test is not about.
    await makeCollege({
      name: 'Pune Engineering College',
      city: 'Pune',
      collegeTypeId: engineering.id,
    });
    await makeCollege({ name: 'Pune Law College', city: 'Nashik' });
    await makeCollege({
      name: 'Mumbai Engineering College',
      city: 'Mumbai',
      collegeTypeId: engineering.id,
    });

    const result = await listIn(query({ q: 'Pune', typeId: engineering.id }));

    expect(result.total).toBe(1);
    expect(result.colleges[0]!.name).toBe('Pune Engineering College');
  });

  it('sorts by name, and by student count', async () => {
    const a = await makeCollege({ name: 'Zeta College' });
    const b = await makeCollege({ name: 'Alpha College' });

    const user = await db.user.create({
      data: {
        email: `s-${Math.random()}@test.local`,
        fullName: 'Student',
        passwordHash: 'x',
        role: Role.CANDIDATE,
      },
    });
    await db.candidate.create({ data: { userId: user.id, collegeId: a.id } });

    const byName = await listIn(query({ sort: 'name' }));
    expect(byName.colleges.map((c) => c.name)).toEqual(['Alpha College', 'Zeta College']);

    const byStudents = await listIn(query({ sort: 'students' }));
    expect(byStudents.colleges[0]!.id).toBe(a.id);
    expect(byStudents.colleges[0]!.studentCount).toBe(1);
    expect(byStudents.colleges[1]!.id).toBe(b.id);
  });

  it('offers only filter values that would return something', async () => {
    const used = await db.collegeType.create({ data: { name: 'Engineering' } });
    await db.collegeType.create({ data: { name: 'Nobody Uses This' } });
    await makeCollege({ collegeTypeId: used.id, city: 'Pune' });
    await makeCollege({ city: 'Nashik' });

    const { filters } = await listIn(query());

    expect(filters.types.map((t) => t.name)).toEqual(['Engineering']);
    expect(filters.cities.map((c) => c.name).sort()).toEqual(['Nashik', 'Pune']);
    expect(filters.types[0]!.count).toBe(1);
  });

  it('describes the filter options for the whole portal, not the current page', async () => {
    const type = await db.collegeType.create({ data: { name: 'Engineering' } });
    for (let i = 0; i < 6; i++) await makeCollege({ collegeTypeId: type.id });

    const page = await listIn(query({ limit: 2, page: 1 }));

    expect(page.colleges).toHaveLength(2);
    expect(page.filters.types[0]!.count).toBe(6);
  });

  it('totals the students and batches under the colleges shown', async () => {
    const a = await makeCollege();
    const b = await makeCollege();
    await db.batch.create({
      data: {
        tenantId: a.tenantId,
        collegeId: a.id,
        name: 'CSE 2026',
        course: 'B.Tech',
        graduationYear: 2026,
      },
    });
    await db.batch.create({
      data: {
        tenantId: b.tenantId,
        collegeId: b.id,
        name: 'IT 2026',
        course: 'B.Tech',
        graduationYear: 2026,
      },
    });
    for (const college of [a, a, b]) {
      const user = await db.user.create({
        data: {
          email: `s-${Math.random()}@test.local`,
          fullName: 'Student',
          passwordHash: 'x',
          role: Role.CANDIDATE,
        },
      });
      await db.candidate.create({ data: { userId: user.id, collegeId: college.id } });
    }

    const { summary } = await listIn(query());

    expect(summary).toMatchObject({ colleges: 2, students: 3, batches: 2, withoutTeam: 2 });
  });

  it('narrows the totals with the filter, so they answer the question you asked', async () => {
    const engineering = await db.collegeType.create({ data: { name: 'Engineering' } });
    const eng = await makeCollege({ collegeTypeId: engineering.id });
    const other = await makeCollege();
    await giveOfficer(eng.id);

    for (const college of [eng, other]) {
      const user = await db.user.create({
        data: {
          email: `s-${Math.random()}@test.local`,
          fullName: 'Student',
          passwordHash: 'x',
          role: Role.CANDIDATE,
        },
      });
      await db.candidate.create({ data: { userId: user.id, collegeId: college.id } });
    }

    expect((await listIn(query())).summary).toMatchObject({
      colleges: 2,
      students: 2,
      withoutTeam: 1,
    });

    expect((await listIn(query({ typeId: engineering.id }))).summary).toMatchObject({
      colleges: 1,
      students: 1,
      withoutTeam: 0,
    });
  });
});

describe('the college routes the screens depend on', () => {
  /*
   * A regression test with a story: extracting the list query silently took
   * the create handler with it, and nothing noticed until a page tried to use
   * it. These assert the routes exist and are wired, which typechecking
   * cannot tell you.
   */
  it('mounts every route the admin screens call', async () => {
    const { collegesRouter } = await import('../src/modules/admin/colleges.routes.js');

    const mounted = collegesRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => {
        const route = layer.route as unknown as {
          path: string;
          methods: Record<string, boolean>;
        };
        return `${Object.keys(route.methods)[0]!.toUpperCase()} ${route.path}`;
      });

    for (const route of [
      'GET /',
      'POST /',
      'POST /bulk',
      'GET /bulk/template',
      'POST /bulk/file',
      'GET /:id',
      'PATCH /:id',
      'GET /:id/batches',
      'POST /:id/batches',
      'POST /:id/students',
      'GET /:id/students/template',
      'POST /:id/invites',
    ]) {
      expect(mounted).toContain(route);
    }
  });

  it('mounts the batch routes operations reaches every batch through', async () => {
    const { adminRouter } = await import('../src/modules/admin/admin.routes.js');

    const mounted = adminRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => {
        const route = layer.route as unknown as {
          path: string;
          methods: Record<string, boolean>;
        };
        return `${Object.keys(route.methods)[0]!.toUpperCase()} ${route.path}`;
      });

    for (const route of [
      'GET /meta',
      'POST /batches',
      'GET /batches/:id',
      'POST /batches/:id/students',
      'GET /batches/:id/students/template',
    ]) {
      expect(mounted).toContain(route);
    }
  });
});
