import { describe, expect, it } from 'vitest';
import { jobSchema, toData } from '../src/modules/jobs/job.routes.js';

/**
 * A role that says it has no marks bar must not keep one.
 *
 * The flag and the numbers are two ways of saying the same thing, and the
 * visibility query only reads the numbers. If a recruiter sets 8.5, changes
 * their mind and ticks "open to everyone", a stored 8.5 goes on quietly
 * excluding people while the card promises the opposite.
 */

const BARS = [
  'minCgpa',
  'minDegreePct',
  'minTenthPct',
  'minTwelfthPct',
  'minDiplomaPct',
  'minPgCgpa',
  'minPgPct',
  'preferredCgpa',
  'preferredDegreePct',
  'maxBacklogs',
  'maxActiveBacklogs',
  'maxGapYears',
] as const;

/** The least a payload can carry and still parse. */
function payload(extra: Record<string, unknown> = {}) {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 30);

  return jobSchema.parse({
    title: 'Software Engineer',
    description: 'A role for testing.',
    jobType: 'FULL_TIME',
    deadline: deadline.toISOString(),
    ...extra,
  });
}

describe('a role declared open to everyone', () => {
  it('keeps no marks bar of any kind', () => {
    const withBars = {
      minCgpa: 8.5,
      minDegreePct: 75,
      minTenthPct: 70,
      minTwelfthPct: 70,
      minDiplomaPct: 65,
      minPgCgpa: 7,
      minPgPct: 60,
      preferredCgpa: 9,
      preferredDegreePct: 85,
      maxBacklogs: 2,
      maxActiveBacklogs: 0,
      maxGapYears: 1,
    };

    const data = toData(payload({ ...withBars, openToAll: true }));

    for (const bar of BARS) {
      expect(data[bar], `${bar} survived the flag`).toBeNull();
    }
    expect(data.openToAll).toBe(true);
  });

  it('leaves the bars alone when it is off', () => {
    const data = toData(payload({ minCgpa: 8.5, maxBacklogs: 2, openToAll: false }));

    expect(data.minCgpa).toBe(8.5);
    expect(data.maxBacklogs).toBe(2);
    expect(data.openToAll).toBe(false);
  });

  it('defaults to off, so nothing opens up by omission', () => {
    const data = toData(payload({ minCgpa: 7 }));

    expect(data.openToAll).toBe(false);
    expect(data.minCgpa).toBe(7);
  });

  it('does not touch who the role is aimed at', () => {
    const data = toData(
      payload({
        openToAll: true,
        allowedCourses: ['B.E.'],
        allowedSpecialisations: ['Computer'],
        graduationYears: [2026],
      }),
    );

    // Course, branch and year are who it is for, not a bar somebody can fail.
    expect(data.openToAll).toBe(true);
    expect(data.minCgpa).toBeNull();
  });
});
