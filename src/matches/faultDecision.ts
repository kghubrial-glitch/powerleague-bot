/**
 * Pure decision logic for fault reports. A matching player is escalated to a
 * dodge report only when enough participants (from both teams) independently
 * identified the same player — the accused player's own report never counts.
 */

export const FAULT_VOTE_REQUIRED = 4;

export interface FaultVoteInput {
  reportedPlayerId: string;
  reporterIds: string[]; // everyone who reported the accused player
  teamA: string[];
  teamB: string[];
}

/** True when the reports on a player warrant moderator review. */
export function shouldEscalateDodge(input: FaultVoteInput): boolean {
  const reporters = input.reporterIds.filter((id) => id !== input.reportedPlayerId);
  if (reporters.length < FAULT_VOTE_REQUIRED) return false;

  const teams = new Set(
    reporters.map((id) => (input.teamA.includes(id) ? 'A' : input.teamB.includes(id) ? 'B' : '?'))
  );
  return teams.size >= 2;
}