import { MapRow } from '../types';

/**
 * Chooses a map from the enabled pool, avoiding the most recently used maps
 * when enough alternatives exist. Falls back to a fully random draw otherwise.
 */
export function selectMap(
  enabledMaps: MapRow[],
  recentMapIds: number[],
  mode: 'unique' | 'random',
  rng: () => number = Math.random
): MapRow {
  if (enabledMaps.length === 0) {
    throw new Error('No enabled maps available. An admin must enable at least one map.');
  }
  if (mode === 'random' || enabledMaps.length < 2) {
    return enabledMaps[Math.floor(rng() * enabledMaps.length)];
  }

  // Skip the N-1 most recently used maps (all but one, so we always have an option).
  const skipCount = Math.min(enabledMaps.length - 1, recentMapIds.length);
  const recentSet = new Set(recentMapIds.slice(0, skipCount));
  const candidates = enabledMaps.filter((m) => !recentSet.has(m.map_id));

  const pool = candidates.length > 0 ? candidates : enabledMaps;
  return pool[Math.floor(rng() * pool.length)];
}