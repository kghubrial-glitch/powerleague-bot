import { ScrimDatabase } from '../connection';

export interface CooldownRow {
  discord_id: string;
  until: string;
  reason: string | null;
  admin_id: string | null;
  created_at: string;
}

export class CooldownRepository {
  constructor(private db: ScrimDatabase) {}

  set(
    discordId: string,
    until: string,
    reason: string | null,
    adminId: string | null
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cooldowns (discord_id, until, reason, admin_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(discordId, until, reason, adminId);
  }

  remove(discordId: string): boolean {
    const res = this.db.prepare('DELETE FROM cooldowns WHERE discord_id = ?').run(discordId);
    return res.changes > 0;
  }

  active(discordId: string, at: string): CooldownRow | undefined {
    return this.db
      .prepare('SELECT * FROM cooldowns WHERE discord_id = ? AND until > ?')
      .get(discordId, at) as CooldownRow | undefined;
  }

  allActive(at: string): CooldownRow[] {
    return this.db.prepare('SELECT * FROM cooldowns WHERE until > ? ORDER BY until ASC').all(at) as CooldownRow[];
  }
}