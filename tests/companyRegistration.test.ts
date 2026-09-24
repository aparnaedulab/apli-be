import { beforeEach, describe, expect, it } from 'vitest';
import { CompanyStatus, Role, TenantStatus } from '@prisma/client';
import { db } from './setup.js';
import { registerCompany } from '../src/modules/company/registration.service.js';
import { authenticate, getActiveUser, hashPassword } from '../src/modules/auth/auth.service.js';
import { canPublish } from '../src/modules/company/verification.js';
import { publishReadiness } from '../src/modules/jobs/job.service.js';
import { makeJob, makeRecruiter, systemRole } from './factories.js';
import { companyProfileSchema, companyRegistrationSchema } from '../src/modules/company/company.schemas.js';

/**
 * Registration is the only open door on the platform. These tests hold the two
 * things that make leaving it open safe: what arrives is inert, and it takes a
 * person to change that.
 */
// Registration hands the founder the Owner role, so it has to exist. Every
// test starts from an empty database, so it is made rather than assumed.
beforeEach(async () => {
  await systemRole('company.owner');
});

const registration = (over: Record<string, unknown> = {}) => ({
  company: { name: `Trellix ${Math.random()}`, city: 'Pune', ...(over.company as object) },
  contact: {
    fullName: 'Rhea Kapoor',
    email: `rhea-${Math.random()}@trellix.example`,
    password: 'TrellixHiring2026',
    ...(over.contact as object),
  },
});

describe('a company registering itself', () => {
  it('arrives pending, not verified', async () => {
    const { company } = await registerCompany(registration());

    expect(company.status).toBe(CompanyStatus.PENDING);
    expect(canPublish(company.status)).toBe(false);
    expect(company.appliedAt).not.toBeNull();
  });

  it('makes whoever registered the owner', async () => {
    const { company, user } = await registerCompany(registration());

    expect(user.role).toBe(Role.COMPANY);
    const member = await db.companyMember.findUnique({
      where: { userId: user.id },
      include: { role: { select: { key: true } } },
    });
    expect(member?.companyId).toBe(company.id);
    expect(member?.role.key).toBe('company.owner');
  });

  it('will not publish a role while it is pending', async () => {
    const { company, user } = await registerCompany(registration());
    const job = await makeJob(company.id, user.id);

    const check = await publishReadiness(job.id);

    expect(check.ok).toBe(false);
    expect(check.problems).toContain(
      'Your company has not been verified yet, so it cannot publish roles.',
    );
  });

  it('publishes once a person verifies it', async () => {
    const { company, user } = await registerCompany(registration());
    const job = await makeJob(company.id, user.id);

    await db.company.update({
      where: { id: company.id },
      data: { status: CompanyStatus.VERIFIED },
    });

    const check = await publishReadiness(job.id);
    expect(check.problems).not.toContain(
      'Your company has not been verified yet, so it cannot publish roles.',
    );
  });

  it('refuses a name that is already taken', async () => {
    const first = registration();
    await registerCompany(first);

    await expect(
      registerCompany({ ...registration(), company: first.company }),
    ).rejects.toThrow(/already registered/i);
  });

  it('refuses an email that already has an account', async () => {
    const first = registration();
    await registerCompany(first);

    await expect(
      registerCompany({ ...registration(), contact: first.contact }),
    ).rejects.toThrow(/already exists/i);
  });

  it('creates nothing at all when the contact clashes', async () => {
    const first = registration();
    await registerCompany(first);

    const before = await db.company.count();
    await expect(
      registerCompany({ company: { name: 'A Wholly New Name' }, contact: first.contact } as never),
    ).rejects.toThrow();

    // The company must not survive a failed contact: a half-made registration
    // would sit in the queue with nobody able to sign in to it.
    expect(await db.company.count()).toBe(before);
  });

  it('stores no recoverable password', async () => {
    const reg = registration();
    const { user } = await registerCompany(reg);

    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toContain(reg.contact.password);
    expect(stored.passwordHash.startsWith('$argon2')).toBe(true);
  });
});

describe('the publishing gate', () => {
  it('opens for exactly one status', async () => {
    const opens = Object.values(CompanyStatus).filter(canPublish);
    expect(opens).toEqual([CompanyStatus.VERIFIED]);
  });

  it('closes again when a verified company is suspended', async () => {
    const company = await db.company.create({
      data: { name: `Suspended ${Math.random()}`, status: CompanyStatus.VERIFIED },
    });
    const recruiter = await makeRecruiter(company.id);
    const job = await makeJob(company.id, recruiter.id);

    await db.company.update({
      where: { id: company.id },
      data: { status: CompanyStatus.SUSPENDED },
    });

    const check = await publishReadiness(job.id);
    expect(check.problems).toContain(
      'Your company has not been verified yet, so it cannot publish roles.',
    );
  });
});

/**
 * What a company signing itself up must answer.
 *
 * Nobody vouches for a stranger, so the details the review is actually read
 * from are asked for at sign-up rather than chased afterwards. Operations
 * entering a company by hand is a different matter, and keeps the lenient
 * profile schema.
 */
