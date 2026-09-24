import { RoleScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';

/**
 * The role an invitation grants, checked before it is sent.
 *
 * An invitation without a usable role would be accepted into nothing - the
 * membership row needs one - so it is resolved here rather than discovered
 * when somebody clicks the link a week later.
 */
export async function usableRole(roleId: string | undefined, scope: RoleScope) {
  const role = roleId
    ? await prisma.platformRole.findUnique({ where: { id: roleId } })
    : await prisma.platformRole.findUnique({
        where: { key: scope === RoleScope.CAMPUS ? 'campus.officer' : 'company.owner' },
      });

  if (!role || role.scope !== scope) throw notFound('No such role.');
  if (!role.isActive) throw conflict(`${role.name} has been retired and cannot be given out.`);
  return role;
}
