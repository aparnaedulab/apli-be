import { CompanyStatus, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';
import { toCompanyData, type CompanyProfileInput } from './company.schemas.js';

export interface RegistrationInput {
  company: CompanyProfileInput;
  contact: { fullName: string; email: string; password: string };
}

/**
 * A company signing itself up.
 *
 * The record arrives PENDING, which means it can be filled in and drafted
 * against but cannot publish anything. Two independent approvals still stand
 * between this and a student: operations verifying the company, and each
 * college approving each posting.
 *
 * The person registering sets their own password, which is not a departure
 * from the rule that nobody sets anybody else's - it is their own account, and
 * they are the one typing.
 */
export async function registerCompany(input: RegistrationInput) {
  const email = input.contact.email.trim().toLowerCase();
  const name = input.company.name.trim();

  // Checked before the transaction for a clean message, and again by the
  // unique indexes inside it, which are what actually prevent the race.
  const [nameTaken, emailTaken] = await Promise.all([
    prisma.company.findUnique({ where: { name }, select: { id: true, status: true } }),
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  ]);

  if (nameTaken) {
    throw conflict(
      `${name} is already registered. If this is your company, ask your colleague to invite you instead of signing up again.`,
    );
  }
  if (emailTaken) {
    throw conflict('An account with that email already exists. Sign in instead.');
  }

  const passwordHash = await hashPassword(input.contact.password);

  return prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        ...toCompanyData(input.company),
        name,
        status: CompanyStatus.PENDING,
        appliedAt: new Date(),
      },
    });

    const user = await tx.user.create({
      data: {
        email,
        fullName: input.contact.fullName.trim(),
        passwordHash,
        role: Role.COMPANY,
      },
    });

    // Whoever registers owns the account, and can invite the rest of their
    // team without waiting for the verification to come through.
    const owner = await tx.platformRole.findUniqueOrThrow({
      where: { key: 'company.owner' },
      select: { id: true },
    });
    await tx.companyMember.create({
      data: { userId: user.id, companyId: company.id, roleId: owner.id },
    });

    return { company, user };
  });
}