describe('what registration insists on', () => {
  const full = {
    name: 'Demo Harvesters',
    legalName: 'Demo Harvesters Private Limited',
    industryId: 'ind_1',
    sizeBand: 'SMALL',
    foundedYear: '2019',
    gstin: '27AABCT1332L1ZT',
    cin: 'U72900PN2018PTC176543',
    address: 'Level 2, Demo Park, Baner',
  };

  it('accepts a company that answered everything', () => {
    expect(companyRegistrationSchema.safeParse(full).success).toBe(true);
  });

  it('takes a typed industry in place of one off the list', () => {
    const { industryId, ...rest } = full;
    const parsed = companyRegistrationSchema.safeParse({ ...rest, industryOther: 'Agricultural machinery' });
    expect(parsed.success).toBe(true);
  });

  for (const field of ['legalName', 'sizeBand', 'foundedYear', 'gstin', 'cin', 'address'] as const) {
    it(`refuses a registration with no ${field}`, () => {
      const { [field]: _gone, ...rest } = full;
      const parsed = companyRegistrationSchema.safeParse(rest);
      expect(parsed.success).toBe(false);
    });
  }

  it('refuses a registration with no industry at all', () => {
    const { industryId: _gone, ...rest } = full;
    expect(companyRegistrationSchema.safeParse(rest).success).toBe(false);
  });

  it('still lets operations enter a company with just a name', () => {
    expect(companyProfileSchema.safeParse({ name: 'Known By Reputation' }).success).toBe(true);
  });
});

/**
 * Registering is not being let in.
 *
 * A stranger who has typed their details is still a stranger: until
 * operations has verified the company there is nothing inside for them, and a
 * portal that opens anyway would say we had accepted them.
 */
describe('signing in before the review', () => {
  async function companyUser(status: CompanyStatus, rejectionReason?: string) {
    const company = await db.company.create({
      data: { name: `Waiting ${Math.random()}`, status, ...(rejectionReason ? { rejectionReason } : {}) },
    });
    const user = await db.user.create({
      data: {
        email: `hr-${Math.random()}@demo-company.example`,
        fullName: 'Demo HR',
        passwordHash: await hashPassword('Test@Apli2026!'),
        role: Role.COMPANY,
      },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, roleId: (await systemRole('company.owner')).id },
    });
    return user;
  }

  it('refuses a company that is still waiting, and says so', async () => {
    const user = await companyUser(CompanyStatus.PENDING);
    await expect(authenticate(user.email, 'Test@Apli2026!')).rejects.toThrow(/still being reviewed/i);
  });

  it('refuses a rejected company, with the reason it was given', async () => {
    const user = await companyUser(CompanyStatus.REJECTED, 'We could not find your registration.');
    await expect(authenticate(user.email, 'Test@Apli2026!')).rejects.toThrow(
      /could not find your registration/i,
    );
  });

  it('lets a waiting company in when an institution asked for that', async () => {
    const user = await companyUser(CompanyStatus.PENDING);
    await expect(authenticate(user.email, 'Test@Apli2026!')).rejects.toThrow(/still being reviewed/i);

    // The institution's own answer, given during onboarding.
    await db.tenant.create({
      data: {
        name: `Open University ${Math.random()}`,
        slug: `open-${Math.random()}`.slice(0, 24),
        status: TenantStatus.ACTIVE,
        unverifiedCompanyAccess: true,
      },
    });

    await expect(authenticate(user.email, 'Test@Apli2026!')).resolves.toMatchObject({ id: user.id });
  });

  it('does not count an institution that has not launched', async () => {
    const user = await companyUser(CompanyStatus.PENDING);
    await db.tenant.create({
      data: {
        name: `Draft University ${Math.random()}`,
        slug: `draft-${Math.random()}`.slice(0, 24),
        status: TenantStatus.DRAFT,
        unverifiedCompanyAccess: true,
      },
    });

    await expect(authenticate(user.email, 'Test@Apli2026!')).rejects.toThrow(/still being reviewed/i);
  });

  it('never opens the door to a rejected or suspended company', async () => {
    await db.tenant.create({
      data: {
        name: `Open University ${Math.random()}`,
        slug: `open2-${Math.random()}`.slice(0, 24),
        status: TenantStatus.ACTIVE,
        unverifiedCompanyAccess: true,
      },
    });

    const rejected = await companyUser(CompanyStatus.REJECTED, 'No registration found.');
    await expect(authenticate(rejected.email, 'Test@Apli2026!')).rejects.toThrow(/no registration found/i);

    const suspended = await companyUser(CompanyStatus.SUSPENDED);
    await expect(authenticate(suspended.email, 'Test@Apli2026!')).rejects.toThrow(/suspended/i);
  });

  it('lets them in once verified', async () => {
    const user = await companyUser(CompanyStatus.VERIFIED);
    await expect(authenticate(user.email, 'Test@Apli2026!')).resolves.toMatchObject({ id: user.id });
  });

  it('refuses a suspended company too', async () => {
    const user = await companyUser(CompanyStatus.SUSPENDED, 'Students reported a fee demand.');
    await expect(authenticate(user.email, 'Test@Apli2026!')).rejects.toThrow(/suspended/i);
  });

  it('ends the session of a company rejected while it was signed in', async () => {
    const user = await companyUser(CompanyStatus.VERIFIED);
    await expect(getActiveUser(user.id)).resolves.toMatchObject({ id: user.id });

    const member = await db.companyMember.findFirstOrThrow({ where: { userId: user.id } });
    await db.company.update({
      where: { id: member.companyId },
      data: { status: CompanyStatus.REJECTED, rejectionReason: 'Not a real company.' },
    });

    await expect(getActiveUser(user.id)).rejects.toThrow(/not a real company/i);
  });
});
