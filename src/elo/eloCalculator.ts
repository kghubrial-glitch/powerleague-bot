export type EloOutcome = 'win' | 'loss' | 'draw';

export interface EloRating {
  /** Number of completed (Elo-affecting) matches the player had before this one. */
  matchesPlayed: number;
}

const K_ADJUSTMENT_THRESHOLD = 10; // first N matches get the higher K
const K_NEW = 40;
const K_STANDARD = 24;

/**
 * Standard team-based Elo.
 *
 * expected = 1 / (1 + 10^((opponentAvg - teamAvg) / 400))
 *
 * The expected score is computed per-team using team averages; every player on
 * the team receives the same delta.
 */
export function expectedScore(teamAvgElo: number, opponentAvgElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentAvgElo - teamAvgElo) / 400));
}

export function kFactor(matchesPlayed: number): number {
  return matchesPlayed < K_ADJUSTMENT_THRESHOLD ? K_NEW : K_STANDARD;
}

export interface EloChangeResult {
  teamAChange: number;
  teamBChange: number;
}

/**
 * Computes the Elo delta for both teams given their average ratings and the
 * actual outcome from Team A's perspective (`outcomeA`).
 *
 * Players' own ratings don't affect the K factor per-player math here; K is a
 * property of the matchup. To keep the group delta identical for all members we
 * use the team averages for expectation and one K factor per team, derived from
 * the average matches played on the team.
 */
export function computeTeamEloChanges(
  teamAAvg: number,
  teamBAvg: number,
  outcomeA: EloOutcome,
  teamAMatchesPlayed: number,
  teamBMatchesPlayed: number
): EloChangeResult {
  const kA = kFactor(teamAMatchesPlayed);
  const kB = kFactor(teamBMatchesPlayed);

  const expectedA = expectedScore(teamAAvg, teamBAvg);
  const expectedB = 1 - expectedA;

  const actualA = outcomeA === 'win' ? 1 : outcomeA === 'draw' ? 0.5 : 0;
  const actualB = actualA === 1 ? 0 : actualA === 0 ? 1 : 0.5;

  let changeA = Math.round(kA * (actualA - expectedA));
  let changeB = Math.round(kB * (actualB - expectedB));

  // Zero-sum guard: keep the system zero-sum even when K differs per side.
  if (changeA + changeB !== 0) {
    const scale = 2 * Math.max(kA, kB);
    changeA = Math.round(scale * (actualA - expectedA));
    changeB = -changeA;
  }

  const max = Math.max(kA, kB);
  if (Math.abs(changeA) > max) changeA = changeA > 0 ? max : -max;
  if (Math.abs(changeB) > max) changeB = changeB > 0 ? max : -max;

  return { teamAChange: changeA, teamBChange: changeB };
}