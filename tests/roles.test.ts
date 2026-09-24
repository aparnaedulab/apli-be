import { describe, expect, it } from 'vitest';
import { RoleScope } from '@prisma/client';
import { db } from './setup.js';
import { defaultTenant, systemRole } from './factories.js';
import {
  ALL_PERMISSIONS,
  FULL_POWER_KEYS,
  SCOPE_PERMISSIONS,
  SYSTEM_ROLES,
  isPermission,
  scopeForRole,
  withinScope,
} from '../src/modules/roles/permissions.js';

/**
 * The permission model. What these hold is the thing that makes roles safe to
 * hand to a university: a role can never reach outside its own world, and the
 * roles that must keep working cannot be broken.
 */
describe('the permission catalogue', () => {
  it('gives every permission to exactly the worlds that can hold it', () => {
    const assigned = new Set(Object.values(SCOPE_PERMISSIONS).flat());

    // A permission in the catalogue that no scope can hold is unreachable -
    // it would refuse everybody forever, and nothing would say why.
    for (const p of ALL_PERMISSIONS) {
      expect(assigned.has(p)).toBe(true);
    }
  });

  it('keeps a college role out of the university and the company', () => {
    const kept = withinScope('CAMPUS', [
      'student:verify',
      'company:verify',
      'job:publish',
      'role:manage',
    ]);

    expect(kept).toEqual(['student:verify']);
  });

  it('drops anything that is not a permission at all', () => {
    expect(withinScope('ADMIN', ['college:write', 'not:a:permission', ''])).toEqual([
      'college:write',
    ]);
    expect(isPermission('student:verify')).toBe(true);
    expect(isPermission('student:invent')).toBe(false);
  });

  it('gives a candidate no world to hold a role in', () => {
    expect(scopeForRole('CANDIDATE')).toBeNull();
    expect(scopeForRole('CAMPUS')).toBe('CAMPUS');
    expect(scopeForRole('COMPANY')).toBe('COMPANY');
    expect(scopeForRole('ADMIN')).toBe('ADMIN');
  });
});

