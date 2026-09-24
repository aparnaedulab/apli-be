import { CompanyStatus } from '@prisma/client';

/**
 * One definition of "may this company be heard".
 *
 * The status enum carries the review workflow - who applied, who was turned
 * down and why - but exactly one of its values opens the gate, and every
 * query and check goes through here rather than spelling out the comparison.
 * That way adding a status later cannot accidentally grant publishing rights.
 */
export const PUBLISHABLE = CompanyStatus.VERIFIED;

/** For a Prisma `where`: SQL-side, never filtered in JavaScript. */
export const verifiedCompany = { status: PUBLISHABLE } as const;

export function canPublish(status: CompanyStatus): boolean {
  return status === PUBLISHABLE;
}

/**
 * What a company is told about its own state. Rejection carries a reason;
 * the others speak for themselves.
 */
export function statusExplanation(status: CompanyStatus): string | null {
  switch (status) {
    case CompanyStatus.PENDING:
      return 'Your company is waiting to be verified. You can set up your profile and draft roles now - publishing opens once the university has reviewed you.';
    case CompanyStatus.REJECTED:
      return 'Your registration was not approved.';
    case CompanyStatus.SUSPENDED:
      return 'Your company has been suspended. Published roles are hidden and you cannot post new ones.';
    case CompanyStatus.VERIFIED:
      return null;
  }
}
