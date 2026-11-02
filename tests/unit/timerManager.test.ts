import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/database/connection';
import { DeadlineRepository } from '../../src/database/repositories/deadlineRepository';
import { TimerManager } from '../../src/services/timerManager';

let db: Database.Database;
let deadlines: DeadlineRepository;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  deadlines = new DeadlineRepository(db);
});

afterEach(() => {
  db.close();
});

function makeManager(calls: string[]) {
  const handlers = {
    teamcode: (matchId: string) => calls.push(`teamcode:${matchId}`),
    ready: (matchId: string) => calls.push(`ready:${matchId}`),
    match: (matchId: string) => calls.push(`match:${matchId}`),
    vote: (matchId: string) => calls.push(`vote:${matchId}`),
    fault_report: (matchId: string) => calls.push(`fault_report:${matchId}`),
  };
  return new TimerManager(deadlines, handlers);
}

describe('TimerManager', () => {
  it('persists and recovers deadlines across a simulated restart', () => {
    const calls: string[] = [];
    const tm1 = makeManager(calls);
    const due = new Date(Date.now() + 5_000).toISOString();
    tm1.schedule('m1', 'teamcode', due);
    expect(deadlines.get('m1', 'teamcode')).toBeDefined();

    // Simulate a restart: new manager reads the same DB.
    const tm2 = makeManager(calls);
    expect(deadlines.get('m1', 'teamcode')).toBeDefined();
    tm2.recoverAll();
    // The deadline should have been re-armed, not fired prematurely.
    expect(calls).toHaveLength(0);
    tm2.stop();
  });

  it('fires overdue deadlines on recovery', async () => {
    const calls: string[] = [];
    const tm = makeManager(calls);
    const past = new Date(Date.now() - 1000).toISOString();
    tm.schedule('m1', 'vote', past);
    // recoverAll uses setImmediate for overdue; wait a tick.
    await new Promise((r) => setTimeout(r, 30));
    tm.recoverAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toContain('vote:m1');
    // fired deadlines are removed
    expect(deadlines.get('m1', 'vote')).toBeUndefined();
    tm.stop();
  });

  it('cancelAllForMatch clears every deadline kind', () => {
    const calls: string[] = [];
    const tm = makeManager(calls);
    const later = new Date(Date.now() + 60_000).toISOString();
    tm.schedule('m1', 'teamcode', later);
    tm.schedule('m1', 'ready', later);
    tm.schedule('m1', 'match', later);
    tm.cancelAllForMatch('m1');
    expect(deadlines.allForMatch('m1')).toHaveLength(0);
    expect(calls).toHaveLength(0);
    tm.stop();
  });

  it('does not double-fire after cancel', () => {
    const calls: string[] = [];
    const tm = makeManager(calls);
    const soon = new Date(Date.now() + 50).toISOString();
    tm.schedule('m1', 'ready', soon);
    tm.cancel('m1', 'ready');
    vi.useFakeTimers();
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
    expect(calls).toHaveLength(0);
  });
});