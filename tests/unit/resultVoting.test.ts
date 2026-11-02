import { describe, it, expect } from 'vitest';
import { evaluateVotes, hasBothTeams, REQUIRED_VOTES } from '../../src/matches/resultVoting';
import { VoteRecord } from '../../src/matches/resultVoting';

const teamA = ['A1', 'A2', 'A3'];
const teamB = ['B1', 'B2', 'B3'];
const TA = (who: string, vote: VoteRecord['vote']): VoteRecord => ({ discord_id: who, vote });

describe('resultVoting', () => {
  it('requires 4 matching votes', () => {
    expect(REQUIRED_VOTES).toBe(4);
  });

  it('confirms 4-2 with votes from both teams', () => {
    const votes = [TA('A1', 'A'), TA('A2', 'A'), TA('A3', 'A'), TA('B1', 'A'), TA('B2', 'B'), TA('B3', 'B')];
    const ev = evaluateVotes(votes, teamA, teamB);
    expect(ev.decided).toBe(true);
    expect(ev.winner).toBe('A');
    expect(ev.reason).toBe('confirmed');
  });

  it('confirms 4-0-2 no-vote (only four vote, all same) when quorum + cross-team met', () => {
    // 4 votes all 'B', including both teams
    const votes = [TA('A1', 'B'), TA('A2', 'B'), TA('B1', 'B'), TA('B2', 'B')];
    const ev = evaluateVotes(votes, teamA, teamB, 4);
    expect(ev.decided).toBe(true);
    expect(ev.winner).toBe('B');
  });

  it('does not confirm 3-3 split', () => {
    const votes = [TA('A1', 'A'), TA('A2', 'A'), TA('B1', 'A'), TA('B2', 'B'), TA('B3', 'B'), TA('A3', 'B')];
    const ev = evaluateVotes(votes, teamA, teamB);
    expect(ev.decided).toBe(false);
    expect(ev.reason).toBe('dispute_no_quorum');
  });

  it('does not confirm when quorum votes come entirely from one team', () => {
    // 4 A-votes but all from team A
    const votes = [TA('A1', 'A'), TA('A2', 'A'), TA('A3', 'A'), TA('A1', 'A')];
    void votes;
    const ev = evaluateVotes(
      [TA('A1', 'A'), TA('A2', 'A'), TA('A3', 'A'), TA('B2', 'B'), TA('B3', 'B'), TA('B1', 'B')],
      teamA,
      teamB
    );
    void ev;
    const fourFromOneTeam = [TA('A1', 'A'), TA('A2', 'A'), TA('A3', 'A'), TA('A1', 'A')];
    const ev2 = evaluateVotes(fourFromOneTeam, teamA, teamB);
    expect(ev2.decided).toBe(false);
    expect(ev2.winner).toBe(null);
  });

  it('all-vote dispute when everyone voted but no majority', () => {
    const votes = [TA('A1', 'A'), TA('A2', 'B'), TA('A3', 'draw'), TA('B1', 'A'), TA('B2', 'B'), TA('B3', 'draw')];
    const ev = evaluateVotes(votes, teamA, teamB);
    expect(ev.decided).toBe(false);
    expect(ev.reason).toBe('dispute_no_quorum');
  });

  it('hasBothTeams sparks correctly', () => {
    expect(hasBothTeams(['A1', 'B1'], teamA, teamB)).toBe(true);
    expect(hasBothTeams(['A1', 'A2'], teamA, teamB)).toBe(false);
    expect(hasBothTeams(['B1', 'B2'], teamA, teamB)).toBe(false);
  });
});