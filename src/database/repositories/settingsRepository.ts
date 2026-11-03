import { ScrimDatabase } from '../connection';

/**
 * Key/value store for runtime-configurable settings (the admin control center).
 * These override defaults from config/env but are persisted so they survive
 * bot restarts; the Discord UI in `/scrim settings` edits them live.
 */
export class SettingsRepository {
  constructor(private db: ScrimDatabase) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string | number | boolean | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .run(key, String(value));
  }

  all(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  matchmakingMode(): 'auto' | 'draft' {
    return this.get('matchmaking_mode') === 'draft' ? 'draft' : 'auto';
  }

  setMatchmakingMode(mode: 'auto' | 'draft'): void {
    this.set('matchmaking_mode', mode);
  }
}