import { RankTier } from '../config/settings';

export type Division = 1 | 2 | 3;

const DIVISIONS_PER_RANK = 3;

export function rankForElo(elo: number, ranks: RankTier[]): RankTier {
  let current = ranks[0] ?? { name: 'Bronze', threshold: 0 };
  for (const tier of ranks) {
    if (elo >= tier.threshold) current = tier;
  }
  return current;
}

/**
 * Which division (I, II or III) the player is in within their current rank.
 * Each band between adjacent thresholds is split into three equal parts.
 */
export function divisionForElo(elo: number, ranks: RankTier[]): Division {
  const current = rankForElo(elo, ranks);
  const idx = ranks.findIndex((r) => r.name === current.name);
  const next = idx >= 0 && idx < ranks.length - 1 ? ranks[idx + 1] : undefined;
  if (!next) return 3; // top rank
  const span = next.threshold - current.threshold;
  if (span <= 0) return 1;
  const step = span / DIVISIONS_PER_RANK;
  const offset = Math.max(0, elo - current.threshold);
  if (offset < step) return 1;
  if (offset < step * 2) return 2;
  return 3;
}

/** Roman-numeral division names: I, II, III. */
export function divisionName(division: Division): string {
  return ['I', 'II', 'III'][division - 1];
}

/** Full display label, e.g. "DIAMOND II" or "LEGENDARY" for the top rank. */
export function displayRank(elo: number, ranks: RankTier[]): string {
  const rank = rankForElo(elo, ranks);
  const idx = ranks.findIndex((r) => r.name === rank.name);
  const isTop = idx === ranks.length - 1;
  if (isTop) return rank.name.toUpperCase();
  return `${rank.name.toUpperCase()} ${divisionName(divisionForElo(elo, ranks))}`;
}

/** Stable identifier for an elo -> rank+division pair (used for announcements). */
export function rankKey(elo: number, ranks: RankTier[]): string {
  const rank = rankForElo(elo, ranks);
  const idx = ranks.findIndex((r) => r.name === rank.name);
  if (idx === ranks.length - 1) return `${rank.name.toUpperCase()}:3`;
  return `${rank.name.toUpperCase()}:${divisionForElo(elo, ranks)}`;
}
