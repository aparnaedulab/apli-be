import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireCandidateId, requireCollegeId, requireCompanyId, requireRole } from '../../middleware/auth.js';
import { can } from '../roles/can.js';
import { requireModule } from '../tenants/tenant.context.js';
import {
  MAX_OPEN_REFERRALS,
  assertCanRequestReferral,
  campusCollege,
  collegeOf,
  describePool,
  isAlumnus,
  notify,
  openPoolsForCompanies,
  ownOpenPlacement,
  publicMentor,
  sendRoleToPool,
  verifiedCompany,
} from './network.service.js';

/**
 * Alumni connect and pooled drives.
 *
 * Every route fences itself: account type, then the institution's module
 * (students and colleges belong to one; a company does not, so the pool pages
 * check the pool's institution instead), then the capability, then scope.
 */
export const networkRouter = Router();

const alumniOn = requireModule('community.alumni');
const poolsOn = requireModule('ops.pooledDrives');

const MENTOR_INCLUDE = {
  candidate: {
    select: {
      graduationYear: true,
      course: true,
      specialisation: true,
      collegeId: true,
      user: { select: { fullName: true } },
    },
  },
} as const;

/* ========================================================================== */
/* Alumni - students and alumni                                                */
/* ========================================================================== */

/** GET /api/network/alumni/me - whether I count as an alumnus, and my mentor profile. */
networkRouter.get(
  '/alumni/me',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const me = await collegeOf(candidateId);
    const profile = await prisma.alumniProfile.findUnique({ where: { candidateId } });
    res.json({
      isAlumnus: await isAlumnus(candidateId),
      collegeName: me.college?.name ?? null,
      profile: profile
        ? {
            available: profile.available,
            currentCompany: profile.currentCompany,
            currentRole: profile.currentRole,
            canRefer: profile.canRefer,
            topics: Array.isArray(profile.topics) ? profile.topics : [],
          }
        : null,
      maxOpenReferrals: MAX_OPEN_REFERRALS,
    });
  }),
);

const profileSchema = z.object({
  available: z.boolean(),
  currentCompany: z.string().trim().max(120).optional().or(z.literal('')),
  currentRole: z.string().trim().max(120).optional().or(z.literal('')),
  canRefer: z.boolean().default(false),
  topics: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

/** PUT /api/network/alumni/me - opt in (or out) as a senior juniors can ask. */
networkRouter.put(
  '/alumni/me',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    await collegeOf(candidateId);
    if (!(await isAlumnus(candidateId))) {
      throw forbidden('This is for seniors who have graduated or accepted an offer. Your turn will come.');
    }
    const d = profileSchema.parse(req.body);
    const data = {
      available: d.available,
      currentCompany: d.currentCompany || null,
      currentRole: d.currentRole || null,
      canRefer: d.canRefer,
      topics: d.topics,
    };
    const profile = await prisma.alumniProfile.upsert({
      where: { candidateId },
      update: data,
      create: { candidateId, ...data },
    });
    res.json({ profile });
  }),
);

/** GET /api/network/alumni/mentors - seniors from my own college who have opted in. */
networkRouter.get(
  '/alumni/mentors',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const me = await collegeOf(candidateId);
    const rows = await prisma.alumniProfile.findMany({
      where: { available: true, candidate: { collegeId: me.collegeId }, NOT: { candidateId } },
      include: MENTOR_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ mentors: rows.map(publicMentor) });
  }),
);

