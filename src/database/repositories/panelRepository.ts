import { ScrimDatabase } from '../connection';

export interface PanelStateRow {
  id: number;
  channel_id: string | null;
  message_id: string | null;
  updated_at: string;
}

export class PanelRepository {
  constructor(private db: ScrimDatabase) {}

  get(): PanelStateRow | undefined {
    return this.db.prepare('SELECT * FROM panel_state WHERE id = 1').get() as PanelStateRow | undefined;
  }

  set(channelId: string | null, messageId: string | null): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO panel_state (id, channel_id, message_id, updated_at)
         VALUES (1, ?, ?, datetime('now'))`
      )
      .run(channelId, messageId);
  }
}