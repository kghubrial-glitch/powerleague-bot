import { ScrimDatabase } from '../connection';

/** Sentinel stored in reported_player_id when a report is general, not a player. */
export const NO_REPORTED_PLAYER = '';

export interface FaultReportRow {
  id: number;
  match_id: string;
  reporter_id: string;
  reported_player_id: string;
  reason: string;
  created_at: string;
}

// Helper predicates to distinguish "general" reports from player reports.
const isGeneral = (r: { reported_player_id: string }) => !r.reported_player_id;

export interface ReportedPlayerTally {
  reported_player_id: string;
  count: number;
  reasons: Record<string, number>;
}

export class FaultRepository {
  constructor(private db: ScrimDatabase) {}

  /**
   * Inserts a fault report. Every participant can submit exactly one report per
   * match (general reason OR one player) — the UNIQUE(match_id, reporter_id)
   * index enforces this even if a button is pressed twice. Pass
   * `reported_player_id: ''` (NO_REPORTED_PLAYER) for a general report.
   */
  add(report: {
    match_id: string;
    reporter_id: string;
    reported_player_id: string;
    reason: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO fault_reports (match_id, reporter_id, reported_player_id, reason)
         VALUES (?, ?, ?, ?)`
      )
      .run(report.match_id, report.reporter_id, report.reported_player_id || NO_REPORTED_PLAYER, report.reason);
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

  /** Number of distinct participants who have submitted a report this match. */
  reporterCount(matchId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT reporter_id) AS c FROM fault_reports WHERE match_id = ?')
      .get(matchId) as { c: number };
    return row.c;
  }

  /** Number of reports pointing at each player (self-reports never count). */
  talliesByReported(matchId: string): ReportedPlayerTally[] {
    const rows = this.db
      .prepare(
        `SELECT reported_player_id, reason, COUNT(*) AS count
         FROM fault_reports
         WHERE match_id = ? AND reported_player_id != ?
         GROUP BY reported_player_id, reason`
      )
      .all(matchId, NO_REPORTED_PLAYER) as Array<{ reported_player_id: string; reason: string; count: number }>;
    const map = new Map<string, ReportedPlayerTally>();
    for (const r of rows) {
      const entry = map.get(r.reported_player_id) ?? { reported_player_id: r.reported_player_id, count: 0, reasons: {} };
      entry.count += r.count;
      entry.reasons[r.reason] = (entry.reasons[r.reason] ?? 0) + r.count;
      map.set(r.reported_player_id, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  /** Number of reports per general (non-player) reason. */
  generalReasonTallies(matchId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT reason, COUNT(*) AS count FROM fault_reports
         WHERE match_id = ? AND reported_player_id = ?
         GROUP BY reason`
      )
      .all(matchId, NO_REPORTED_PLAYER) as Array<{ reason: string; count: number }>;
    return Object.fromEntries(rows.map((r) => [r.reason, r.count]));
  }

  dodgeEntries(matchId: string): Array<{ reported_player_id: string; reports: number; status: string }> {
    return this.db
      .prepare('SELECT reported_player_id, reports, status FROM dodge_reports WHERE match_id = ?')
      .all(matchId) as Array<{ reported_player_id: string; reports: number; status: string }>;
  }

  addDodge(entry: { match_id: string; reported_player_id: string; reports: number; status: string }): void {
    this.db
      .prepare(
        `INSERT INTO dodge_reports (match_id, reported_player_id, reports, status)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (match_id, reported_player_id) DO UPDATE SET
           reports = MAX(reports, excluded.reports),
           status = excluded.status`
      )
      .run(entry.match_id, entry.reported_player_id, entry.reports, entry.status);
  }
}