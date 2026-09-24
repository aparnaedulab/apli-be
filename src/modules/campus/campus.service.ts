import { randomBytes } from 'node:crypto';
import { InviteKind, type Batch } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';
import { createInvite } from '../invites/invite.service.js';
import { SCOPE_INCLUDE } from '../auth/auth.service.js';

/**
 * Layer 3 of the permission model, as a query rather than an `if`. A batch id
 * from another college simply does not match, so the caller gets "no such
 * batch" instead of someone else's roster.
 */
export async function ownedBatch(collegeId: string, batchId: string): Promise<Batch> {
  const batch = await prisma.batch.findFirst({ where: { id: batchId, collegeId } });
  if (!batch) throw notFound('No such batch.');
  return batch;
}

/** Short, readable, unambiguous: no O/0 or I/1 to misread off a slide. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateJoinCode(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export async function setJoinCode(batchId: string, enabled: boolean): Promise<Batch> {
  if (!enabled) {
    return prisma.batch.update({
      where: { id: batchId },
      data: { joinCodeEnabled: false },
    });
  }

  // Rotating on every enable means a previously shared link stops working,
  // which is the point of being able to turn it off.
  return prisma.batch.update({
    where: { id: batchId },
    data: { joinCode: generateJoinCode(), joinCodeEnabled: true },
  });
}

export interface BulkInviteResult {
  created: { email: string; link: string }[];
  skipped: { email: string; reason: string }[];
}

/**
 * Invites a list of students into one batch. Partial success is the normal
 * case - one bad address in a paste of sixty should not lose the other
 * fifty-nine, so failures are reported per address rather than thrown.
 */
export async function inviteStudents(
  batch: Batch,
  emails: string[],
  sentById: string,
  linkFor: (token: string) => string,
): Promise<BulkInviteResult> {
  const result: BulkInviteResult = { created: [], skipped: [] };
  const seen = new Set<string>();

  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;

    if (seen.has(email)) {
      result.skipped.push({ email, reason: 'Listed more than once' });
      continue;
    }
    seen.add(email);

    try {
      const { token } = await createInvite({
        kind: InviteKind.STUDENT,
        email,
        batchId: batch.id,
        sentById,
      });
      result.created.push({ email, link: linkFor(token) });
    } catch (err) {
      result.skipped.push({
        email,
        reason: err instanceof Error ? err.message : 'Could not invite',
      });
    }
  }

  return result;
}

export interface JoinBatchInput {
  fullName: string;
  email: string;
  password: string;
}

/**
 * Is this code one somebody may actually join through?
 *
 * Two switches, not one, and both have to be on. The batch's own join code can
 * be turned off by the cell that owns it; the institution's `allowSelfJoin`
 * governs whether self-registration is a thing here at all. Checking only the
 * first made the institution-wide setting a lie - a university could turn
 * self-registration off and every join link already in circulation would carry
 * on working.
 *
 * Both failures give the same message on purpose. A join link is a public URL,
 * and telling a stranger which of the two switches is off tells them something
 * about the institution they have no business knowing.
 */
async function openBatchFor(code: string) {
  const batch = await prisma.batch.findUnique({
    where: { joinCode: code },
    include: {
      college: { select: { name: true } },
      tenant: { select: { allowSelfJoin: true } },
    },
  });

  if (!batch || !batch.joinCodeEnabled || !batch.tenant.allowSelfJoin) {
    throw notFound('This join link is not valid, or has been turned off.');
  }
  return batch;
}

/** What the public join page shows before anyone types anything. */
export async function previewJoinCode(code: string) {
  const batch = await openBatchFor(code);

  return {
    batchName: batch.name,
    course: batch.course,
    specialisation: batch.specialisation,
    graduationYear: batch.graduationYear,
    collegeName: batch.college?.name ?? 'University-wide',
  };
}

/**
 * Self-registration through a batch join link. Creates the user, the candidate
 * profile and the batch membership together - the same shape as accepting a
 * STUDENT invite, minus the invite row.
 */
export async function joinBatchByCode(code: string, input: JoinBatchInput) {
  const batch = await openBatchFor(code);

  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const taken = await tx.user.findUnique({ where: { email } });
    if (taken) throw conflict('An account with that email address already exists. Sign in instead.');

    const user = await tx.user.create({
      data: { email, fullName: input.fullName.trim(), passwordHash, role: 'CANDIDATE' },
    });

    const candidate = await tx.candidate.create({
      data: {
        userId: user.id,
        collegeId: batch.collegeId,
        graduationYear: batch.graduationYear,
      },
    });

    await tx.batchMembership.create({
      data: { batchId: batch.id, candidateId: candidate.id },
    });

    // Any pending emailed invite for this address is now moot.
    await tx.invite.updateMany({
      where: { email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return tx.user.findUniqueOrThrow({
      where: { id: user.id },
      include: SCOPE_INCLUDE,
    });
  });
}