/** How a question looks to a student: an anonymous asker is "a junior" to everyone else. */
async function questionsFor(collegeId: string, viewerCandidateId: string | null, includeHidden = false) {
  const qs = await prisma.alumniQuestion.findMany({
    where: { collegeId, ...(includeHidden ? {} : { status: { not: 'HIDDEN' } }) },
    orderBy: { createdAt: 'desc' },
    include: { answers: { orderBy: { createdAt: 'asc' } } },
    take: 200,
  });

  const people = new Set<string>();
  qs.forEach((q) => {
    people.add(q.askedById);
    q.answers.forEach((a) => people.add(a.candidateId));
  });
  const cands = await prisma.candidate.findMany({
    where: { id: { in: [...people] } },
    select: { id: true, graduationYear: true, user: { select: { fullName: true } }, alumniProfile: { select: { currentCompany: true, currentRole: true } } },
  });
  const byId = new Map(cands.map((c) => [c.id, c]));

  return qs.map((q) => {
    const mine = viewerCandidateId === q.askedById;
    const asker = byId.get(q.askedById);
    return {
      id: q.id,
      body: q.body,
      companyName: q.companyName,
      anonymous: q.anonymous,
      status: q.status,
      mine,
      createdAt: q.createdAt,
      // The college's own view (viewer null) always sees who asked.
      askedBy: q.anonymous && !mine && viewerCandidateId !== null ? null : (asker?.user.fullName ?? null),
      answers: q.answers.map((a) => {
        const who = byId.get(a.candidateId);
        return {
          id: a.id,
          body: a.body,
          createdAt: a.createdAt,
          mine: viewerCandidateId === a.candidateId,
          by: who?.user.fullName ?? 'A senior',
          byLine: [who?.alumniProfile?.currentRole, who?.alumniProfile?.currentCompany].filter(Boolean).join(' at ') ||
            (who?.graduationYear ? `Class of ${who.graduationYear}` : null),
        };
      }),
    };
  });
}

/** GET /api/network/alumni/questions - my college's questions and their answers. */
networkRouter.get(
  '/alumni/questions',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const me = await collegeOf(candidateId);
    res.json({ questions: await questionsFor(me.collegeId, candidateId), isAlumnus: await isAlumnus(candidateId) });
  }),
);

const questionSchema = z.object({
  body: z.string().trim().min(10, 'Ask a full question - seniors answer what they can understand.').max(1500),
  companyName: z.string().trim().max(120).optional().or(z.literal('')),
  anonymous: z.boolean().default(false),
});

/** POST /api/network/alumni/questions - ask my college's seniors. */
networkRouter.post(
  '/alumni/questions',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const me = await collegeOf(candidateId);
    const d = questionSchema.parse(req.body);
    const q = await prisma.alumniQuestion.create({
      data: {
        collegeId: me.collegeId,
        askedById: candidateId,
        body: d.body,
        companyName: d.companyName || null,
        anonymous: d.anonymous,
      },
    });
    res.status(201).json({ question: { id: q.id } });
  }),
);

/** POST /api/network/alumni/questions/:id/answers - a senior answers. */
networkRouter.post(
  '/alumni/questions/:id/answers',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const me = await collegeOf(candidateId);
    const { body } = z.object({ body: z.string().trim().min(10, 'Say a little more.').max(3000) }).parse(req.body);

    const q = await prisma.alumniQuestion.findFirst({
      where: { id: req.params.id, collegeId: me.collegeId, status: { not: 'HIDDEN' } },
    });
    if (!q) throw notFound('No such question.');
    if (!(await isAlumnus(candidateId))) throw forbidden('Only seniors who have graduated or accepted an offer can answer.');
    if (q.askedById === candidateId) throw badRequest('You cannot answer your own question.');

    const answer = await prisma.alumniAnswer.create({ data: { questionId: q.id, candidateId, body } });
    await prisma.alumniQuestion.update({ where: { id: q.id }, data: { status: 'ANSWERED' } });

    const asker = await prisma.candidate.findUnique({ where: { id: q.askedById }, select: { userId: true } });
    if (asker) {
      await notify(asker.userId, 'ALUMNI_ANSWER', 'A senior answered your question', body.slice(0, 140), '/student/alumni', {
        questionId: q.id,
      });
    }
    res.status(201).json({ answer: { id: answer.id } });
  }),
);

const referralSchema = z.object({
  toCandidateId: z.string().min(1),
  company: z.string().trim().min(2, 'Which company?').max(120),
  role: z.string().trim().min(2, 'Which role?').max(120),
  message: z.string().trim().min(20, 'Tell them a little about yourself and why this role.').max(500),
});

/** POST /api/network/alumni/referrals - ask an opted-in senior for a referral. */
networkRouter.post(
  '/alumni/referrals',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const d = referralSchema.parse(req.body);
    const { me, target } = await assertCanRequestReferral(candidateId, d.toCandidateId);

    const duplicate = await prisma.referralRequest.findFirst({
      where: { fromCandidateId: candidateId, toCandidateId: d.toCandidateId, status: 'SENT' },
    });
    if (duplicate) throw conflict('You already have a request waiting with this senior.');

    const r = await prisma.referralRequest.create({
      data: { fromCandidateId: candidateId, toCandidateId: d.toCandidateId, company: d.company, role: d.role, message: d.message },
    });
    await notify(
      target.candidate.userId,
      'REFERRAL_REQUEST',
      `${me.user.fullName} asked you for a referral`,
      `${d.role} at ${d.company}`,
      '/student/alumni',
      { referralId: r.id },
    );
    res.status(201).json({ referral: { id: r.id } });
  }),
);

