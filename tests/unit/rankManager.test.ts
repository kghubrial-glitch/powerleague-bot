import { describe, it, expect } from 'vitest';
import {
  rankForElo,
  divisionForElo,
  divisionName,
  displayRank,
  rankKey,
} from '../../src/elo/rankManager';
import { RankTier } from '../../src/config/settings';

const RANKS: RankTier[] = [
  { name: 'Bronze', threshold: 0 },
  { name: 'Silver', threshold: 2100 },
  { name: 'Gold', threshold: 4300 },
  { name: 'Diamond', threshold: 6500 },
  { name: 'Mythic', threshold: 8700 },
  { name: 'Legendary', threshold: 10900 },
  { name: 'Masters', threshold: 13000 },
];

describe('rankManager', () => {
  it('finds the correct rank tier', () => {
    expect(rankForElo(500, RANKS).name).toBe('Bronze');
    expect(rankForElo(5000, RANKS).name).toBe('Gold');
    expect(rankForElo(12000, RANKS).name).toBe('Legendary');
    expect(rankForElo(15000, RANKS).name).toBe('Masters');
  });

  it('splits rank bands into three divisions', () => {
    // Silver spans 2200 elo (2100->4300), step ~733
    expect(divisionForElo(2200, RANKS)).toBe(1);
    expect(divisionForElo(3300, RANKS)).toBe(2);
    expect(divisionForElo(4200, RANKS)).toBe(3);
  });

  it('uses the top division for the highest rank', () => {
    expect(divisionForElo(14500, RANKS)).toBe(3);
  });

  it('formats the full display label with I/II/III divisions everywhere', () => {
    expect(displayRank(500, RANKS)).toBe('BRONZE I');
    expect(displayRank(3300, RANKS)).toBe('SILVER II');
    expect(displayRank(14500, RANKS)).toBe('MASTERS III');
  });

  it('produces distinct stable keys across divisions', () => {
    expect(rankKey(2200, RANKS)).not.toBe(rankKey(3300, RANKS));
    expect(rankKey(7500, RANKS)).toBe('DIAMOND II');
    expect(rankKey(14500, RANKS)).toBe('MASTERS III');
  });

  it('handles an empty rank list defensively', () => {
    expect(rankForElo(1000, [])).toEqual({ name: 'Bronze', threshold: 0 });
  });
});
