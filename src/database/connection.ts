import Database from 'better-sqlite3';

export type ScrimDatabase = Database.Database;

export function openDatabase(dbPath: string): ScrimDatabase {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Tracks applied schema migrations so existing databases upgrade in place. */
function ensureMigrationsTable(db: ScrimDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function isApplied(db: ScrimDatabase, version: number): boolean {
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version);
  return row !== undefined;
}

function markApplied(db: ScrimDatabase, version: number): void {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
}

function migration001(db: ScrimDatabase): void {
  // Normalize pre-2.0 spellings to the official map names.
  db.prepare('UPDATE maps SET name = ? WHERE name = ?').run("Belle's Rock", 'Belles Rock');
  db.prepare('UPDATE maps SET name = ? WHERE name = ?').run('New Horizons', 'New Horizon');

  // Backfill the correct game modes for the original map pool.
  const byMode: Record<string, string[]> = {
    'Gem Grab': ['Hard Rock Mine', 'Crystal Arcade', 'Deathcap Trap'],
    Heist: ['Kaboom Canyon', 'Safe Zone', 'Hot Potato', 'Bridge Too Far'],
    Bounty: ['Shooting Star', 'Hideout', 'Dry Season'],
    Knockout: ["Belle's Rock", 'Out in the Open', 'Flaring Phoenix', 'New Horizons'],
  };
  const fix = db.prepare('UPDATE maps SET game_mode = ? WHERE name = ?');
  for (const [mode, names] of Object.entries(byMode)) {
    for (const name of names) {
      fix.run(mode, name);
    }
  }
}

function hasColumn(db: ScrimDatabase, table: string, column: string): boolean {
  const row = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return row.some((c) => c.name === column);
}

function addColumnIfMissing(db: ScrimDatabase, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

/**
 * Corrects the map-pool game modes and adds the missing official maps.
 *
 * A prior implementation stored game modes as a free-text string, so admins
 * could (and did) end up with two different spellings of the same mode (e.g.
 * "BRAWL BALL" vs "Brawl Ball") and maps with no mode at all. This normalizes
 * known spellings to canonical display names, clears junk values, fills in
 * NULL modes for the official pool, and inserts currently-missing official
 * maps. Legacy 'Heist' rows are left untouched (they stay playable); the
 * allowed /scrim map command set is the five modes in GAME_MODE_CHOICES.
 */
const CANONICAL_GAME_MODES = ['gem grab', 'bounty', 'knockout', 'brawl ball', 'hot zone'];

function migration003(db: ScrimDatabase): void {
  // 1. Normalize case-insensitive spellings of known modes to their canonical
  //    display name (Gem Grab, Bounty, Knockout, Brawl Ball, Hot Zone).
  const normalize = db.prepare(
    'UPDATE maps SET game_mode = ? WHERE TRIM(LOWER(game_mode)) = ?'
  );
  const displayNames: Record<string, string> = {
    'gem grab': 'Gem Grab',
    bounty: 'Bounty',
    knockout: 'Knockout',
    'brawl ball': 'Brawl Ball',
    'hot zone': 'Hot Zone',
  };
  for (const [slug, display] of Object.entries(displayNames)) {
    normalize.run(display, slug);
  }

  // 2. Wipe anything left that is not a recognized mode (free-text junk,
  //    "UNSPECIFIED", etc.). Legacy 'Heist' rows are preserved so existing
  //    maps stay playable; admins just can't pick Heist via /scrim map.
  const preservedModes = [...CANONICAL_GAME_MODES, 'heist'];
  db.prepare(
    `UPDATE maps SET game_mode = NULL
     WHERE game_mode IS NOT NULL
       AND TRIM(LOWER(game_mode)) NOT IN (${preservedModes.map(() => '?').join(', ')})`
  ).run(...preservedModes);

  // 3. Apply canonical per-map modes to maps that still have no mode, then
  //    insert maps from the official pool that are missing entirely.
  const byMode: Record<string, string[]> = {
    'Gem Grab': ['Hard Rock Mine', 'Crystal Arcade', 'Deathcap Trap'],
    Bounty: ['Shooting Star', 'Hideout', 'Dry Season'],
    Knockout: ["Belle's Rock", 'Out in the Open', 'Flaring Phoenix', 'New Horizons'],
    'Brawl Ball': ['Backyard Bowl', 'Center Stage', 'Sneaky Fields', 'Triple Dribble'],
  };
  const fix = db.prepare('UPDATE maps SET game_mode = ? WHERE name = ? AND game_mode IS NULL');
  const insert = db.prepare('INSERT OR IGNORE INTO maps (name, game_mode) VALUES (?, ?)');
  for (const [mode, names] of Object.entries(byMode)) {
    for (const name of names) {
      fix.run(mode, name);
      insert.run(name, mode);
    }
  }
}

function migration002(db: ScrimDatabase): void {
  // --- matches: 2.0 columns ------------------------------------------------
  addColumnIfMissing(db, 'matches', 'matchmaking', "TEXT NOT NULL DEFAULT 'auto'");
  addColumnIfMissing(db, 'matches', 'captain_a', 'TEXT');
  addColumnIfMissing(db, 'matches', 'captain_b', 'TEXT');
  addColumnIfMissing(db, 'matches', 'draft_order', 'TEXT');
  addColumnIfMissing(db, 'matches', 'log_message_id', 'TEXT');
  addColumnIfMissing(db, 'matches', 'log_channel_id', 'TEXT');
  addColumnIfMissing(db, 'matches', 'mvp', 'TEXT');
  addColumnIfMissing(db, 'matches', 'season_id', 'TEXT');

  // --- users: seasonal/other statistics ------------------------------------
  addColumnIfMissing(db, 'users', 'season_wins', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'users', 'season_losses', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'users', 'season_draws', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'users', 'season_peak_elo', 'INTEGER NOT NULL DEFAULT 0');

  // --- NEW TABLES ----------------------------------------------------------

  // Draft state for captain-draft matchmaking.
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      match_id      TEXT PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'selecting',   -- selecting|completed|expired|cancelled
      captain_a     TEXT NOT NULL,
      captain_b     TEXT NOT NULL,
      current_turn  TEXT NOT NULL,                       -- 'A' | 'B' | null
      pool          TEXT NOT NULL,                       -- JSON of remaining player ids
      turn_index    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS draft_picks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id      TEXT NOT NULL,
      pick_index    INTEGER NOT NULL,
      turn          TEXT NOT NULL,                       -- 'A' | 'B'
      captain_id    TEXT NOT NULL,
      picked_id     TEXT NOT NULL,
      picked_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Key/value admin settings (centralized control center).
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Per-player, per-map statistics (confirmed matches only).
  db.exec(`
    CREATE TABLE IF NOT EXISTS map_stats (
      discord_id  TEXT NOT NULL,
      map      TEXT NOT NULL,
      wins     INTEGER NOT NULL DEFAULT 0,
      losses   INTEGER NOT NULL DEFAULT 0,
      draws    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (discord_id, map)
    );
  `);

  // Competitive seasons.
  db.exec(`
    CREATE TABLE IF NOT EXISTS seasons (
      season_id    TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      starts_at    TEXT NOT NULL,
      ends_at      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'planned',      -- planned|active|ended
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mvp_votes (
      match_id    TEXT NOT NULL,
      discord_id  TEXT NOT NULL,                         -- voter
      mvp_id      TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, discord_id)
    );
  `);
}

/**
 * Tightens fault reporting so every participant can submit exactly one report
 * per match. The old design let a player file the same report repeatedly and
 * general ("TeamCode broken") reports were only written to the audit log.
 *
 * NOTE: this adds a unique index only — the table is NOT rebuilt. better-sqlite3
 * keeps a per-database prepared-statement cache, and DROP/ALTER-then-RENAME
 * crashes at statement finalization; the empty-string sentinel below is how a
 * "general" report is stored while keeping `reported_player_id NOT NULL`.
 */
function migration004(db: ScrimDatabase): void {
  // 1. Prune legacy duplicates, keeping the earliest report per (match, reporter).
  db.prepare(
    `DELETE FROM fault_reports
     WHERE id NOT IN (SELECT MIN(id) FROM fault_reports GROUP BY match_id, reporter_id)`
  ).run();

  // 2. Enforce one submission per player per match at the database layer.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS fault_reports_one_per_reporter
     ON fault_reports (match_id, reporter_id)`
  );

  // 3. Normalize any existing stored "empty" reported player values that were
  //    meant as general reports (defensive; the manager layer now stores '').
  db.prepare(`UPDATE fault_reports SET reported_player_id = '' WHERE reported_player_id IS NULL`).run();
}

const MIGRATIONS: Array<{ version: number; run: (db: ScrimDatabase) => void }> = [
  { version: 1, run: migration001 },
  { version: 2, run: migration002 },
  { version: 3, run: migration003 },
  { version: 4, run: migration004 },
];

function runMigrations(db: ScrimDatabase): void {
  ensureMigrationsTable(db);
  for (const migration of MIGRATIONS) {
    if (isApplied(db, migration.version)) continue;
    try {
      db.transaction(() => {
        migration.run(db);
        markApplied(db, migration.version);
      })();
    } catch (error) {
      console.error(`Migration v${migration.version} failed:`, error);
      throw error;
    }
  }
}

export function migrate(db: ScrimDatabase): void {
  // Base schema (idempotent CREATE IF NOT EXISTS).
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
      format                   TEXT NOT NULL DEFAULT 'best_of_1',
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

  // Apply versioned schema/data migrations over the base schema.
  runMigrations(db);
}