/** GET /api/network/alumni/referrals - requests I sent and requests I received. */
networkRouter.get(
  '/alumni/referrals',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const [sent, received] = await Promise.all([
      prisma.referralRequest.findMany({ where: { fromCandidateId: candidateId }, orderBy: { createdAt: 'desc' } }),
      prisma.referralRequest.findMany({ where: { toCandidateId: candidateId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const ids = [...new Set([...sent.map((r) => r.toCandidateId), ...received.map((r) => r.fromCandidateId)])];
    const people = await prisma.candidate.findMany({
      where: { id: { in: ids } },
      select: { id: true, graduationYear: true, course: true, specialisation: true, user: { select: { fullName: true } } },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const view = (r: (typeof sent)[number], otherId: string) => {
      const o = byId.get(otherId);
      return {
        id: r.id,
        company: r.company,
        role: r.role,
        message: r.message,
        status: r.status,
        createdAt: r.createdAt,
        other: o
          ? { name: o.user.fullName, graduationYear: o.graduationYear, course: o.course, specialisation: o.specialisation }
          : null,
      };
    };
    res.json({
      sent: sent.map((r) => view(r, r.toCandidateId)),
      received: received.map((r) => view(r, r.fromCandidateId)),
      open: sent.filter((r) => r.status === 'SENT').length,
    });
  }),
);

/** POST /api/network/alumni/referrals/:id/respond - the senior says yes or no. */
networkRouter.post(
  '/alumni/referrals/:id/respond',
  requireRole('CANDIDATE'),
  alumniOn,
  asyncHandler(async (req, res) => {
    const candidateId = requireCandidateId(req);
    const { status } = z.object({ status: z.enum(['ACCEPTED', 'DECLINED']) }).parse(req.body);
    const r = await prisma.referralRequest.findFirst({ where: { id: req.params.id, toCandidateId: candidateId } });
    if (!r) throw notFound('No such request.');
    if (r.status !== 'SENT') throw conflict('You have already answered this request.');

    await prisma.referralRequest.update({ where: { id: r.id }, data: { status } });
    const from = await prisma.candidate.findUnique({ where: { id: r.fromCandidateId }, select: { userId: true } });
    if (from) {
      await notify(
        from.userId,
        'REFERRAL_ANSWER',
        status === 'ACCEPTED' ? 'A senior agreed to refer you' : 'A senior could not refer you this time',
        status === 'ACCEPTED'
          ? `${r.role} at ${r.company}. They will refer you through the company's own process.`
          : `${r.role} at ${r.company}. Don't take it personally - ask another senior or apply directly.`,
        '/student/alumni',
        { referralId: r.id },
      );
    }
    res.json({ referral: { id: r.id, status } });
  }),
);

/* ========================================================================== */
/* Alumni - the placement cell's moderation                                     */
/* ========================================================================== */

/** GET /api/network/college/questions - every question at the college, hidden ones too, with real names. */
networkRouter.get(
  '/college/questions',
  requireRole('CAMPUS'),
  alumniOn,
  can('student:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const [questions, mentors] = await Promise.all([
      questionsFor(collegeId, null, true),
      prisma.alumniProfile.count({ where: { available: true, candidate: { collegeId } } }),
    ]);
    res.json({ questions, mentors });
  }),
);

/** POST /api/network/college/questions/:id/visibility - hide or restore a question. */
networkRouter.post(
  '/college/questions/:id/visibility',
  requireRole('CAMPUS'),
  alumniOn,
  can('posting:decide'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    const q = await prisma.alumniQuestion.findFirst({ where: { id: req.params.id, collegeId }, include: { _count: { select: { answers: true } } } });
    if (!q) throw notFound('No such question.');
    const status = hidden ? 'HIDDEN' : q._count.answers > 0 ? 'ANSWERED' : 'OPEN';
    await prisma.alumniQuestion.update({ where: { id: q.id }, data: { status } });
    res.json({ question: { id: q.id, status } });
  }),
);

/**
 * DELETE /api/network/college/answers/:id - remove an inappropriate answer.
 *
 * Removed rather than hidden: an answer has no life of its own outside its
 * question, and there is nothing to restore it into.
 */
networkRouter.delete(
  '/college/answers/:id',
  requireRole('CAMPUS'),
  alumniOn,
  can('posting:decide'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const a = await prisma.alumniAnswer.findFirst({ where: { id: req.params.id, question: { collegeId } } });
    if (!a) throw notFound('No such answer.');
    await prisma.alumniAnswer.delete({ where: { id: a.id } });
    const left = await prisma.alumniAnswer.count({ where: { questionId: a.questionId } });
    await prisma.alumniQuestion.updateMany({
      where: { id: a.questionId, status: 'ANSWERED' },
      data: { status: left > 0 ? 'ANSWERED' : 'OPEN' },
    });
    res.status(204).end();
  }),
);

