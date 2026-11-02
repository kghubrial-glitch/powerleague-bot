import { TeamAssignment } from '../types';

export interface QueuePlayer {
  discordId: string;
  elo: number;
}

export interface BalanceOptions {
  /** Only candidates whose |elo diff| is within this tolerance of the best are considered. */
  tolerance: number;
  rng?: () => number;
}

/**
 * Generates every unique 3v3 split for six players. For each combination we
 * compute the difference between the two teams' average Elo. Combinations
 * within `tolerance` of the best (smallest) difference are eligible, and the
 * final arrangement is drawn randomly from that pool. Team A/B labels are also
 * randomized so the output is never deterministic.
 *
 * For six players there are exactly C(6,3)/2 = 10 unique splits.
 */
export function generateBalancedTeams(
  players: QueuePlayer[],
  options: BalanceOptions
): TeamAssignment {
  const rng = options.rng ?? Math.random;
  const tolerance = options.tolerance;

  if (players.length !== 6) {
    throw new Error(`Team balancing requires exactly 6 players, got ${players.length}`);
  }
  const seen = new Set<string>(); // dedupe reverse orderings by sorted key
  const candidates: TeamAssignment[] = [];

  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      for (let k = j + 1; k < 6; k++) {
        const teamA = [players[i], players[j], players[k]];
        const teamB = players.filter((_, idx) => idx !== i && idx !== j && idx !== k);
        const avgA = average(teamA.map((p) => p.elo));
        const avgB = average(teamB.map((p) => p.elo));
        const diff = Math.abs(avgA - avgB);

        // Canonical key for the unordered split: each 3v3 partition appears
        // twice in the i<j<k iteration (once as (X,Y), once as (Y,X)); the key
        // makes both orderings collapse to one candidate.
        const partA = teamA.map((p) => p.discordId).sort().join(',');
        const partB = teamB.map((p) => p.discordId).sort().join(',');
        const key = [partA, partB].sort().join('|');

        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({
            teamA: teamA.map((p) => p.discordId),
            teamB: teamB.map((p) => p.discordId),
            diff,
          });
        }
      }
    }
  }

  if (candidates.length !== 10) {
    throw new Error(`Expected 10 unique team splits, found ${candidates.length}`);
  }

  const bestDiff = Math.min(...candidates.map((c) => c.diff));
  const eligible = candidates.filter((c) => c.diff <= bestDiff + tolerance);

  const chosen = eligible.length > 0 ? eligible[Math.floor(rng() * eligible.length)] : candidates[0];

  // Randomly flip which side is labeled Team A.
  if (rng() < 0.5) {
    return {
      teamA: chosen.teamB,
      teamB: chosen.teamA,
      diff: chosen.diff,
    };
  }
  return chosen;
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Deterministic reference implementation used by tests. */
export function bestTeamsDeterministic(players: QueuePlayer[]): TeamAssignment {
  const rng = () => 0;
  return generateBalancedTeams(players, { tolerance: 0, rng });
}