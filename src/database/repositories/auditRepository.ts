import { ScrimDatabase } from '../connection';

export interface AuditLogRow {
  id: number;
  action: string;
  administrator_id: string | null;
  target_id: string | null;
  match_id: string | null;
  details: string | null;
  created_at: string;
}

export class AuditRepository {
  constructor(private db: ScrimDatabase) {}

  log(entry: {
    action: string;
    administrator_id?: string | null;
    target_id?: string | null;
    match_id?: string | null;
    details?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (action, administrator_id, target_id, match_id, details)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        entry.action,
        entry.administrator_id ?? null,
        entry.target_id ?? null,
        entry.match_id ?? null,
        entry.details ?? null
      );
  }

  recent(limit: number, offset: number): AuditLogRow[] {
    return this.db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as AuditLogRow[];
  }
}