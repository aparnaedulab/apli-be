import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApplicationStatus, PostingStatus, RoundOutcome } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * Drive day: the rooms, the live board, and checking students in.
 *
 * A student's pass is a token signed with the server's secret, binding one
 * student to one drive. Nothing is stored for it - the signature is the
 * proof - so a pass cannot be forged, and a pass for one drive is refused
 * at another. The short code is the same idea, eight characters long, for
 * when a camera will not cooperate and somebody reads it out.
 */

function hmac(purpose: string, placementId: string, candidateId: string): Buffer {
  return createHmac('sha256', env.SESSION_SECRET).update(`${purpose}:${placementId}:${candidateId}`).digest();
}

/** The QR payload: `<placementId>.<candidateId>.<signature>`. */
export function signPass(placementId: string, candidateId: string): string {
  const sig = hmac('drive-pass', placementId, candidateId).subarray(0, 12).toString('base64url');
  return `${placementId}.${candidateId}.${sig}`;
}

/**
 * The candidate a pass belongs to, if it is genuine and for this drive.
 * Every failure is the same refusal: a scanner has no use for the reason.
 */
export function verifyPass(token: string, placementId: string): string {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw badRequest('That is not a drive pass.');
  const [drive, candidateId, sig] = parts as [string, string, string];
  const expected = hmac('drive-pass', drive, candidateId).subarray(0, 12);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw badRequest('That pass is not valid.');
  }
  if (drive !== placementId) throw badRequest('That pass is for a different drive.');
  return candidateId;
}

