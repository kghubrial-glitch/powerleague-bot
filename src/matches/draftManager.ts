import { DraftRow } from '../database/repositories/draftRepository';

/**
 * Captain-draft matchmaking (mode: MATCHMAKING_MODE=draft).
 *
 * Six players queue. The two highest-rated players are the captains: the top
 * Elo leads Team A, the second leads Team B. The four remaining players are
 * drafted by the captains in a snake order that keeps the picking fair.
 *
 * Pick order: A, B, B, A
 *   - A (captain of Team A) picks first  -> Team A
 *   - B picks 2nd and 3rd                -> Team B
 *   - A picks 4th                        -> Team A
 *
 * Each team ends with its captain plus two drafted players (3v3).
 */

export type DraftTurn = 'A' | 'B';

export const DRAFT_PICKS = 4;

/** The acting captain for each of the 4 draft slots. */
export function captainForSlot(slot: number): DraftTurn {
  return DRAFT_ORDER[slot];
}

/** Constant snake order: A, B, B, A. */
export const DRAFT_ORDER: DraftTurn[] = ['A', 'B', 'B', 'A'];

/** The team a pick on a given slot is destined for (A picks -> Team A). */
export function targetForSlot(slot: number): DraftTurn {
  return captainForSlot(slot);
}

/**
 * Divides the six queue entries into captains and a draftee pool.
 * Captain A is the highest-Elo player; captain B the second-highest.
 */
export function draftPool(entries: Array<{ discordId: string; elo: number }>): {
  captainA: string;
  captainB: string;
  pool: string[];
} {
  if (entries.length !== 6) {
    throw new Error('A draft requires exactly six distinct players.');
  }
  const unique = new Set(entries.map((e) => e.discordId));
  if (unique.size !== 6) {
    throw new Error('A draft requires exactly six distinct players.');
  }
  const ordered = [...entries].sort((a, b) => b.elo - a.elo);
  const captainA = ordered[0]!.discordId;
  const captainB = ordered[1]!.discordId;
  const captainSet = new Set([captainA, captainB]);
  const pool = ordered.map((e) => e.discordId).filter((id) => !captainSet.has(id));
  if (pool.length !== 4) {
    throw new Error('A draft requires exactly six distinct players.');
  }
  return { captainA, captainB, pool };
}

/** True when the four draftee picks have all been made. */
export function isDraftComplete(idx: number): boolean {
  return idx >= DRAFT_PICKS;
}

/** Human summary of the draft progress for the draft panel. */
export function summarizeDraft(
  draft: DraftRow,
  picks: Array<{ turn: string; picked_id: string }>
): { teamAList: string[]; teamBList: string[]; remaining: string[] } {
  const teamAList: string[] = [];
  const teamBList: string[] = [];
  for (const pick of picks) {
    (pick.turn === 'A' ? teamAList : teamBList).push(pick.picked_id);
  }
  const remaining = JSON.parse(draft.pool) as string[];
  return { teamAList, teamBList, remaining };
}