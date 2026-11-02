import { ScrimDatabase } from '../connection';

export interface FaultReportRow {
  id: number;
  match_id: string;
  reporter_id: string;
  reported_player_id: string;
  reason: string;
  created_at: string;
}

export class FaultRepository {
  constructor(private db: ScrimDatabase) {}

  add(report: {
    match_id: string;
    reporter_id: string;
    reported_player_id: string;
    reason: string;
  }): boolean {
    // One report per (match, reporter, reported player).
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO fault_reports (match_id, reporter_id, reported_player_id, reason)
         VALUES (?, ?, ?, ?)`
      )
      .run(report.match_id, report.reporter_id, report.reported_player_id, report.reason);
    return res.changes > 0;
  }

  forMatch(matchId: string): FaultReportRow[] {
    return this.db
      .prepare('SELECT * FROM fault_reports WHERE match_id = ? ORDER BY created_at ASC')
      .all(matchId) as FaultReportRow[];
  }

  countForReported(matchId: string, reportedPlayerId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS c FROM fault_reports WHERE match_id = ? AND reported_player_id = ?'
      )
      .get(matchId, reportedPlayerId) as { c: number };
    return row.c;
  }

  addDodge(entry: { match_id: string; reported_player_id: string; reports: number; status: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dodge_reports (match_id, reported_player_id, reports, status)
         VALUES (?, ?, ?, ?)`
      )
      .run(entry.match_id, entry.reported_player_id, entry.reports, entry.status);
  }
}