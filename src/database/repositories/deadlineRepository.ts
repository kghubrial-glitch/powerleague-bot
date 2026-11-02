import { ScrimDatabase } from '../connection';

export type DeadlineKind = 'teamcode' | 'ready' | 'match' | 'vote' | 'fault_report';

export interface DeadlineRow {
  id: number;
  match_id: string;
  kind: string;
  due_at: string;
  state: string | null;
}

export class DeadlineRepository {
  constructor(private db: ScrimDatabase) {}

  upsert(matchId: string, kind: DeadlineKind, dueAt: string, state: string | null): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO match_deadlines (match_id, kind, due_at, state)
         VALUES (?, ?, ?, ?)`
      )
      .run(matchId, kind, dueAt, state);
  }

  get(matchId: string, kind: DeadlineKind): DeadlineRow | undefined {
    return this.db
      .prepare('SELECT * FROM match_deadlines WHERE match_id = ? AND kind = ?')
      .get(matchId, kind) as DeadlineRow | undefined;
  }

  delete(matchId: string, kind: DeadlineKind): void {
    this.db.prepare('DELETE FROM match_deadlines WHERE match_id = ? AND kind = ?').run(matchId, kind);
  }

  deleteAllForMatch(matchId: string): void {
    this.db.prepare('DELETE FROM match_deadlines WHERE match_id = ?').run(matchId);
  }

  allDue(before: string): DeadlineRow[] {
    return this.db
      .prepare('SELECT * FROM match_deadlines WHERE due_at <= ?')
      .all(before) as DeadlineRow[];
  }

  allForMatch(matchId: string): DeadlineRow[] {
    return this.db
      .prepare('SELECT * FROM match_deadlines WHERE match_id = ? ORDER BY due_at ASC')
      .all(matchId) as DeadlineRow[];
  }

  all(): DeadlineRow[] {
    return this.db.prepare('SELECT * FROM match_deadlines ORDER BY due_at ASC').all() as DeadlineRow[];
  }
}