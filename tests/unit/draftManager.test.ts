import { describe, it, expect } from 'vitest';
import {
  draftPool,
  DRAFT_ORDER,
  captainForSlot,
  targetForSlot,
  isDraftComplete,
  DRAFT_PICKS,
} from '../../src/matches/draftManager';
import { DraftRow } from '../../src/database/repositories/draftRepository';
import { summarizeDraft } from '../../src/matches/draftManager';

const makeDraft = (pool: string[], currentTurn: 'A' | 'B' | null, turnIndex = 0): DraftRow => ({
  match_id: 'scrim-test',
  status: 'selecting',
  captain_a: 'capa',
  captain_b: 'capb',
  current_turn: currentTurn,
  pool: JSON.stringify(pool),
  turn_index: turnIndex,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe('draftManager', () => {
  it('assigns the two highest-Elo players as captains', () => {
    const { captainA, captainB, pool } = draftPool([
      { discordId: 'a', elo: 1450 },
      { discordId: 'b', elo: 1200 },
      { discordId: 'c', elo: 1300 },
      { discordId: 'd', elo: 1100 },
      { discordId: 'e', elo: 1000 },
      { discordId: 'f', elo: 1500 },
    ]);
    expect(captainA).toBe('f'); // highest
    expect(captainB).toBe('a'); // second-highest
    expect(pool).toHaveLength(4);
    expect(pool).not.toContain('f');
    expect(pool).not.toContain('a');
  });

  it('uses the snake order A, B, B, A', () => {
    expect(DRAFT_ORDER).toEqual(['A', 'B', 'B', 'A']);
    expect(captainForSlot(0)).toBe('A');
    expect(captainForSlot(1)).toBe('B');
    expect(captainForSlot(2)).toBe('B');
    expect(captainForSlot(3)).toBe('A');
    expect(targetForSlot(0)).toBe('A');
    expect(targetForSlot(1)).toBe('B');
  });

  it('requires exactly six distinct players', () => {
    expect(() => draftPool([{ discordId: 'a', elo: 1000 }, { discordId: 'b', elo: 1000 }])).toThrow();
    expect(() =>
      draftPool([
        { discordId: 'a', elo: 1000 },
        { discordId: 'a', elo: 1000 },
        { discordId: 'b', elo: 1000 },
        { discordId: 'c', elo: 1000 },
        { discordId: 'd', elo: 1000 },
        { discordId: 'e', elo: 1000 },
      ])
    ).toThrow();
  });

  it('completes after four picks', () => {
    expect(isDraftComplete(0)).toBe(false);
    expect(isDraftComplete(3)).toBe(false);
    expect(isDraftComplete(4)).toBe(true);
    expect(DRAFT_PICKS).toBe(4);
  });

  it('summarizes draft picks into team lists', () => {
    const draft = makeDraft(['p3', 'p4'], 'A', 2);
    const { teamAList, teamBList, remaining } = summarizeDraft(draft, [
      { turn: 'A', picked_id: 'p1' },
      { turn: 'B', picked_id: 'p2' },
      { turn: 'B', picked_id: 'p3' },
    ]);
    expect(teamAList).toEqual(['p1']);
    expect(teamBList).toEqual(['p2', 'p3']);
    expect(remaining).toEqual(['p3', 'p4']);
  });
});