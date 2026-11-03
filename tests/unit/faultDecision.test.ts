import { describe, it, expect } from 'vitest';
import { shouldEscalateDodge, FAULT_VOTE_REQUIRED } from '../../src/matches/faultDecision';

const teamA = ['a1', 'a2', 'a3'];
const teamB = ['b1', 'b2', 'b3'];

describe('shouldEscalateDodge', () => {
  it('does not escalate with fewer than 4 reports', () => {
    expect(
      shouldEscalateDodge({ reportedPlayerId: 'x', reporterIds: ['a1', 'a2', 'b1'], teamA, teamB })
    ).toBe(false);
  });

  it('does not escalate when all 4+ reports come from a single team', () => {
    expect(
      shouldEscalateDodge({ reportedPlayerId: 'x', reporterIds: ['a1', 'a2', 'a3', 'x'], teamA, teamB })
    ).toBe(false);
  });

  it('ignores the accused player’s own report', () => {
    // 4 reports but one is the accused player — should not pass.
    expect(
      shouldEscalateDodge({ reportedPlayerId: 'x', reporterIds: ['a1', 'a2', 'b1', 'x'], teamA, teamB })
    ).toBe(false);
  });

  it('escalates with 4 reports from both teams', () => {
    expect(
      shouldEscalateDodge({ reportedPlayerId: 'x', reporterIds: ['a1', 'a2', 'b1', 'b2'], teamA, teamB })
    ).toBe(true);
  });

  it('escalates with more than the required count from both teams', () => {
    expect(
      shouldEscalateDodge({ reportedPlayerId: 'x', reporterIds: ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'], teamA, teamB })
    ).toBe(true);
  });

  it('threshold constant is 4', () => {
    expect(FAULT_VOTE_REQUIRED).toBe(4);
  });
});