import { ScrimDatabase } from '../connection';
import { UserRow } from '../../types';

export class UserRepository {
  constructor(private db: ScrimDatabase) {}

  getById(discordId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) as UserRow | undefined;
  }

  /** Resets every registered player's Elo to the starting value (0). Returns the count reset. */
  resetAllElo(resetTo = 0): number {
    const users = this.listAll();
    const tx = this.db.transaction(() => {
      for (const u of users) {
        this.db
          .prepare('UPDATE users SET elo = ?, peak_elo = ? WHERE discord_id = ?')
          .run(resetTo, resetTo, u.discord_id);
        this.db
          .prepare(
            `INSERT INTO elo_history (discord_id, match_id, previous_elo, elo_change, new_elo)
             VALUES (?, 'admin-reset', ?, ?, ?)`
          )
          .run(u.discord_id, u.elo, resetTo - u.elo, resetTo);
      }
    });
    tx();
    return users.length;
  }

  /** Returns the user row, creating a default profile if none exists. */
  ensureUser(discordId: string, username: string): UserRow {
    const existing = this.getById(discordId);
    if (existing) {
      if (existing.username !== username) {
        this.db.prepare('UPDATE users SET username = ? WHERE discord_id = ?').run(username, discordId);
        existing.username = username;
      }
      return existing;
    }
    const elo = 0;
    this.db
      .prepare(
        `INSERT INTO users (discord_id, username, elo, peak_elo)
         VALUES (?, ?, ?, ?)`
      )
      .run(discordId, username, elo, elo);
    return this.getById(discordId)!;
  }

  listAll(): UserRow[] {
    return this.db.prepare('SELECT * FROM users').all() as UserRow[];
  }

  leaderboard(limit: number, offset: number, minMatches: number): UserRow[] {
    return this.db
      .prepare(
        `SELECT * FROM users
         WHERE total_matches >= ?
         ORDER BY elo DESC, peak_elo DESC
         LIMIT ? OFFSET ?`
      )
      .all(minMatches, limit, offset) as UserRow[];
  }

  countLeaderboard(minMatches: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM users WHERE total_matches >= ?')
      .get(minMatches) as { c: number };
    return row.c;
  }

  /**
   * Applies an Elo change and updates per-player stats. Streaks are signed
   * (positive = wins, negative = losses) and reset when interrupted.
   * The caller wraps this in a transaction where needed.
   */
  applyEloChange(
    discordId: string,
    matchId: string,
    previousElo: number,
    eloChange: number,
    outcome: 'win' | 'loss' | 'draw',
    timestamp: string
  ): void {
    const row = this.getById(discordId);
    if (!row) return;
    const newElo = previousElo + eloChange;

    let nextStreak = row.current_streak;
    if (outcome === 'win') nextStreak = row.current_streak >= 0 ? row.current_streak + 1 : 1;
    else if (outcome === 'loss') nextStreak = row.current_streak <= 0 ? row.current_streak - 1 : -1;
    else nextStreak = 0;

    this.db
      .prepare(
        `UPDATE users SET
           elo = ?,
           peak_elo = MAX(peak_elo, ?),
           wins = wins + ?,
           losses = losses + ?,
           draws = draws + ?,
           total_matches = total_matches + 1,
           current_streak = ?,
           best_streak = MAX(best_streak, ?),
           last_match_at = ?
         WHERE discord_id = ?`
      )
      .run(
        newElo,
        newElo,
        outcome === 'win' ? 1 : 0,
        outcome === 'loss' ? 1 : 0,
        outcome === 'draw' ? 1 : 0,
        nextStreak,
        Math.abs(nextStreak),
        timestamp,
        discordId
      );
    this.db
      .prepare(
        `INSERT INTO elo_history (discord_id, match_id, previous_elo, elo_change, new_elo)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(discordId, matchId, previousElo, eloChange, newElo);
  }

  /**
   * Resets a player's Elo rating to the starting value (0), also resetting
   * peak Elo so the profile reflects the fresh rating. Other statistics
   * (wins/losses/matches) are preserved — only the rating resets.
   */
  resetElo(discordId: string, resetTo = 0): boolean {
    const existing = this.getById(discordId);
    if (!existing) return false;
    this.db
      .prepare('UPDATE users SET elo = ?, peak_elo = ? WHERE discord_id = ?')
      .run(resetTo, resetTo, discordId);
    this.db
      .prepare(
        `INSERT INTO elo_history (discord_id, match_id, previous_elo, elo_change, new_elo)
         VALUES (?, 'admin-reset', ?, ?, ?)`
      )
      .run(discordId, existing.elo, resetTo - existing.elo, resetTo);
    return true;
  }

  getEloHistory(discordId: string, limit: number, offset: number): EloHistoryEntry[] {
    return this.db
      .prepare(
        `SELECT e.*, m.team_a_players, m.team_b_players, m.map, m.winner, m.format
         FROM elo_history e
         LEFT JOIN matches m ON m.match_id = e.match_id
         WHERE e.discord_id = ?
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(discordId, limit, offset) as unknown as EloHistoryEntry[];
  }
}

export interface EloHistoryEntry {
  id: number;
  discord_id: string;
  match_id: string;
  previous_elo: number;
  elo_change: number;
  new_elo: number;
  created_at: string;
  team_a_players: string;
  team_b_players: string;
  map: string | null;
  winner: 'A' | 'B' | 'draw' | null;
  format: string;
}