/* ========================================================================== */
/* Pooled drives - colleges                                                     */
/* ========================================================================== */

/** GET /api/network/pools - pools I host, pools I am invited to, and what I need to act. */
networkRouter.get(
  '/pools',
  requireRole('CAMPUS'),
  poolsOn,
  can('drive:read'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const me = await campusCollege(collegeId);

    const [hostedIds, memberIds, colleges, placements] = await Promise.all([
      prisma.pooledDrive.findMany({ where: { hostCollegeId: collegeId }, select: { id: true }, orderBy: { createdAt: 'desc' } }),
      prisma.pooledDriveMember.findMany({
        where: { collegeId, pool: { NOT: { hostCollegeId: collegeId } } },
        select: { poolId: true },
      }),
      prisma.college.findMany({
        where: { tenantId: me.tenantId, NOT: { id: collegeId } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, city: true },
      }),
      prisma.placement.findMany({
        where: { collegeId, isOpen: true },
        orderBy: [{ year: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, year: true, type: true },
      }),
    ]);

    const hosted = await Promise.all(hostedIds.map((p) => describePool(p.id)));
    const invited = await Promise.all(
      memberIds.map(async (m) => {
        const pool = await describePool(m.poolId);
        return { ...pool, myStatus: pool.members.find((x) => x.collegeId === collegeId)?.status ?? 'INVITED' };
      }),
    );
    res.json({ hosted, invited, colleges, placements });
  }),
);

const poolSchema = z.object({
  name: z.string().trim().min(3, 'Name the pooled drive.').max(120),
  year: z.number().int().min(2000).max(2100),
  type: z.enum(['FINAL', 'INTERNSHIP']),
  /** The host joins its own pool through one of its drives. */
  placementId: z.string().min(1, 'Choose one of your drives to bring into the pool.'),
});

/** POST /api/network/pools - start a pooled drive, bringing one of my own drives. */
networkRouter.post(
  '/pools',
  requireRole('CAMPUS'),
  poolsOn,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const me = await campusCollege(collegeId);
    const d = poolSchema.parse(req.body);
    await ownOpenPlacement(collegeId, d.placementId, d.type);

    const pool = await prisma.pooledDrive.create({
      data: {
        tenantId: me.tenantId,
        hostCollegeId: collegeId,
        name: d.name,
        year: d.year,
        type: d.type,
        members: { create: { collegeId, placementId: d.placementId, status: 'JOINED' } },
      },
    });
    res.status(201).json({ pool: await describePool(pool.id) });
  }),
);

