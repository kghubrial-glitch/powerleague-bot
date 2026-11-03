import { ScrimDatabase } from '../connection';
import { MatchRow, MatchStatus, VoteChoice } from '../../types';

export const MATCH_STATUSES: MatchStatus[] = [
  'drafting',
  'awaiting_teamcode',
  'awaiting_ready',
  'in_progress',
  'voting',
  'confirmed',
  'disputed',
  'cancelled',
  'timed_out',
  'archived',
];

export class MatchRepository {
  constructor(private db: ScrimDatabase) {}

  get(matchId: string): MatchRow | undefined {
    return this.db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId) as MatchRow | undefined;
  }

  getByChannel(channelId: string): MatchRow | undefined {
    return this.db.prepare('SELECT * FROM matches WHERE channel_id = ?').get(channelId) as MatchRow | undefined;
  }

  getActiveByPlayer(discordId: string): MatchRow | undefined {
    // A match channel-broadcast cannot be active for a player in multiple matches.
    const rows = this.db
      .prepare(
        `SELECT * FROM matches
         WHERE status IN ('drafting','awaiting_teamcode','awaiting_ready','in_progress','voting')`
      )
      .all() as MatchRow[];
    return rows.find((m) => this.isParticipant(m, discordId));
  }

  isParticipant(match: MatchRow, discordId: string): boolean {
    return this.teamAIds(match).includes(discordId) || this.teamBIds(match).includes(discordId);
  }

  /** Allocates the next sequential match number and returns `scrim-XXXX`. */
  nextMatchId(): string {
    const result = this.db.prepare('INSERT INTO matches_seq (id) VALUES (NULL)').run();
    return `scrim-${String(result.lastInsertRowid).padStart(4, '0')}`;
  }

  participantIds(match: MatchRow): string[] {
    return [...this.teamAIds(match), ...this.teamBIds(match)];
  }

  teamAIds(match: MatchRow): string[] {
    return JSON.parse(match.team_a_players) as string[];
  }

  teamBIds(match: MatchRow): string[] {
    return JSON.parse(match.team_b_players) as string[];
  }

  create(match: {
    match_id: string;
    team_a_players: string;
    team_b_players: string;
    team_a_avg_elo: number;
    team_b_avg_elo: number;
    map: string;
    game_mode: string | null;
    format: 'best_of_1' | 'best_of_3';
    channel_id: string;
    message_id?: string | null;
  }): MatchRow {
    const status: MatchStatus = 'awaiting_teamcode';
    this.db
      .prepare(
        `INSERT INTO matches (
           match_id, status, team_a_players, team_b_players, team_a_avg_elo, team_b_avg_elo,
           map, game_mode, format, channel_id, message_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        match.match_id,
        status,
        match.team_a_players,
        match.team_b_players,
        match.team_a_avg_elo,
        match.team_b_avg_elo,
        match.map,
        match.game_mode,
        match.format,
        match.channel_id,
        match.message_id ?? null
      );
    return this.get(match.match_id)!;
  }

  setMessageId(matchId: string, messageId: string): void {
    this.db.prepare(`UPDATE matches SET message_id = ? WHERE match_id = ?`).run(messageId, matchId);
  }

  updateStatus(matchId: string, status: MatchStatus): void {
    this.db
      .prepare(`UPDATE matches SET status = ?, updated_at = datetime('now') WHERE match_id = ?`)
      .run(status, matchId);
  }

  /**
   * Updates team composition and captains after a captain draft completes.
   * Called only while the match is still in the `drafting` state.
   */
  finalizeDraftTeams(matchId: string, teamA: string[], teamB: string[], captainA: string, captainB: string): void {
    this.db
      .prepare(
        `UPDATE matches SET team_a_players = ?, team_b_players = ?,
           team_a_avg_elo = ?, team_b_avg_elo = ?,
           captain_a = ?, captain_b = ?, matchmaking = 'draft',
           updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(
        JSON.stringify(teamA),
        JSON.stringify(teamB),
        this.avgEloFor(teamA),
        this.avgEloFor(teamB),
        captainA,
        captainB,
        matchId
      );
  }

  setMatchmakingMode(matchId: string, mode: 'auto' | 'draft'): void {
    this.db
      .prepare(`UPDATE matches SET matchmaking = ?, updated_at = datetime('now') WHERE match_id = ?`)
      .run(mode, matchId);
  }

  private avgEloFor(ids: string[]): number {
    const rows = [] as Array<{ elo: number }>;
    for (const id of ids) {
      const row = this.db.prepare('SELECT elo FROM users WHERE discord_id = ?').get(id) as { elo: number } | undefined;
      if (row) rows.push(row);
    }
    if (rows.length === 0) return 1000;
    return Math.round(rows.reduce((a, r) => a + r.elo, 0) / rows.length);
  }

  setTeamCode(matchId: string, code: string, submittedBy: string, at: string): boolean {
    // Only updates if no TeamCode has been accepted yet.
    const res = this.db
      .prepare(
        `UPDATE matches
         SET team_code = ?, team_code_submitted_by = ?, team_code_submitted_at = ?, updated_at = datetime('now')
         WHERE match_id = ? AND team_code IS NULL`
      )
      .run(code, submittedBy, at, matchId);
    return res.changes > 0;
  }

  resetTeamCode(matchId: string): void {
    this.db
      .prepare(
        `UPDATE matches SET team_code = NULL, team_code_submitted_by = NULL, team_code_submitted_at = NULL,
         updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(matchId);
  }

  setReady(matchId: string, discordId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO readiness (match_id, discord_id) VALUES (?, ?)')
      .run(matchId, discordId);
  }

  readyIds(matchId: string): string[] {
    const rows = this.db
      .prepare('SELECT discord_id FROM readiness WHERE match_id = ?')
      .all(matchId) as { discord_id: string }[];
    return rows.map((r) => r.discord_id);
  }

  clearReadiness(matchId: string): void {
    this.db.prepare('DELETE FROM readiness WHERE match_id = ?').run(matchId);
  }

  setReadyStatus(matchId: string, status: MatchStatus): void {
    this.updateStatus(matchId, status);
  }

  startMatch(matchId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE matches SET status = 'in_progress', started_at = ?, updated_at = datetime('now') WHERE match_id = ?`
      )
      .run(at, matchId);
  }

  // ---------------- Voting ----------------

  createVote(matchId: string, discordId: string, vote: VoteChoice): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO match_votes (match_id, discord_id, vote) VALUES (?, ?, ?)')
      .run(matchId, discordId, vote);
    return res.changes > 0;
  }

  getVotes(matchId: string): Array<{ discord_id: string; vote: VoteChoice }> {
    return this.db
      .prepare('SELECT discord_id, vote FROM match_votes WHERE match_id = ?')
      .all(matchId) as Array<{ discord_id: string; vote: VoteChoice }>;
  }

  clearVotes(matchId: string): void {
    this.db.prepare('DELETE FROM match_votes WHERE match_id = ?').run(matchId);
  }

  cancelVoteReset(matchId: string): void {
    this.db.prepare('DELETE FROM match_votes WHERE match_id = ?').run(matchId);
    this.db
      .prepare(`UPDATE matches SET status = 'in_progress', updated_at = datetime('now') WHERE match_id = ?`)
      .run(matchId);
  }

  confirmResult(matchId: string, winner: 'A' | 'B' | 'draw', scoreA: number, scoreB: number): void {
    this.db
      .prepare(
        `UPDATE matches SET winner = ?, team_a_score = ?, team_b_score = ?, status = 'confirmed',
         completed_at = datetime('now'), updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(winner, scoreA, scoreB, matchId);
  }

  markDisputed(matchId: string): void {
    this.db
      .prepare(`UPDATE matches SET status = 'disputed', completed_at = datetime('now'), updated_at = datetime('now') WHERE match_id = ?`)
      .run(matchId);
  }

  archive(matchId: string): void {
    this.db
      .prepare(
        `UPDATE matches SET status = 'archived', team_code = NULL, team_code_submitted_by = NULL,
         team_code_submitted_at = NULL, updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(matchId);
  }

  // ---------------- Cancellation ----------------

  cancel(matchId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE matches SET status = 'cancelled', cancellation_reason = ?, cancelled_at = datetime('now'),
         completed_at = datetime('now'), updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(reason, matchId);
  }

  timeout(matchId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE matches SET status = 'timed_out', cancellation_reason = ?, cancelled_at = datetime('now'),
         completed_at = datetime('now'), updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(reason, matchId);
  }

  adminResolve(matchId: string, winner: 'A' | 'B' | 'draw', scoreA: number, scoreB: number, status: MatchStatus): void {
    this.db
      .prepare(
        `UPDATE matches SET winner = ?, team_a_score = ?, team_b_score = ?, status = ?,
         completed_at = datetime('now'), updated_at = datetime('now')
         WHERE match_id = ?`
      )
      .run(winner, scoreA, scoreB, status, matchId);
  }

  adminCorrect(matchId: string, winner: 'A' | 'B' | 'draw', scoreA: number, scoreB: number): void {
    this.adminResolve(matchId, winner, scoreA, scoreB, 'confirmed');
  }

  setDisputedActive(matchId: string): void {
    this.updateStatus(matchId, 'disputed');
  }

  recent(limit: number, offset: number): MatchRow[] {
    return this.db.prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as MatchRow[];
  }

  getByPlayer(discordId: string, limit: number, offset: number): MatchRow[] {
    const rows = this.db
      .prepare('SELECT * FROM matches ORDER BY created_at DESC LIMIT 1000')
      .all() as MatchRow[];
    return rows.filter((m) => this.isParticipant(m, discordId)).slice(offset, offset + limit);
  }

  activeCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM matches WHERE status IN ('drafting','awaiting_teamcode','awaiting_ready','in_progress','voting')`
      )
      .get() as { c: number };
    return row.c;
  }
}