import Database from 'better-sqlite3';

export type ScrimDatabase = Database.Database;

export function openDatabase(dbPath: string): ScrimDatabase {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: ScrimDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id      TEXT PRIMARY KEY,
      username        TEXT NOT NULL,
      elo             INTEGER NOT NULL DEFAULT 1000,
      peak_elo        INTEGER NOT NULL DEFAULT 1000,
      wins            INTEGER NOT NULL DEFAULT 0,
      losses          INTEGER NOT NULL DEFAULT 0,
      draws           INTEGER NOT NULL DEFAULT 0,
      total_matches   INTEGER NOT NULL DEFAULT 0,
      current_streak  INTEGER NOT NULL DEFAULT 0,
      best_streak     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_match_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      discord_id  TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      elo_at_join INTEGER NOT NULL,
      joined_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matches (
      match_id                 TEXT PRIMARY KEY,
      status                   TEXT NOT NULL DEFAULT 'awaiting_teamcode',
      team_a_players           TEXT NOT NULL,
      team_b_players           TEXT NOT NULL,
      team_a_avg_elo           REAL,
      team_b_avg_elo           REAL,
      map                      TEXT,
      game_mode                TEXT,
      format                   TEXT NOT NULL DEFAULT 'best_of_3',
      channel_id               TEXT,
      message_id               TEXT,
      team_code                TEXT,
      team_code_submitted_by   TEXT,
      team_code_submitted_at   TEXT,
      best_of_score            TEXT,
      started_at               TEXT,
      completed_at             TEXT,
      winner                   TEXT,
      team_a_score             INTEGER DEFAULT 0,
      team_b_score             INTEGER DEFAULT 0,
      cancellation_reason      TEXT,
      cancelled_at             TEXT,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS readiness (
      match_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,
      ready_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, discord_id)
    );

    CREATE TABLE IF NOT EXISTS match_votes (
      match_id     TEXT NOT NULL,
      discord_id   TEXT NOT NULL,
      vote         TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, discord_id)
    );

    CREATE TABLE IF NOT EXISTS fault_reports (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id           TEXT NOT NULL,
      reporter_id        TEXT NOT NULL,
      reported_player_id TEXT NOT NULL,
      reason             TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS elo_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id    TEXT NOT NULL,
      match_id      TEXT NOT NULL,
      previous_elo  INTEGER NOT NULL,
      elo_change    INTEGER NOT NULL,
      new_elo       INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS maps (
      map_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      game_mode       TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_selected_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS map_selection_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id     INTEGER NOT NULL,
      match_id   TEXT,
      selected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      action           TEXT NOT NULL,
      administrator_id TEXT,
      target_id        TEXT,
      match_id         TEXT,
      details          TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS match_deadlines (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      due_at     TEXT NOT NULL,
      state      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (match_id, kind)
    );

    CREATE TABLE IF NOT EXISTS timers (
      kind      TEXT NOT NULL,
      key_id    TEXT NOT NULL,
      due_at    TEXT NOT NULL,
      state     TEXT,
      PRIMARY KEY (kind, key_id)
    );

    CREATE TABLE IF NOT EXISTS cooldowns (
      discord_id     TEXT PRIMARY KEY,
      until          TEXT NOT NULL,
      reason         TEXT,
      admin_id       TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dodge_reports (
      match_id             TEXT NOT NULL,
      reported_player_id   TEXT NOT NULL,
      reports              INTEGER NOT NULL DEFAULT 0,
      status               TEXT NOT NULL,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, reported_player_id)
    );

    CREATE TABLE IF NOT EXISTS panel_state (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      channel_id    TEXT,
      message_id    TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matches_seq (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
  `);
}