/** POST /api/network/pools/:id/invites - invite colleges of my own institution. */
networkRouter.post(
  '/pools/:id/invites',
  requireRole('CAMPUS'),
  poolsOn,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const me = await campusCollege(collegeId);
    const { collegeIds } = z.object({ collegeIds: z.array(z.string().min(1)).min(1).max(50) }).parse(req.body);

    const pool = await prisma.pooledDrive.findFirst({ where: { id: req.params.id, hostCollegeId: collegeId } });
    if (!pool) throw notFound('No such pool.');

    const wanted = [...new Set(collegeIds)].filter((id) => id !== collegeId);
    // Pools never cross institutions: anyone outside this one answers like a wrong id.
    const same = await prisma.college.findMany({
      where: { id: { in: wanted }, tenantId: me.tenantId },
      select: { id: true, name: true, members: { where: { role: { key: 'campus.officer' } }, select: { userId: true } } },
    });
    if (same.length !== wanted.length) throw notFound('One of those colleges is not part of your institution.');

    let invited = 0;
    for (const c of same) {
      const existing = await prisma.pooledDriveMember.findUnique({
        where: { poolId_collegeId: { poolId: pool.id, collegeId: c.id } },
      });
      if (existing && existing.status !== 'DECLINED') continue;
      await prisma.pooledDriveMember.upsert({
        where: { poolId_collegeId: { poolId: pool.id, collegeId: c.id } },
        update: { status: 'INVITED', placementId: null },
        create: { poolId: pool.id, collegeId: c.id, status: 'INVITED' },
      });
      invited++;
      for (const m of c.members) {
        await notify(
          m.userId,
          'POOL_INVITE',
          `${me.name} invited you to a pooled drive`,
          `${pool.name} (${pool.year}). Join with one of your drives, or decline.`,
          '/campus/pools',
          { poolId: pool.id },
        );
      }
    }
    res.json({ invited, pool: await describePool(pool.id) });
  }),
);

/** POST /api/network/pools/:id/join - bring one of my own open drives into the pool. */
networkRouter.post(
  '/pools/:id/join',
  requireRole('CAMPUS'),
  poolsOn,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const { placementId } = z.object({ placementId: z.string().min(1) }).parse(req.body);
    const member = await prisma.pooledDriveMember.findUnique({
      where: { poolId_collegeId: { poolId: req.params.id!, collegeId } },
      include: { pool: true },
    });
    if (!member) throw notFound('Your college has not been invited to this pool.');
    await ownOpenPlacement(collegeId, placementId, member.pool.type);
    await prisma.pooledDriveMember.update({
      where: { poolId_collegeId: { poolId: member.poolId, collegeId } },
      data: { status: 'JOINED', placementId },
    });
    res.json({ pool: await describePool(member.poolId) });
  }),
);

/**
 * POST /api/network/pools/:id/decline - say no, or leave.
 *
 * Roles already sent through the pool stay on the drive as ordinary requests
 * the college can decline; leaving only stops new ones arriving.
 */
networkRouter.post(
  '/pools/:id/decline',
  requireRole('CAMPUS'),
  poolsOn,
  can('drive:write'),
  asyncHandler(async (req, res) => {
    const collegeId = requireCollegeId(req);
    const member = await prisma.pooledDriveMember.findUnique({
      where: { poolId_collegeId: { poolId: req.params.id!, collegeId } },
      include: { pool: { select: { hostCollegeId: true } } },
    });
    if (!member) throw notFound('Your college has not been invited to this pool.');
    if (member.pool.hostCollegeId === collegeId) throw conflict('The host cannot leave its own pool.');
    await prisma.pooledDriveMember.update({
      where: { poolId_collegeId: { poolId: member.poolId, collegeId } },
      data: { status: 'DECLINED', placementId: null },
    });
    res.json({ pool: await describePool(member.poolId) });
  }),
);

/* ========================================================================== */
/* Pooled drives - companies                                                   */
/* ========================================================================== */

/** GET /api/network/company/pools - pools a verified company can send a role to. */
networkRouter.get(
  '/company/pools',
  requireRole('COMPANY'),
  can('posting:target'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompany(companyId);
    const [pools, jobs] = await Promise.all([
      openPoolsForCompanies(),
      prisma.job.findMany({
        where: { companyId, status: 'PUBLISHED', deadline: { gt: new Date() } },
        orderBy: { publishedAt: 'desc' },
        select: { id: true, title: true },
      }),
    ]);
    // Only the members who joined are the company's business; invitations are the colleges'.
    res.json({
      pools: pools.map((p) => ({ ...p, members: p.members.filter((m) => m.status === 'JOINED').map(({ placementId: _p, ...m }) => m) })),
      jobs,
    });
  }),
);

/** POST /api/network/company/pools/:id/send - put a published role in front of every joined college. */
networkRouter.post(
  '/company/pools/:id/send',
  requireRole('COMPANY'),
  can('posting:target'),
  asyncHandler(async (req, res) => {
    const companyId = requireCompanyId(req);
    await verifiedCompany(companyId);
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.body);
    res.json(await sendRoleToPool(req.params.id!, companyId, jobId));
  }),
);
