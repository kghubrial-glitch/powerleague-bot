import { RankTier } from '../config/settings';

export function rankForElo(elo: number, ranks: RankTier[]): RankTier {
  let current = ranks[0] ?? { name: 'Bronze', threshold: 0 };
  for (const tier of ranks) {
    if (elo >= tier.threshold) current = tier;
  }
  return current;
}