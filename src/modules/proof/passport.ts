import { EnrolmentStatus, InternshipStatus, MicroApplicationStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { linksOf } from '../candidates/candidate.service.js';

/**
 * The verified skills passport.
 *
 * Nothing new is stored here: every claim is read from something that already
 * happened, and labelled by who stands behind it.
 *
 *   COLLEGE_VERIFIED   marks the college checked and locked (a frozen batch record)
 *   EMPLOYER_VERIFIED  work a company reviewed - a completed simulation, an
 *                      internship a mentor evaluated, a micro-internship the
 *                      company rated
 *   SELF_REPORTED      what the student wrote on their profile
 *
 * The label is the point. With resumes written by AI, a recruiter needs to
 * know which lines somebody other than the student has vouched for.
 */

export type Evidence = 'COLLEGE_VERIFIED' | 'EMPLOYER_VERIFIED' | 'SELF_REPORTED';

export interface Claim {
  kind: 'MARKS' | 'SKILL' | 'SIMULATION' | 'INTERNSHIP' | 'PROJECT' | 'EXPERIENCE';
  label: string;
  detail: string | null;
  evidence: Evidence;
  /** Who vouches for it, in words: "Verified by Demo College on 3 Sep 2026". */
  source: string;
  /** A way to check it independently, where there is one. */
  certificateCode?: string | null;
}

const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function passportFor(candidateId: string) {
  const c = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      user: { select: { fullName: true } },
      college: { select: { name: true } },
      skills: { include: { skill: { select: { name: true } } } },
      projects: { orderBy: { title: 'asc' } },
      experiences: { orderBy: { startDate: 'desc' } },
      batchMemberships: { where: { isFrozen: true }, orderBy: { verifiedAt: 'desc' }, take: 1, select: { verifiedAt: true } },
      simulationEnrolments: {
        where: { status: EnrolmentStatus.COMPLETED },
        include: { simulation: { select: { title: true, role: true, skills: true, company: { select: { name: true } } } } },
        orderBy: { completedAt: 'desc' },
      },
      internships: {
        where: { status: InternshipStatus.COMPLETED, evaluationScore: { not: null } },
        orderBy: { endDate: 'desc' },
      },
      // Only rated work counts: a company marking it complete without a rating
      // has not said how good it was.
      microApplications: {
        where: { status: MicroApplicationStatus.COMPLETED, rating: { not: null } },
        include: { project: { select: { title: true, companyId: true } } },
        orderBy: { updatedAt: 'desc' },
      },
    },
  });
  if (!c) throw notFound('No such student.');

  const claims: Claim[] = [];
  const college = c.college?.name ?? 'their college';
  const frozen = c.batchMemberships[0];

  // Marks. Entered by the college either way; verified only once it locked them.
  const marks: [string, number | null, string][] = [
    ['CGPA', num(c.cgpa), ''],
    ['Degree percentage', num(c.degreePct), '%'],
    ['PG CGPA', num(c.pgCgpa), ''],
    ['PG percentage', num(c.pgPct), '%'],
    ['Class 10', num(c.tenthPct), '%'],
    ['Class 12', num(c.twelfthPct), '%'],
    ['Diploma', num(c.diplomaPct), '%'],
  ];
  for (const [label, value, unit] of marks) {
    if (value === null) continue;
    claims.push({
      kind: 'MARKS',
      label,
      detail: `${value}${unit}`,
      evidence: frozen ? 'COLLEGE_VERIFIED' : 'SELF_REPORTED',
      source: frozen
        ? `Verified by ${college}${frozen.verifiedAt ? ` on ${fmt(frozen.verifiedAt)}` : ''}`
        : 'Entered, not yet verified by the college',
    });
  }
  if (c.activeBacklogs !== null || c.backlogs !== null) {
    claims.push({
      kind: 'MARKS',
      label: 'Backlogs',
      detail: `${c.activeBacklogs ?? 0} active · ${c.backlogs ?? 0} ever`,
      evidence: frozen ? 'COLLEGE_VERIFIED' : 'SELF_REPORTED',
      source: frozen ? `Verified by ${college}` : 'Entered, not yet verified by the college',
    });
  }

  // Completed simulations, and the skills each one demonstrated.
  const shownSkills = new Map<string, string>();
  for (const e of c.simulationEnrolments) {
    const s = e.simulation;
    claims.push({
      kind: 'SIMULATION',
      label: `${s.title} - ${s.role}`,
      detail: e.completedAt ? `Completed ${fmt(e.completedAt)}` : null,
      evidence: 'EMPLOYER_VERIFIED',
      source: `Reviewed by ${s.company.name}, including an explain-your-work call`,
      certificateCode: e.certificateCode,
    });
    const skills = Array.isArray(s.skills) ? (s.skills as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    for (const k of skills) if (!shownSkills.has(k.toLowerCase())) shownSkills.set(k.toLowerCase(), `${s.title} for ${s.company.name}`);
  }

  for (const i of c.internships) {
    claims.push({
      kind: 'INTERNSHIP',
      label: `${i.role} at ${i.organisation}`,
      detail: `${fmt(i.startDate)} - ${fmt(i.endDate)} · mentor rating ${i.evaluationScore}/5`,
      evidence: 'EMPLOYER_VERIFIED',
      source: i.mentorName ? `Evaluated by ${i.mentorName}, their mentor` : 'Evaluated by their mentor',
    });
  }

  // Micro-projects keep a bare companyId, so the names are looked up in one go.
  const companyIds = [...new Set(c.microApplications.map((a) => a.project.companyId))];
  const companies = companyIds.length
    ? await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
    : [];
  const companyName = new Map(companies.map((co) => [co.id, co.name]));
  for (const a of c.microApplications) {
    const company = companyName.get(a.project.companyId) ?? 'the company';
    claims.push({
      kind: 'INTERNSHIP',
      label: `Micro-internship: ${a.project.title} for ${company}`,
      detail: `rated ${a.rating}/5`,
      evidence: 'EMPLOYER_VERIFIED',
      source: `Reviewed and rated by ${company}`,
    });
  }

  // Skills: verified where a simulation showed them, the student's word otherwise.
  const listed = new Set<string>();
  for (const { skill } of c.skills) {
    listed.add(skill.name.toLowerCase());
    const shown = shownSkills.get(skill.name.toLowerCase());
    claims.push({
      kind: 'SKILL',
      label: skill.name,
      detail: null,
      evidence: shown ? 'EMPLOYER_VERIFIED' : 'SELF_REPORTED',
      source: shown ? `Shown in ${shown}` : 'Listed on their profile',
    });
  }
  // A skill a simulation proved that the student never thought to list.
  for (const [key, where] of shownSkills) {
    if (listed.has(key)) continue;
    const original = c.simulationEnrolments
      .flatMap((e) => (Array.isArray(e.simulation.skills) ? (e.simulation.skills as string[]) : []))
      .find((k) => k.toLowerCase() === key)!;
    claims.push({ kind: 'SKILL', label: original, detail: null, evidence: 'EMPLOYER_VERIFIED', source: `Shown in ${where}` });
  }

  for (const p of c.projects) {
    // The first link stands for the project, which is what a one-line claim
    // has room for; the rest are on the profile itself.
    const [first] = linksOf(p.links);
    claims.push({ kind: 'PROJECT', label: p.title, detail: first?.url ?? null, evidence: 'SELF_REPORTED', source: 'Described on their profile' });
  }
  for (const x of c.experiences) {
    claims.push({
      kind: 'EXPERIENCE',
      label: `${x.title} at ${x.organisation}`,
      detail: `${fmt(x.startDate)} - ${x.isCurrent || !x.endDate ? 'now' : fmt(x.endDate)}`,
      evidence: 'SELF_REPORTED',
      source: 'Described on their profile',
    });
  }

  const count = (e: Evidence) => claims.filter((k) => k.evidence === e).length;
  return {
    student: { name: c.user.fullName, college: c.college?.name ?? null },
    summary: {
      collegeVerified: count('COLLEGE_VERIFIED'),
      employerVerified: count('EMPLOYER_VERIFIED'),
      selfReported: count('SELF_REPORTED'),
    },
    claims,
  };
}

/**
 * A company may read a passport only for someone who applied to one of its
 * roles. Anyone else answers exactly like a student who does not exist.
 */
export async function passportForCompany(companyId: string, candidateId: string) {
  const applied = await prisma.application.findFirst({
    where: { candidateId, job: { companyId } },
    select: { id: true },
  });
  if (!applied) throw notFound('No such applicant.');
  return passportFor(candidateId);
}
