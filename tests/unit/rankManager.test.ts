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
  { name: 'Silver', threshold: 900 },
  { name: 'Gold', threshold: 1100 },
  { name: 'Diamond', threshold: 1300 },
  { name: 'Mythic', threshold: 1500 },
  { name: 'Legendary', threshold: 1800 },
];

describe('rankManager', () => {
  it('finds the correct rank tier', () => {
    expect(rankForElo(500, RANKS).name).toBe('Bronze');
    expect(rankForElo(950, RANKS).name).toBe('Silver');
    expect(rankForElo(2000, RANKS).name).toBe('Legendary');
  });

  it('splits rank bands into three divisions', () => {
    // Silver spans 200 elo (900->1100), step ~66.6
    expect(divisionForElo(910, RANKS)).toBe(1);
    expect(divisionForElo(990, RANKS)).toBe(2);
    expect(divisionForElo(1090, RANKS)).toBe(3);
  });

  it('uses the top division for the highest rank', () => {
    expect(divisionForElo(2500, RANKS)).toBe(3);
  });

  it('formats the full display label', () => {
    expect(displayRank(990, RANKS)).toBe('SILVER II');
    expect(displayRank(2500, RANKS)).toBe('LEGENDARY');
  });

  it('produces distinct stable keys across divisions', () => {
    expect(rankKey(910, RANKS)).not.toBe(rankKey(990, RANKS));
    expect(rankKey(1400, RANKS)).toBe('DIAMOND:2');
    expect(rankKey(2500, RANKS)).toBe('LEGENDARY:3');
  });

  it('handles an empty rank list defensively', () => {
    expect(rankForElo(1000, [])).toEqual({ name: 'Bronze', threshold: 0 });
  });
});
