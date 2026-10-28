/**
 * Rebuilds the students' demo notifications from what is actually in the
 * database, one for each thing that happened:
 *
 *   a certificate issued      -> "Your work on X is approved"   (Certificates)
 *   changes asked on work     -> "Changes asked on X"            (the simulation)
 *   an internship offer       -> "<Company> offered you..."      (Jobs)
 *   an interview invitation   -> "<Company> invited you..."      (Interviews)
 *
 * Anything older than a week is marked read, as it would be for a student
 * who uses the app; the last week's stays new, so the menu shows counts.
 *
 *   npx tsx prisma/rebuild-demo-notifications.ts
 *
 * Only these four seeded kinds are replaced. Notifications the app itself
 * writes as people use it (interview.*, internship-offer...) are left alone.
 */
import { InternshipOfferStatus, RunStatus } from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';

const KINDS = ['SIMULATION_APPROVED', 'SIMULATION_CHANGES', 'INTERNSHIP_OFFER', 'INTERVIEW_INVITE'];
const WEEK = 7 * 24 * 60 * 60 * 1000;

export async function rebuildDemoNotifications() {
  await prisma.notification.deleteMany({ where: { type: { in: KINDS } } });
  const cutoff = Date.now() - WEEK;
  const rows: {
    userId: string;
    type: string;
    title: string;
    body: string;
    link: string;
    payload: object;
    createdAt: Date;
    readAt: Date | null;
  }[] = [];
  const add = (r: Omit<(typeof rows)[number], 'readAt'>) =>
    rows.push({ ...r, readAt: r.createdAt.getTime() < cutoff ? new Date(r.createdAt.getTime() + 3600_000) : null });

  const runs = await prisma.workSimulationRun.findMany({
    where: { status: { in: [RunStatus.COMPLETED, RunStatus.NEEDS_WORK] } },
    select: {
      id: true,
      status: true,
      reviewedAt: true,
      completedAt: true,
      reviewNote: true,
      candidate: { select: { userId: true } },
      simulation: { select: { title: true, slug: true } },
    },
  });
  for (const r of runs) {
    const at = r.reviewedAt ?? r.completedAt ?? new Date();
    if (r.status === RunStatus.COMPLETED) {
      add({
        userId: r.candidate.userId,
        type: 'SIMULATION_APPROVED',
        title: `Your work on ${r.simulation.title} is approved`,
        body: 'Your certificate is ready to share.',
        link: '/student/certificates',
        payload: { runId: r.id },
        createdAt: at,
      });
    } else {
      add({
        userId: r.candidate.userId,
        type: 'SIMULATION_CHANGES',
        title: `Changes asked on ${r.simulation.title}`,
        body: r.reviewNote ?? 'Your reviewer left a note on what to fix.',
        link: `/student/simulations/${r.simulation.slug}`,
        payload: { runId: r.id },
        createdAt: at,
      });
    }
  }

  const offers = await prisma.internshipOffer.findMany({
    select: { id: true, role: true, months: true, status: true, createdAt: true, company: { select: { name: true } }, candidate: { select: { userId: true } } },
  });
  for (const o of offers) {
    add({
      userId: o.candidate.userId,
      type: 'INTERNSHIP_OFFER',
      title: `${o.company.name} offered you an internship`,
      body: `${o.role}, ${o.months} month${o.months === 1 ? '' : 's'}.`,
      link: '/student/jobs',
      payload: { offerId: o.id },
      createdAt: o.createdAt,
    });
    // An offer the student has already answered is, by definition, seen.
    if (o.status !== InternshipOfferStatus.SENT) rows[rows.length - 1]!.readAt ??= new Date();
  }

  const invites = await prisma.interviewInvite.findMany({
    select: { id: true, role: true, status: true, createdAt: true, company: { select: { name: true } }, candidate: { select: { userId: true } } },
  });
  for (const v of invites) {
    add({
      userId: v.candidate.userId,
      type: 'INTERVIEW_INVITE',
      title: `${v.company.name} invited you to interview`,
      body: v.role,
      link: '/student/interviews',
      payload: { inviteId: v.id },
      createdAt: v.createdAt,
    });
    // Answered invites have been seen.
    if (v.status !== 'PENDING') rows[rows.length - 1]!.readAt ??= new Date();
  }

  for (let i = 0; i < rows.length; i += 500) {
    await prisma.notification.createMany({ data: rows.slice(i, i + 500) });
  }
  return { total: rows.length, unread: rows.filter((r) => !r.readAt).length };
}

// Run directly: npx tsx prisma/rebuild-demo-notifications.ts
if (process.argv[1]?.includes('rebuild-demo-notifications')) {
  rebuildDemoNotifications()
    .then((r) => console.log(`rebuilt ${r.total} demo notifications (${r.unread} new from the last week)`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(disconnectPrisma);
}
