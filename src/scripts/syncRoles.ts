import { prisma, disconnectPrisma } from '../lib/prisma.js';
import { SYSTEM_ROLES } from '../modules/roles/permissions.js';
import type { RoleScope } from '@prisma/client';

/**
 * Brings the roles a deployment ships with in line with the catalogue.
 *
 * The permission catalogue lives in code and changes with releases; the roles
 * built on it live in the database. This is what reconciles them, and it runs
 * on every deploy.
 *
 * It matches on `key`, never on name, so a university that renamed "Placement
 * officer" to "TPO" keeps its name and still gets the permissions. Roles the
 * university created itself are never touched - they are not ours to change.
 */
/** A name free within its world, since two roles there cannot share one. */
async function freeName(base: string, scope: RoleScope): Promise<string> {
  for (const candidate of [base, `${base} (standard)`]) {
    const taken = await prisma.platformRole.findFirst({ where: { scope, name: candidate } });
    if (!taken) return candidate;
  }
  return `${base} (standard ${Date.now()})`;
}

async function main(): Promise<void> {
  let created = 0;
  let updated = 0;

  for (const role of SYSTEM_ROLES) {
    const existing = await prisma.platformRole.findUnique({ where: { key: role.key } });

    if (existing) {
      await prisma.platformRole.update({
        where: { key: role.key },
        data: {
          // The name is left alone on purpose: renaming a role is a thing a
          // university does deliberately, and a deploy should not undo it.
          description: role.description,
          permissions: role.permissions,
        },
      });
      updated++;
    } else {
      // A university may already have made a role of its own with this name.
      // Theirs stays exactly as it is - it is not ours to rename or absorb -
      // and the one we ship arrives under a name that is free.
      const name = await freeName(role.name, role.scope as RoleScope);
      if (name !== role.name) {
        console.log(`  "${role.name}" was taken, so the standard one is "${name}".`);
      }

      await prisma.platformRole.create({
        data: {
          key: role.key,
          name,
          description: role.description,
          scope: role.scope as RoleScope,
          permissions: role.permissions,
          isSystem: true,
        },
      });
      created++;
    }
  }

  const custom = await prisma.platformRole.count({ where: { isSystem: false } });

  console.log(`Roles synced: ${created} created, ${updated} updated.`);
  console.log(`${custom} role${custom === 1 ? '' : 's'} created here were left alone.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