// Crockford base32: no I, L, O or U, so nothing is misread aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Eight characters, readable over a noisy corridor. */
export function shortCode(placementId: string, candidateId: string): string {
  const bytes = hmac('drive-code', placementId, candidateId);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

/** The drive, if it is this college's. */
export async function ownDrive(collegeId: string, placementId: string) {
  const drive = await prisma.placement.findFirst({ where: { id: placementId, collegeId } });
  if (!drive) throw notFound('That drive is not at your college.');
  return drive;
}

/** Everyone who may walk in: every student in one of the drive's batches. */
export async function driveStudents(placementId: string) {
  const memberships = await prisma.batchMembership.findMany({
    where: { batch: { placements: { some: { id: placementId } } } },
    select: {
      rollNo: true,
      candidate: { select: { id: true, user: { select: { fullName: true, email: true } } } },
      batch: { select: { name: true } },
    },
  });
  // A student in two of the drive's batches is still one person.
  const seen = new Map<string, (typeof memberships)[number]>();
  for (const m of memberships) if (!seen.has(m.candidate.id)) seen.set(m.candidate.id, m);
  return [...seen.values()];
}

/**
 * Checks a student in, once. A second scan of the same pass says so rather
 * than erroring - the queue does not need to know it was scanned twice.
 */
export async function checkIn(
  placementId: string,
  input: { token?: string; code?: string; candidateId?: string; roomId?: string | null },
) {
  let candidateId: string | null = null;
  let method: 'QR' | 'MANUAL' = 'MANUAL';

  if (input.token) {
    candidateId = verifyPass(input.token, placementId);
    method = 'QR';
  } else if (input.code) {
    const code = input.code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
    const students = await driveStudents(placementId);
    candidateId = students.find((s) => shortCode(placementId, s.candidate.id) === code)?.candidate.id ?? null;
    if (!candidateId) throw notFound('No student in this drive has that code.');
  } else if (input.candidateId) {
    candidateId = input.candidateId;
  } else {
    throw badRequest('Scan a pass, type a code, or pick a student.');
  }

  const students = await driveStudents(placementId);
  const student = students.find((s) => s.candidate.id === candidateId);
  if (!student) throw notFound('That student is not part of this drive.');

  if (input.roomId) {
    const room = await prisma.driveRoom.findFirst({ where: { id: input.roomId, placementId } });
    if (!room) throw notFound('That room is not in this drive.');
  }

  const existing = await prisma.driveCheckIn.findUnique({
    where: { placementId_candidateId: { placementId, candidateId } },
  });
  if (existing) {
    return { checkIn: existing, alreadyCheckedIn: true, name: student.candidate.user.fullName };
  }
  const created = await prisma.driveCheckIn.create({
    data: { placementId, candidateId, method, roomId: input.roomId ?? null },
  });
  return { checkIn: created, alreadyCheckedIn: false, name: student.candidate.user.fullName };
}

/**
 * The live board: every role in the drive, and where each applicant is.
 * "Where" is read from the same rows the recruiter moves, so the board is
 * never a second copy that can fall behind.
 */
export async function driveBoard(placementId: string) {
  const [postings, rooms, checkIns, applications] = await Promise.all([
    prisma.jobPosting.findMany({
      where: { placementId, status: PostingStatus.ACCEPTED },
      select: {
        job: {
          select: {
            id: true,
            title: true,
            company: { select: { name: true } },
            rounds: { orderBy: { order: 'asc' }, select: { id: true, name: true, order: true, scheduledAt: true } },
          },
        },
      },
    }),
    prisma.driveRoom.findMany({ where: { placementId }, orderBy: { name: 'asc' } }),
    prisma.driveCheckIn.findMany({ where: { placementId } }),
    prisma.application.findMany({
      where: { placementId },
      select: {
        id: true,
        jobId: true,
        status: true,
        currentRoundId: true,
        candidate: { select: { id: true, user: { select: { fullName: true } } } },
        results: { select: { roundId: true, outcome: true } },
      },
    }),
  ]);

  const checked = new Map(checkIns.map((c) => [c.candidateId, c]));

  const jobs = postings.map(({ job }) => {
    const apps = applications.filter((a) => a.jobId === job.id);
    const roundName = new Map(job.rounds.map((r) => [r.id, r.name]));
    const applicants = apps
      .map((a) => {
        const failed = a.results.find((r) => r.outcome === RoundOutcome.FAILED);
        return {
          applicationId: a.id,
          candidateId: a.candidate.id,
          name: a.candidate.user.fullName,
          status: a.status,
          round: a.currentRoundId ? (roundName.get(a.currentRoundId) ?? null) : null,
          failedIn: failed ? (roundName.get(failed.roundId) ?? null) : null,
          checkedInAt: checked.get(a.candidate.id)?.checkedInAt ?? null,
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name));

    const live = apps.filter(
      (a) => !([ApplicationStatus.REJECTED, ApplicationStatus.WITHDRAWN] as ApplicationStatus[]).includes(a.status),
    );
    return {
      jobId: job.id,
      title: job.title,
      company: job.company.name,
      rounds: job.rounds.map((r) => ({
        ...r,
        // How many live applicants sit in each round right now.
        count: live.filter((a) => a.currentRoundId === r.id).length,
      })),
      rooms: rooms.filter((r) => r.jobId === job.id),
      applicants,
      totals: {
        applicants: apps.length,
        checkedIn: applicants.filter((a) => a.checkedInAt).length,
        offered: apps.filter((a) =>
          ([ApplicationStatus.OFFERED, ApplicationStatus.ACCEPTED, ApplicationStatus.HIRED] as ApplicationStatus[]).includes(
            a.status,
          ),
        ).length,
      },
    };
  });

  return {
    jobs,
    rooms,
    checkedIn: checkIns.length,
    unassignedRooms: rooms.filter((r) => !r.jobId),
  };
}

/** Attendance as CSV: one line per student who walked in. */
export async function attendanceCsv(placementId: string): Promise<string> {
  const [students, checkIns, rooms] = await Promise.all([
    driveStudents(placementId),
    prisma.driveCheckIn.findMany({ where: { placementId }, orderBy: { checkedInAt: 'asc' } }),
    prisma.driveRoom.findMany({ where: { placementId } }),
  ]);
  const byId = new Map(students.map((s) => [s.candidate.id, s]));
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  const lines = ['Name,Email,Roll no,Batch,Checked in at,Method,Room'];
  for (const c of checkIns) {
    const s = byId.get(c.candidateId);
    lines.push(
      [
        s?.candidate.user.fullName ?? '',
        s?.candidate.user.email ?? '',
        s?.rollNo ?? '',
        s?.batch.name ?? '',
        c.checkedInAt.toISOString(),
        c.method,
        c.roomId ? (roomName.get(c.roomId) ?? '') : '',
      ]
        .map((v) => esc(String(v)))
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
