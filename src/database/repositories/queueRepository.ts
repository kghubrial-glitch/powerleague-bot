import { ScrimDatabase } from '../connection';
import { QueueEntryRow } from '../../types';

export class QueueRepository {
  constructor(private db: ScrimDatabase) {}

  list(): QueueEntryRow[] {
    return this.db
      .prepare('SELECT * FROM queue_entries ORDER BY joined_at ASC, discord_id ASC')
      .all() as QueueEntryRow[];
  }

  get(discordId: string): QueueEntryRow | undefined {
    return this.db.prepare('SELECT * FROM queue_entries WHERE discord_id = ?').get(discordId) as
      | QueueEntryRow
      | undefined;
  }

  add(entry: { discord_id: string; username: string; elo_at_join: number }): void {
    this.db
      .prepare('INSERT OR IGNORE INTO queue_entries (discord_id, username, elo_at_join) VALUES (?, ?, ?)')
      .run(entry.discord_id, entry.username, entry.elo_at_join);
  }

  remove(discordId: string): boolean {
    const res = this.db.prepare('DELETE FROM queue_entries WHERE discord_id = ?').run(discordId);
    return res.changes > 0;
  }

  removeBySet(discordIds: string[]): number {
    if (discordIds.length === 0) return 0;
    const placeholders = discordIds.map(() => '?').join(',');
    const res = this.db.prepare(`DELETE FROM queue_entries WHERE discord_id IN (${placeholders})`).run(...discordIds);
    return res.changes;
  }

  clear(): number {
    const res = this.db.prepare('DELETE FROM queue_entries').run();
    return res.changes;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM queue_entries').get() as { c: number };
    return row.c;
  }
}