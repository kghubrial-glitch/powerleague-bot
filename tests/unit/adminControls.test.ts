import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/database/connection';
import { Repositories } from '../../src/database/repositories';
import { QueueManager } from '../../src/matchmaking/queueManager';

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

function makeCtx(repos: Repositories): Ctx {
  return {
    db: { repos },
    settings: { queueInactiveAfter: 0 },
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

type Ctx = {
  db: { repos: Repositories };
  settings: { queueInactiveAfter: number };
  client: unknown;
  queue: unknown;
  logs: unknown;
  timers: unknown;
  matches: unknown;
  maps: unknown;
  elo: unknown;
  audits: unknown;
};

describe('UserRepository.resetElo', () => {
  it('resets a single player and writes an audit-history row', () => {
    repos.users.ensureUser('a', 'Alpha');
    repos.users.applyEloChange('a', 'scrim-0001', 1000, 250, 'win', new Date().toISOString());
    expect(repos.users.getById('a')!.elo).toBe(1250);

    expect(repos.users.resetElo('a')).toBe(true);
    const user = repos.users.getById('a')!;
    expect(user.elo).toBe(1000);
    expect(user.peak_elo).toBe(1000);
  });

  it('returns false for an unknown player', () => {
    expect(repos.users.resetElo('nobody')).toBe(false);
  });
});

describe('UserRepository.resetAllElo', () => {
  it('resets every player to 1000', () => {
    repos.users.ensureUser('a', 'Alpha');
    repos.users.ensureUser('b', 'Bravo');
    repos.users.applyEloChange('a', 'scrim-0001', 1000, 150, 'win', new Date().toISOString());
    repos.users.applyEloChange('b', 'scrim-0001', 1000, -80, 'loss', new Date().toISOString());

    const count = repos.users.resetAllElo();
    expect(count).toBe(2);
    expect(repos.users.getById('a')!.elo).toBe(1000);
    expect(repos.users.getById('b')!.elo).toBe(1000);
    expect(repos.users.getById('a')!.peak_elo).toBe(1000);
  });
});

describe('QueueManager.clearQueue', () => {
  it('removes all queued players and returns the count', async () => {
    repos.queue.add({ discord_id: 'a', username: 'Alpha', elo_at_join: 1100 });
    repos.queue.add({ discord_id: 'b', username: 'Bravo', elo_at_join: 1200 });

    const qm = new QueueManager(makeCtx(repos) as never, { onFull: async () => {} });
    const removed = await qm.clearQueue('Test clear');

    expect(removed).toBe(2);
    expect(repos.queue.count()).toBe(0);
  });

  it('is a no-op with zero players', async () => {
    const qm = new QueueManager(makeCtx(repos) as never, { onFull: async () => {} });
    expect(await qm.clearQueue()).toBe(0);
  });
});

describe('QueueManager.banFromQueue / unbanFromQueue', () => {
  it('bans a player and removes them from the queue', async () => {
    repos.queue.add({ discord_id: 'a', username: 'Alpha', elo_at_join: 1100 });
    const qm = new QueueManager(makeCtx(repos) as never, { onFull: async () => {} });

    const result = await qm.banFromQueue('a', 'Alpha', 'Toxic behavior', 'admin1');
    expect(result.ok).toBe(true);
    expect(repos.queue.get('a')).toBeUndefined();

    const now = new Date().toISOString();
    const cooldown = repos.cooldowns.active('a', now);
    expect(cooldown).toBeDefined();
    expect(cooldown!.reason).toContain('Toxic behavior');
  });

  it('rejects re-banning an already permanently banned player', async () => {
    const qm = new QueueManager(makeCtx(repos) as never, { onFull: async () => {} });
    await qm.banFromQueue('a', 'Alpha', 'First', 'admin1');
    const second = await qm.banFromQueue('a', 'Alpha', 'Second', 'admin1');
    expect(second.ok).toBe(false);
  });

  it('unbans a player so they can queue again', async () => {
    const qm = new QueueManager(makeCtx(repos) as never, { onFull: async () => {} });
    await qm.banFromQueue('a', 'Alpha', 'Toxic', 'admin1');

    const unban = await qm.unbanFromQueue('a', 'admin1');
    expect(unban.ok).toBe(true);
    const now = new Date().toISOString();
    expect(repos.cooldowns.active('a', now)).toBeUndefined();

    // Banning again after unban succeeds.
    const reban = await qm.banFromQueue('a', 'Alpha', 'Again', 'admin1');
    expect(reban.ok).toBe(true);
  });

  it('fails to unban a player with no cooldown', async () => {
    const qm = new QueueManager(makeCtx(repos) as never, { onFull: async () => {} });
    const result = await qm.unbanFromQueue('nobody', 'admin1');
    expect(result.ok).toBe(false);
  });
});