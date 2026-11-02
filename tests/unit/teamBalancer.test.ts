import { describe, it, expect } from 'vitest';
import { generateBalancedTeams, bestTeamsDeterministic } from '../../src/matchmaking/teamBalancer';
import { QueuePlayer } from '../../src/matchmaking/teamBalancer';

const players = (elos: number[]): QueuePlayer[] =>
  elos.map((elo, i) => ({ discordId: String.fromCharCode(65 + i), elo }));

// A:1500 B:1400 C:1300 D:1200 E:1100 F:1000
const SAMPLE = players([1500, 1400, 1300, 1200, 1100, 1000]);

describe('teamBalancer', () => {
  it('requires exactly six players', () => {
    expect(() => generateBalancedTeams(players([1, 2, 3]), { tolerance: 40 })).toThrow();
    expect(() => generateBalancedTeams(players([1, 2, 3, 4, 5, 6, 7]), { tolerance: 40 })).toThrow();
  });

  it('always produces two disjoint teams of three', () => {
    for (let i = 0; i < 50; i++) {
      const result = generateBalancedTeams(SAMPLE, { tolerance: 40 });
      expect(result.teamA).toHaveLength(3);
      expect(result.teamB).toHaveLength(3);
      const all = [...result.teamA, ...result.teamB].sort();
      expect(all).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect(new Set(result.teamA)).toHaveLength(3);
      expect(new Set(result.teamB)).toHaveLength(3);
    }
  });

  it('finds a balanced arrangement for the sample', () => {
    const result = bestTeamsDeterministic(SAMPLE);
    // Best possible difference is |3300 - 4200|? compute: The example in the
    // spec accepts ~34; this implementation must stay within 40.
    expect(result.diff).toBeLessThanOrEqual(40);
  });

  it('picks the optimal split deterministically with rng=0', () => {
    const rng = () => 0;
    const result = generateBalancedTeams(SAMPLE, { tolerance: 0, rng });
    // With tolerance 0 we must exactly hit the minimum diff. Compute it:
    const elo = { A: 1500, B: 1400, C: 1300, D: 1200, E: 1100, F: 1000 };
    const avg = (ids: string[]) => ids.map((x) => elo[x as keyof typeof elo]).reduce((a, b) => a + b, 0) / 3;
    const diff = Math.abs(avg(result.teamA) - avg(result.teamB));
    let min = Infinity;
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) for (let k = j + 1; k < 6; k++) {
      const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
      const a = [ids[i], ids[j], ids[k]];
      const b = ids.filter((x) => !a.includes(x));
      const d = Math.abs(avg(a) - avg(b));
      min = Math.min(min, d);
    }
    expect(diff).toEqual(min);
  });

  it('introduces randomness across many runs (not always the same split)', () => {
    const splits = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const result = generateBalancedTeams(SAMPLE, { tolerance: 80 });
      const key = [...result.teamA].sort().join('') + '|' + [...result.teamB].sort().join('');
      splits.add(key);
    }
    // With tolerance 80 there should be several viable arrangements.
    expect(splits.size).toBeGreaterThan(1);
  });

  it('splits identically-rated players roughly evenly', () => {
    const equal = players([1000, 1000, 1000, 1000, 1000, 1000]);
    for (let i = 0; i < 50; i++) {
      const result = generateBalancedTeams(equal, { tolerance: 0 });
      expect(result.diff).toBe(0);
    }
  });
});