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
 * The top rank counts up from its own threshold using the band span of the
 * previous rank so the whole ladder keeps showing I/II/III.
 */
export function divisionForElo(elo: number, ranks: RankTier[]): Division {
  const current = rankForElo(elo, ranks);
  const idx = ranks.findIndex((r) => r.name === current.name);
  const next = idx >= 0 && idx < ranks.length - 1 ? ranks[idx + 1] : undefined;
  let span: number;
  if (next) {
    span = next.threshold - current.threshold;
  } else if (idx > 0) {
    // Top rank: reuse the previous band so divisions keep working upwards.
    span = current.threshold - ranks[idx - 1].threshold;
  } else {
    return 3;
  }
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

/** Full display label, e.g. "DIAMOND II" or "MASTERS III" on the very top. */
export function displayRank(elo: number, ranks: RankTier[]): string {
  const rank = rankForElo(elo, ranks);
  return `${rank.name.toUpperCase()} ${divisionName(divisionForElo(elo, ranks))}`;
}

/** Stable identifier for an elo -> rank+division pair (used for announcements). */
export function rankKey(elo: number, ranks: RankTier[]): string {
  const rank = rankForElo(elo, ranks);
  return `${rank.name.toUpperCase()} ${divisionName(divisionForElo(elo, ranks))}`;
}
