import { describe, expect, it } from 'vitest';
import { ApplicationStatus as S } from '@prisma/client';
import { ACTIVE, ALLOWED, canMove } from '../src/modules/applications/state.js';

/**
 * The transition table is pure logic with no database behind it, so it can be
 * asserted exhaustively. These are the tests that stop a future edit quietly
 * opening a path that should not exist.
 */
describe('the transition table', () => {
  const ALL = Object.values(S);

  it('has an entry for every status', () => {
    for (const status of ALL) {
      expect(ALLOWED[status], `missing entry for ${status}`).toBeDefined();
    }
  });

  it('lets nothing out of a terminal state', () => {
    for (const terminal of [S.HIRED, S.REJECTED, S.DECLINED, S.WITHDRAWN]) {
      expect(ALLOWED[terminal].size, `${terminal} should be terminal`).toBe(0);
    }
  });

  it('allows the happy path all the way to hired', () => {
    const path = [
      S.APPLIED,
      S.UNDER_REVIEW,
      S.SHORTLISTED,
      S.IN_ROUND,
      S.OFFERED,
      S.ACCEPTED,
      S.HIRED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canMove(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('lets a candidate stay in IN_ROUND while moving between rounds', () => {
    expect(canMove(S.IN_ROUND, S.IN_ROUND)).toBe(true);
  });

  it('refuses the shortcuts a careless handler might take', () => {
    expect(canMove(S.APPLIED, S.HIRED)).toBe(false);
    expect(canMove(S.APPLIED, S.OFFERED)).toBe(false);
    expect(canMove(S.APPLIED, S.ACCEPTED)).toBe(false);
    expect(canMove(S.UNDER_REVIEW, S.OFFERED)).toBe(false);
    // Shortlisting says "you are through", never "you have the job".
    expect(canMove(S.SHORTLISTED, S.OFFERED)).toBe(false);
    expect(canMove(S.SHORTLISTED, S.HIRED)).toBe(false);
    expect(canMove(S.APPLIED, S.SHORTLISTED)).toBe(false);
    expect(canMove(S.REJECTED, S.IN_ROUND)).toBe(false);
    expect(canMove(S.WITHDRAWN, S.APPLIED)).toBe(false);
    expect(canMove(S.HIRED, S.WITHDRAWN)).toBe(false);
  });

  it('only the student can end at DECLINED, and only from an offer', () => {
    const canDecline = ALL.filter((s) => canMove(s, S.DECLINED));
    expect(canDecline).toEqual([S.OFFERED]);
  });

  it('lets any live application be rejected or withdrawn', () => {
    for (const status of ACTIVE) {
      expect(canMove(status, S.REJECTED), `${status} -> REJECTED`).toBe(true);
      expect(canMove(status, S.WITHDRAWN), `${status} -> WITHDRAWN`).toBe(true);
    }
  });

  it('treats exactly the pre-decision states as active', () => {
    // SHORTLISTED is live: somebody shortlisted but not yet called to a round
    // still has to be closed when they accept an offer somewhere else.
    expect([...ACTIVE].sort()).toEqual(
      [S.APPLIED, S.UNDER_REVIEW, S.SHORTLISTED, S.IN_ROUND, S.WAITLISTED, S.OFFERED].sort(),
    );
  });

  it('never allows a move back into APPLIED', () => {
    for (const status of ALL) {
      expect(canMove(status, S.APPLIED), `${status} -> APPLIED`).toBe(false);
    }
  });
});