describe('the roles a deployment ships with', () => {
  it('never grants a permission outside its own scope', () => {
    for (const role of SYSTEM_ROLES) {
      const allowed = new Set(SCOPE_PERMISSIONS[role.scope]);
      for (const p of role.permissions) {
        expect(allowed.has(p), `${role.name} should not hold ${p}`).toBe(true);
      }
    }
  });

  it('has exactly one role per world that can do everything in it', () => {
    for (const scope of ['CAMPUS', 'COMPANY', 'ADMIN'] as const) {
      const full = SYSTEM_ROLES.filter(
        (r) => r.scope === scope && r.permissions.length === SCOPE_PERMISSIONS[scope].length,
      );

      expect(full).toHaveLength(1);
      expect(FULL_POWER_KEYS.has(full[0]!.key)).toBe(true);
    }
  });

  it('leaves verifying students to the officer, not the coordinator', () => {
    const officer = SYSTEM_ROLES.find((r) => r.key === 'campus.officer')!;
    const coordinator = SYSTEM_ROLES.find((r) => r.key === 'campus.coordinator')!;

    // Freezing a student is the eligibility gate - the college telling
    // recruiters a CGPA is real. Entering the roster is not the same act.
    expect(officer.permissions).toContain('student:verify');
    expect(coordinator.permissions).not.toContain('student:verify');
    expect(coordinator.permissions).toContain('student:write');
  });

  it('separates entering a student from vouching for one', () => {
    const entry = SYSTEM_ROLES.find((r) => r.key === 'campus.dataentry')!;
    const verifier = SYSTEM_ROLES.find((r) => r.key === 'campus.verifier')!;

    // The whole reason these two roles exist: one types, the other vouches.
    expect(entry.permissions).toContain('student:write');
    expect(entry.permissions).not.toContain('student:verify');

    expect(verifier.permissions).toContain('student:verify');
    expect(verifier.permissions).not.toContain('student:write');
  });

  it('separates adding a company from vetting one', () => {
    const onboarding = SYSTEM_ROLES.find((r) => r.key === 'admin.onboarding')!;
    const compliance = SYSTEM_ROLES.find((r) => r.key === 'admin.compliance')!;

    expect(onboarding.permissions).toContain('company:write');
    expect(onboarding.permissions).not.toContain('company:verify');

    expect(compliance.permissions).toContain('company:verify');
    expect(compliance.permissions).not.toContain('company:write');
  });

  it('lets a hiring manager publish where a recruiter cannot', () => {
    const manager = SYSTEM_ROLES.find((r) => r.key === 'company.hiringmanager')!;
    const recruiter = SYSTEM_ROLES.find((r) => r.key === 'company.recruiter')!;

    expect(manager.permissions).toContain('job:publish');
    expect(manager.permissions).toContain('offer:make');
    expect(manager.permissions).not.toContain('team:manage');

    expect(recruiter.permissions).not.toContain('job:publish');
    expect(recruiter.permissions).not.toContain('offer:make');
  });

  it('gives every viewer reads and nothing else', () => {
    for (const key of ['campus.viewer', 'company.viewer']) {
      const viewer = SYSTEM_ROLES.find((r) => r.key === key)!;
      expect(viewer.permissions.length).toBeGreaterThan(0);
      for (const p of viewer.permissions) {
        expect(p.endsWith(':read'), `${key} should not hold ${p}`).toBe(true);
      }
    }
  });

  it('lets an auditor export but never change anything', () => {
    const auditor = SYSTEM_ROLES.find((r) => r.key === 'admin.auditor')!;

    expect(auditor.permissions).toContain('report:export');
    expect(auditor.permissions).toContain('audit:read');

    const writes = auditor.permissions.filter(
      (p) => !p.endsWith(':read') && p !== 'report:export',
    );
    expect(writes).toEqual([]);
  });

  it('leaves publishing to the owner, not the recruiter', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'company.owner')!;
    const recruiter = SYSTEM_ROLES.find((r) => r.key === 'company.recruiter')!;

    expect(owner.permissions).toContain('job:publish');
    expect(recruiter.permissions).not.toContain('job:publish');
    expect(recruiter.permissions).toContain('job:write');
  });

  it('gives an interviewer no reach over roles or the team', () => {
    const interviewer = SYSTEM_ROLES.find((r) => r.key === 'company.interviewer')!;

    expect(interviewer.permissions).toEqual(['application:read', 'application:advance']);
  });

  it('gives a university admin no way to make itself a super admin', () => {
    const uni = SYSTEM_ROLES.find((r) => r.key === 'admin.university')!;

    // It can create college and company logins - that is its job - but not
    // roles, not settings, and not another operations account.
    expect(uni.permissions).toContain('login:manage');
    expect(uni.permissions).not.toContain('role:manage');
    expect(uni.permissions).not.toContain('account:suspend');
    expect(uni.permissions).not.toContain('settings:write');
  });

  it('gives exactly one role the power to create another operations login', () => {
    // `account:suspend` is what gates making an admin, so holding it is
    // holding the keys. Only the full-power role should.
    const holders = SYSTEM_ROLES.filter(
      (r) => r.scope === 'ADMIN' && r.permissions.includes('account:suspend'),
    );

    expect(holders.map((r) => r.key)).toEqual(['admin.super']);
  });
});

describe('roles in the database', () => {
  it('creates each system role with the permissions it was defined with', async () => {
    const role = await systemRole('campus.coordinator');

    expect(role.scope).toBe(RoleScope.CAMPUS);
    expect(role.isSystem).toBe(true);
    expect(role.permissions).toEqual(
      SYSTEM_ROLES.find((r) => r.key === 'campus.coordinator')!.permissions,
    );
  });

  it('holds two roles of the same name only in different worlds', async () => {
    await db.platformRole.create({
      data: { name: 'Viewer', scope: RoleScope.CAMPUS, permissions: ['roster:read'] },
    });

    // Same name, different world: fine.
    await expect(
      db.platformRole.create({
        data: { name: 'Viewer', scope: RoleScope.COMPANY, permissions: ['application:read'] },
      }),
    ).resolves.toBeDefined();

    // Same name, same world: not.
    await expect(
      db.platformRole.create({
        data: { name: 'Viewer', scope: RoleScope.CAMPUS, permissions: [] },
      }),
    ).rejects.toThrow();
  });

  it('will not let a role be deleted while somebody holds it', async () => {
    const role = await systemRole('campus.coordinator');
    const college = await db.college.create({
      data: {
        name: 'Test College',
        code: `TC${Date.now()}`,
        city: 'Pune',
        state: 'Maharashtra',
        tenantId: (await defaultTenant()).id,
      },
    });
    const user = await db.user.create({
      data: {
        email: `member-${Math.random()}@test.local`,
        fullName: 'A Member',
        passwordHash: 'x',
        role: 'CAMPUS',
      },
    });
    await db.campusMember.create({
      data: { userId: user.id, collegeId: college.id, roleId: role.id },
    });

    // The foreign key is the backstop; the route refuses first, with a reason.
    await expect(db.platformRole.delete({ where: { id: role.id } })).rejects.toThrow();
  });
});
