import { VoteChoice } from '../types';

export interface VoteRecord {
  discord_id: string;
  vote: VoteChoice;
}

export interface VoteEvaluation {
  decided: boolean;
  winner: VoteChoice | null;
  tallies: Record<VoteChoice, number>;
  reason: 'confirmed' | 'dispute_no_quorum' | 'lack_split' | 'undecided';
}

export const REQUIRED_VOTES = 4;

/**
 * Evaluates a result vote. A choice is confirmed when:
 *  - it has at least `required` votes, and
 *  - at least one voter for that choice comes from each team.
 */
export function evaluateVotes(
  votes: VoteRecord[],
  teamA: string[],
  teamB: string[],
  required: number = REQUIRED_VOTES
): VoteEvaluation {
  const tallies: Record<VoteChoice, number> = { A: 0, B: 0, draw: 0 };
  const votersByChoice: Record<VoteChoice, string[]> = { A: [], B: [], draw: [] };

  for (const v of votes) {
    tallies[v.vote] += 1;
    votersByChoice[v.vote].push(v.discord_id);
  }

  for (const choice of ['A', 'B', 'draw'] as VoteChoice[]) {
    if (tallies[choice] >= required && hasBothTeams(votersByChoice[choice], teamA, teamB)) {
      return { decided: true, winner: choice, tallies, reason: 'confirmed' };
    }
  }

  // All eligible votes exhausted without a decision: dispute.
  const eligibleCount = votes.length;
  if (eligibleCount >= required && Math.max(...Object.values(tallies)) < required) {
    return { decided: false, winner: null, tallies, reason: 'dispute_no_quorum' };
  }
  // A choice has quorum but lacks cross-team confirmation.
  for (const choice of ['A', 'B', 'draw'] as VoteChoice[]) {
    if (tallies[choice] >= required) {
      return { decided: false, winner: null, tallies, reason: 'lack_split' };
    }
  }
  return { decided: false, winner: null, tallies, reason: 'undecided' };
}

export function hasBothTeams(voterIds: string[], teamA: string[], teamB: string[]): boolean {
  const hasA = voterIds.some((id) => teamA.includes(id));
  const hasB = voterIds.some((id) => teamB.includes(id));
  return hasA && hasB;
}