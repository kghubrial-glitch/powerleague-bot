import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/database/connection';
import { Repositories } from '../../src/database/repositories';
import { MatchRow } from '../../src/types';

let db: Database.Database;
let repos: Repositories;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = new Repositories(db);
  repos.maps.ensureDefaults();
});

afterEach(() => {
  db.close();
});

describe('Repositories', () => {
  it('seeds default maps', () => {
    const maps = repos.maps.enabled();
    expect(maps).toHaveLength(14);
    // every map must carry one of the five canonical game modes
    const modes = new Set(maps.map((m) => m.game_mode));
    expect([...modes].sort()).toEqual(['Bounty', 'Brawl Ball', 'Gem Grab', 'Knockout']);
    // exactly one Brawl Ball grouping: four maps share the canonical spelling
    expect(maps.filter((m) => m.game_mode === 'Brawl Ball')).toHaveLength(4);
  });

  it('normalizes game-mode input to the canonical spellings', () => {
    const added = repos.maps.add('Test Dummy', 'brawlball');
    expect(added.game_mode).toBe('Brawl Ball');
    // display-name spelling also normalizes
    expect(repos.maps.add('Test Dummy', 'Brawl Ball').game_mode).toBe('Brawl Ball');
    expect(repos.maps.add('Test Dummy', 'BRAWL BALL').game_mode).toBe('Brawl Ball');
    expect(repos.maps.setGameMode('Test Dummy', 'knockout')).toBe(true);
    expect(repos.maps.getByName('Test Dummy')?.game_mode).toBe('Knockout');
    expect(repos.maps.setGameMode('Test Dummy', 'hotzone')).toBe(true);
    expect(repos.maps.getByName('Test Dummy')?.game_mode).toBe('Hot Zone');
    // an unknown mode is cleared rather than stored.
    expect(repos.maps.setGameMode('Test Dummy', 'BrAnDwAIT A')).toBe(true);
    expect(repos.maps.getByName('Test Dummy')?.game_mode).toBeNull();
  });

  it('allows exactly one fault report per player per match', () => {
    repos.users.ensureUser('a', 'A');
    repos.users.ensureUser('b', 'B');
    expect(repos.faults.add({ match_id: 'm1', reporter_id: 'a', reported_player_id: 'b', reason: 'Someone dodged' })).toBe(true);
    // same reporter cannot submit a second report (even a general one)
    expect(repos.faults.add({ match_id: 'm1', reporter_id: 'a', reported_player_id: '', reason: 'Other' })).toBe(false);
    // general report by a different player is stored and tallied
    expect(repos.faults.add({ match_id: 'm1', reporter_id: 'b', reported_player_id: '', reason: 'TeamCode did not work' })).toBe(true);
    expect(repos.faults.reporterCount('m1')).toBe(2);
    expect(repos.faults.talliesByReported('m1')).toEqual([
      { reported_player_id: 'b', count: 1, reasons: { 'Someone dodged': 1 } },
    ]);
    expect(repos.faults.generalReasonTallies('m1')).toEqual({ 'TeamCode did not work': 1 });
    // a brand-new reporter can still point at the same player
    repos.users.ensureUser('c', 'C');
    expect(repos.faults.add({ match_id: 'm1', reporter_id: 'c', reported_player_id: 'b', reason: 'Someone dodged' })).toBe(true);
    expect(repos.faults.countForReported('m1', 'b')).toBe(2);
    expect(repos.faults.reporterCount('m1')).toBe(3);
  });

  it('tallies reported players and general reasons', () => {
    repos.faults.add({ match_id: 'm2', reporter_id: 'a', reported_player_id: 'x', reason: 'Someone dodged' });
    repos.faults.add({ match_id: 'm2', reporter_id: 'c', reported_player_id: 'x', reason: 'Someone dodged' });
    repos.faults.add({ match_id: 'm2', reporter_id: 'd', reported_player_id: 'y', reason: 'Someone did not join' });
    repos.faults.add({ match_id: 'm2', reporter_id: 'b', reported_player_id: '', reason: 'Lobby problem' });
    const tallies = repos.faults.talliesByReported('m2');
    expect(tallies[0]).toMatchObject({ reported_player_id: 'x', count: 2 });
    expect(repos.faults.generalReasonTallies('m2')).toEqual({ 'Lobby problem': 1 });
    expect(repos.faults.reporterCount('m2')).toBe(4);
  });

  it('creates default user profile on first access', () => {
    const user = repos.users.ensureUser('123', 'Alice');
    expect(user.elo).toBe(0);
    expect(user.peak_elo).toBe(0);
    expect(user.total_matches).toBe(0);
    // second call is idempotent
    const again = repos.users.ensureUser('123', 'Alice');
    expect(again.discord_id).toBe('123');
  });

  it('generates sequential scrim ids', () => {
    expect(repos.matches.nextMatchId()).toBe('scrim-0001');
    expect(repos.matches.nextMatchId()).toBe('scrim-0002');
  });

  it('records per-map statistics and aggregates win rates', () => {
    repos.users.ensureUser('1', 'Alice');
    repos.mapStats.record('1', 'Shooting Star', 'win');
    repos.mapStats.record('1', 'Shooting Star', 'loss');
    repos.mapStats.record('1', 'Shooting Star', 'win');
    repos.mapStats.record('1', 'Safe Zone', 'loss');

    const stats = repos.mapStats.forPlayer('1');
    expect(stats).toHaveLength(2);
    const shooting = stats.find((s) => s.map === 'Shooting Star')!;
    expect(shooting.wins).toBe(2);
    expect(shooting.losses).toBe(1);
    expect(repos.mapStats.winRate('1', 'Shooting Star')).toBeCloseTo(2 / 3);
    expect(repos.mapStats.favoriteMap('1')).toBe('Shooting Star');
    expect(repos.mapStats.winRate('1', 'Unknown Map')).toBeUndefined();
  });

  it('applies Elo changes with history and peak tracking', () => {
    repos.users.ensureUser('p1', 'P1');
    const before = repos.users.getById('p1')!;
    repos.users.applyEloChange('p1', 'scrim-0001', before.elo, 24, 'win', new Date().toISOString());
    const after = repos.users.getById('p1')!;
    expect(after.elo).toBe(24);
    expect(after.peak_elo).toBe(24);
    expect(after.wins).toBe(1);
    expect(after.total_matches).toBe(1);
    expect(repos.users.getEloHistory('p1', 10, 0)).toHaveLength(1);
  });

  it('keeps peak_elo through a loss', () => {
    repos.users.ensureUser('p1', 'P1');
    repos.users.applyEloChange('p1', 'm1', 0, 40, 'win', new Date().toISOString());
    // force a loss from current ELO
    const cur = repos.users.getById('p1')!;
    repos.users.applyEloChange('p1', 'm2', cur.elo, -20, 'loss', new Date().toISOString());
    const final = repos.users.getById('p1')!;
    expect(final.elo).toBe(20);
    expect(final.peak_elo).toBe(40);
  });

  it('tracks signed win/loss streaks', () => {
    repos.users.ensureUser('p1', 'P1');
    repos.users.applyEloChange('p1', 'm1', 0, 10, 'win', 't1');
    expect(repos.users.getById('p1')!.current_streak).toBe(1);
    repos.users.applyEloChange('p1', 'm2', 10, 10, 'win', 't2');
    expect(repos.users.getById('p1')!.current_streak).toBe(2);
    expect(repos.users.getById('p1')!.best_streak).toBe(2);
    // a loss resets the win streak and starts a loss streak
    repos.users.applyEloChange('p1', 'm3', 20, -5, 'loss', 't3');
    expect(repos.users.getById('p1')!.current_streak).toBe(-1);
    // consecutive losses continue the losing streak
    repos.users.applyEloChange('p1', 'm4', 15, -5, 'loss', 't4');
    expect(repos.users.getById('p1')!.current_streak).toBe(-2);
    // a draw resets the streak
    repos.users.applyEloChange('p1', 'm5', 10, 0, 'draw', 't5');
    expect(repos.users.getById('p1')!.current_streak).toBe(0);
  });

  it('attaches message id after creation', () => {
    repos.matches.create({
      match_id: 'm1',
      team_a_players: '["a","b","c"]',
      team_b_players: '["d","e","f"]',
      team_a_avg_elo: 1000,
      team_b_avg_elo: 1000,
      map: 'x',
      game_mode: null,
      format: 'best_of_3',
      channel_id: 'c',
      message_id: null,
    });
    expect(repos.matches.get('m1')!.message_id).toBeNull();
    repos.matches.setMessageId('m1', 'msg-42');
    expect(repos.matches.get('m1')!.message_id).toBe('msg-42');
    repos.matches.confirmResult('m1', 'A', 2, 0);
    const row = repos.matches.get('m1')!;
    expect(row.status).toBe('confirmed');
    expect(row.winner).toBe('A');
    expect(row.team_a_score).toBe(2);
    expect(row.team_b_score).toBe(0);
  });

  it('cancelled matches cannot receive a normal result', () => {
    repos.matches.create({
      match_id: 'm1',
      team_a_players: '["a","b","c"]',
      team_b_players: '["d","e","f"]',
      team_a_avg_elo: 1000,
      team_b_avg_elo: 1000,
      map: 'x',
      game_mode: null,
      format: 'best_of_3',
      channel_id: 'c',
    });
    repos.matches.cancel('m1', 'someone did not join');
    repos.matches.confirmResult('m1', 'A', 2, 0);
    // confirmResult overwrites status; the manager layer (matchManager)
    // guards against applying results to cancelled matches.
    const row = repos.matches.get('m1')!;
    expect(row.status).toBe('confirmed');
    expect(row.cancellation_reason).toBe('someone did not join');
  });

  it('prevents duplicate queue entries and removes by set', () => {
    repos.queue.add({ discord_id: '1', username: 'a', elo_at_join: 1000 });
    repos.queue.add({ discord_id: '1', username: 'a', elo_at_join: 1000 });
    expect(repos.queue.count()).toBe(1);
    repos.queue.add({ discord_id: '2', username: 'b', elo_at_join: 1100 });
    repos.queue.removeBySet(['1', '2']);
    expect(repos.queue.count()).toBe(0);
  });

  it('transaction is atomic and reusable', () => {
    const tx = repos.transaction(() => {
      repos.queue.add({ discord_id: 'x', username: 'x', elo_at_join: 1 });
      if (Math.random() < 0) throw new Error('boom');
      return 'done';
    });
    expect(tx).toBe('done');
    expect(repos.queue.count()).toBe(1);
  });

  it('match creation round-trips team layout and status', () => {
    const match = repos.matches.create({
      match_id: 'scrim-0001',
      team_a_players: JSON.stringify(['a', 'b', 'c']),
      team_b_players: JSON.stringify(['d', 'e', 'f']),
      team_a_avg_elo: 1100,
      team_b_avg_elo: 1050,
      map: 'Shooting Star',
      game_mode: null,
      format: 'best_of_3',
      channel_id: 'ch',
      message_id: 'msg',
    });
    expect(match.status).toBe('awaiting_teamcode');
    expect(repos.matches.teamAIds(match)).toEqual(['a', 'b', 'c']);
    expect(repos.matches.isParticipant(match, 'd')).toBe(true);
    expect(repos.matches.getActiveByPlayer('d')?.match_id).toBe('scrim-0001');
    expect(repos.matches.getByChannel('ch')?.match_id).toBe('scrim-0001');
  });

  it('votes are unique per player', () => {
    repos.matches.create({ match_id: 'm1', team_a_players: '["a","b","c"]', team_b_players: '["d","e","f"]', team_a_avg_elo: 1000, team_b_avg_elo: 1000, map: 'x', game_mode: null, format: 'best_of_3', channel_id: 'c', message_id: 'm' });
    expect(repos.matches.createVote('m1', 'a', 'A')).toBe(true);
    expect(repos.matches.createVote('m1', 'a', 'B')).toBe(false);
    expect(repos.matches.getVotes('m1')).toHaveLength(1);
  });

  it('team code only accepts the first submission', () => {
    repos.matches.create({ match_id: 'm1', team_a_players: '["a","b","c"]', team_b_players: '["d","e","f"]', team_a_avg_elo: 1000, team_b_avg_elo: 1000, map: 'x', game_mode: null, format: 'best_of_3', channel_id: 'c', message_id: 'm' });
    expect(repos.matches.setTeamCode('m1', 'abc', 'a', 'now')).toBe(true);
    expect(repos.matches.setTeamCode('m1', 'xyz', 'b', 'now')).toBe(false);
    const row = repos.matches.get('m1')!;
    expect(row.team_code).toBe('abc');
    repos.matches.resetTeamCode('m1');
    expect(repos.matches.get('m1')!.team_code).toBeNull();
  });

  it('deadlines survive persistence and are exact', () => {
    repos.deadlines.upsert('m1', 'teamcode', '2026-01-01T00:00:00Z', null);
    repos.deadlines.upsert('m1', 'ready', '2026-01-02T00:00:00Z', null);
    expect(repos.deadlines.allForMatch('m1')).toHaveLength(2);
    expect(repos.deadlines.get('m1', 'teamcode')).toBeDefined();
    repos.deadlines.deleteAllForMatch('m1');
    expect(repos.deadlines.allForMatch('m1')).toHaveLength(0);
  });

  it('panels are singleton rows', () => {
    repos.panels.set('ch1', 'msg1');
    repos.panels.set('ch2', 'msg2');
    const rows = db.prepare('SELECT * FROM panel_state').all();
    expect(rows).toHaveLength(1);
    expect(repos.panels.get()?.message_id).toBe('msg2');
  });

  it('dodge upserts keep the report tally and update status', () => {
    repos.faults.addDodge({ match_id: 'm1', reported_player_id: 'x', reports: 5, status: 'awaiting_moderator' });
    // A moderator decision must not wipe the report-count.
    repos.faults.addDodge({ match_id: 'm1', reported_player_id: 'x', reports: 0, status: 'moderator_cooldown' });
    const entries = repos.faults.dodgeEntries('m1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reported_player_id: 'x', reports: 5, status: 'moderator_cooldown' });
    // A lower count must also not reduce it.
    repos.faults.addDodge({ match_id: 'm1', reported_player_id: 'x', reports: 2, status: 'moderator_clear' });
    expect(repos.faults.dodgeEntries('m1')[0].reports).toBe(5);
  });
});