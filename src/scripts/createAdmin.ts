/**
 * Creates (or resets the password of) the super admin.
 *
 * There is no public sign-up for this role by design - the first account has
 * to come from somewhere trusted, and that is the command line.
 *
 *   npm run create:admin
 *
 * Reads ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD from the environment.
 * If ADMIN_PASSWORD is not set, a strong one is generated and printed once.
 */
import { randomBytes } from 'node:crypto';
import 'dotenv/config';
import { Role, RoleScope } from '@prisma/client';
import { prisma, disconnectPrisma } from '../lib/prisma.js';
import { hashPassword } from '../modules/auth/auth.service.js';
import { SYSTEM_ROLES } from '../modules/roles/permissions.js';

function generatePassword(): string {
  // base64url of 18 bytes -> 24 characters, no ambiguous punctuation
  return randomBytes(18).toString('base64url');
}

async function main(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? 'admin@apli.example').trim().toLowerCase();
  const fullName = process.env.ADMIN_NAME ?? 'Super Admin';
  const supplied = process.env.ADMIN_PASSWORD;
  const password = supplied && supplied.length > 0 ? supplied : generatePassword();

  if (password.length < 12) {
    console.error('ADMIN_PASSWORD must be at least 12 characters.');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  const existing = await prisma.user.findUnique({ where: { email } });

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: Role.ADMIN, isActive: true, fullName },
    create: { email, fullName, passwordHash, role: Role.ADMIN },
  });

  /*
   * The role, not just the account type.
   *
   * Every capability check reads the membership row, so an account of type
   * ADMIN holding no role can sign in and then be refused by every screen it
   * opens - which is exactly what the first admin on a fresh install used to
   * get. The role is created here if `sync:roles` has not run yet, because
   * this script has to work on an empty database.
   */
  const definition = SYSTEM_ROLES.find((r) => r.key === 'admin.super')!;

  const role =
    (await prisma.platformRole.findUnique({ where: { key: definition.key } })) ??
    (await prisma.platformRole.create({
      data: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        scope: RoleScope.ADMIN,
        permissions: definition.permissions,
        isSystem: true,
      },
    }));

  const membership = await prisma.adminMember.findUnique({ where: { userId: user.id } });

  /*
   * The super admin is the platform team: an operations membership with no
   * tenant. That is what lets it onboard institutions and step into any of
   * them. Said explicitly, on create and on reset alike, so a reset also
   * undoes anybody having tied this account to a single institution.
   */
  if (!membership) {
    await prisma.adminMember.create({
      data: { userId: user.id, roleId: role.id, tenantId: null },
    });
  } else if (membership.roleId !== role.id || membership.tenantId !== null) {
    // Resetting the super admin's password should also restore the powers it
    // is supposed to have, in case somebody moved it to a narrower role.
    await prisma.adminMember.update({
      where: { userId: user.id },
      data: { roleId: role.id, tenantId: null },
    });
  }

  const line = '-'.repeat(52);
  console.log(`\n${line}`);
  console.log(existing ? '  Super admin password reset' : '  Super admin created');
  console.log(line);
  console.log(`  email     ${user.email}`);
  console.log(`  name      ${user.fullName}`);
  console.log(`  role      ${role.name}`);
  if (supplied) {
    console.log('  password  (taken from ADMIN_PASSWORD)');
  } else {
    console.log(`  password  ${password}`);
    console.log('\n  Generated - copy it now, it is not stored anywhere.');
  }
  console.log(`${line}\n`);
}

main()
  .catch((err) => {
    console.error('Could not create the super admin:', err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
