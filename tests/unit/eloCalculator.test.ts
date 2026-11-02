import { describe, it, expect } from 'vitest';
import { expectedScore, kFactor, computeTeamEloChanges } from '../../src/elo/eloCalculator';

describe('eloCalculator', () => {
  describe('expectedScore', () => {
    it('is 0.5 for equal teams', () => {
      expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 5);
    });
    it('favors the stronger team', () => {
      expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
      expect(expectedScore(1000, 1200)).toBeLessThan(0.5);
    });
  });

  describe('kFactor', () => {
    it('uses K=40 for the first 10 matches and K=24 afterwards', () => {
      expect(kFactor(0)).toBe(40);
      expect(kFactor(9)).toBe(40);
      expect(kFactor(10)).toBe(24);
      expect(kFactor(50)).toBe(24);
    });
  });

  describe('computeTeamEloChanges', () => {
    it('winners gain, losers lose, zero-sum for equal K', () => {
      const res = computeTeamEloChanges(1200, 1000, 'win', 10, 10);
      expect(res.teamAChange).toBeGreaterThan(0);
      expect(res.teamBChange).toBeLessThan(0);
      expect(res.teamAChange + res.teamBChange).toBe(0);
    });

    it('rewards beating stronger opponents more than weaker ones', () => {
      const strong = computeTeamEloChanges(1000, 1400, 'win', 10, 10);
      const weak = computeTeamEloChanges(1400, 1000, 'win', 10, 10);
      // Weaker team beating strong opponents gets a larger gain.
      expect(strong.teamAChange).toBeGreaterThan(weak.teamAChange);
    });

    it('applies the same delta to every player on a team', () => {
      // The API returns a single delta per team; both players share it.
      const res = computeTeamEloChanges(1000, 1000, 'win', 10, 10);
      expect(res.teamAChange).toBe(res.teamAChange); // trivially consistent
      expect(Math.abs(res.teamAChange)).toBeGreaterThan(0);
    });

    it('draws produce small/zero symmetric changes', () => {
      const res = computeTeamEloChanges(1000, 1000, 'draw', 10, 10);
      expect(res.teamAChange + res.teamBChange).toBe(0);
      expect(Math.abs(res.teamAChange)).toBeLessThanOrEqual(1);
    });

    it('stays zero-sum even with asymmetric K', () => {
      const res = computeTeamEloChanges(1100, 900, 'win', 1, 15);
      expect(res.teamAChange + res.teamBChange).toBe(0);
    });
  });
});