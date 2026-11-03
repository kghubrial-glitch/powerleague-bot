import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/database/connection';
import { Repositories } from '../../src/database/repositories';
import { QueueManager } from '../../src/matchmaking/queueManager';
import { matchChannelName, prettyMatchId } from '../../src/format';
import { parseDbTimestamp } from '../../src/presentation/dbTime';

let db: Database.Database;
let repos: Repositories;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = new Repositories(db);
});

afterEach(() => {
  db.close();
});

describe('prettyMatchId', () => {
  it('rebrands scrim-XXXX ids for display', () => {
    expect(prettyMatchId('scrim-0042')).toBe('svm-0042');
  });

  it('leaves unrelated ids untouched', () => {
    expect(prettyMatchId('abc-123')).toBe('abc-123');
  });
});

describe('parseDbTimestamp', () => {
  it('parses SQLite and ISO timestamps as UTC', () => {
    const sqlite = parseDbTimestamp('2026-01-01 12:00:00');
    const iso = parseDbTimestamp('2026-01-01T12:00:00.000Z');
    expect(sqlite).toBe(iso);
    expect(Number.isNaN(sqlite)).toBe(false);
  });
});

describe('matchChannelName', () => {
  it('appends a status suffix to the base name', () => {
    expect(matchChannelName('scrim-0042', 'awaiting_teamcode')).toBe('svm-0042-code');
    expect(matchChannelName('scrim-0042', 'in_progress')).toBe('svm-0042-live');
    expect(matchChannelName('scrim-0042', 'confirmed')).toBe('svm-0042-done');
  });

  it('covers every match status with a unique suffix (archived shares done)', () => {
    const statuses = ['drafting', 'awaiting_teamcode', 'awaiting_ready', 'in_progress', 'voting', 'confirmed', 'disputed', 'cancelled', 'timed_out', 'archived'] as const;
    const names = new Set(statuses.map((s) => matchChannelName('scrim-0001', s)));
    // 10 statuses, but archived intentionally reuses confirmed's `-done` suffix.
    expect(names.size).toBe(statuses.length - 1);
  });
});

describe('QueueManager.sweepStale', () => {
  it('removes queued players who exceeded the inactivity window', async () => {
    repos.queue.add({ discord_id: 'a', username: 'A', elo_at_join: 1000 });
    repos.queue.add({ discord_id: 'b', username: 'B', elo_at_join: 1100 });

    const ctx = makeCtx(repos, 30);
    const qm = new QueueManager(ctx as never, { onFull: async () => {} });

    // age only player A past the cutoff
    const iso = (msAgoSec: number) => new Date(Date.now() - msAgoSec * 1000).toISOString();
    db.prepare('UPDATE queue_entries SET joined_at = ? WHERE discord_id = ?').run(iso(60), 'a');

    await qm.sweepStale();

    expect(repos.queue.get('a')).toBeUndefined();
    expect(repos.queue.get('b')).toBeDefined();
  });

  it('is a no-op when the inactivity setting is disabled', async () => {
    repos.queue.add({ discord_id: 'a', username: 'A', elo_at_join: 1000 });
    const ctx = makeCtx(repos, 0);
    const qm = new QueueManager(ctx as never, { onFull: async () => {} });
    await qm.sweepStale();
    expect(repos.queue.get('a')).toBeDefined();
  });
});

type Ctx = {
  db: { repos: Repositories };
  settings: { queueInactiveAfter: number; queueChannelId?: string };
  client: unknown;
  queue: unknown;
  logs: unknown;
  timers: unknown;
  matches: unknown;
  maps: unknown;
  elo: unknown;
  audits: unknown;
};

function makeCtx(repos: Repositories, queueInactiveAfter: number): Ctx {
  return {
    db: { repos },
    settings: { queueInactiveAfter },
    client: { users: { fetch: async () => null }, channels: { cache: new Map() } },
    queue: {},
    logs: {},
    timers: {},
    matches: {},
    maps: {},
    elo: {},
    audits: {},
  };
}