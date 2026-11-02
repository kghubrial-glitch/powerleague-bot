import { describe, it, expect } from 'vitest';
import { selectMap } from '../../src/matchmaking/mapSelector';
import { MapRow } from '../../src/types';

const maps: MapRow[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, map_id) => ({
  map_id,
  name,
  game_mode: null,
  enabled: 1,
  last_selected_at: null,
}));

describe('mapSelector', () => {
  it('throws when the pool is empty', () => {
    expect(() => selectMap([], [], 'unique')).toThrow();
  });

  it('avoids recent maps when possible', () => {
    // Only one recent map id repeats forever with 6 maps and skip=1.
    const ids = maps.map((m) => m.map_id);
    const selectedIds = new Set<number>();
    let recent: number[] = [];
    for (let i = 0; i < 40; i++) {
      const pick = selectMap(maps, recent, 'unique', () => 0.99);
      selectedIds.add(pick.map_id);
      recent = [pick.map_id, ...recent].slice(0, 5);
    }
    void ids;
    // With deterministic high rng, selection should bounce among non-recent.
    expect(selectedIds.size).toBeGreaterThan(1);
  });

  it('never repeats the immediately-previous map with 2+ maps', () => {
    let recent: number[] = [];
    const prev = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const pick = selectMap(maps.slice(0, 2), recent, 'unique', () => 0.99);
      prev.add(pick.map_id);
      recent = [pick.map_id, ...recent].slice(0, 5);
    }
    // Check no two consecutive picks are equal.
    recent = [];
    let last: number | null = null;
    let consecutive = false;
    for (let i = 0; i < 30; i++) {
      const pick = selectMap(maps.slice(0, 2), recent, 'unique', () => 0.99);
      if (last === pick.map_id) consecutive = true;
      last = pick.map_id;
      recent = [pick.map_id, ...recent].slice(0, 5);
    }
    expect(consecutive).toBe(false);
  });

  it('random mode ignores recency', () => {
    const count = new Map<number, number>();
    let recent: number[] = [];
    (() => {
      let calls = 0;
      const rng = () => {
        calls++;
        return 0; // deterministic index 0
      };
      for (let i = 0; i < 10; i++) {
        const pick = selectMap(maps, recent, 'random', rng);
        count.set(pick.map_id, (count.get(pick.map_id) ?? 0) + 1);
        recent = [pick.map_id, ...recent].slice(0, 5);
      }
    })();
    expect(count.get(0)).toBe(10);
  });
});