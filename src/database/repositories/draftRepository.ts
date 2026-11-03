import { ScrimDatabase } from '../connection';

export interface DraftRow {
  match_id: string;
  status: string; // selecting | completed | expired | cancelled
  captain_a: string;
  captain_b: string;
  current_turn: string | null; // 'A' | 'B' | null
  pool: string; // JSON array of player ids not yet drafted
  turn_index: number;
  created_at: string;
  updated_at: string;
}

export interface DraftPickRow {
  id: number;
  match_id: string;
  pick_index: number;
  turn: string; // 'A' | 'B'
  captain_id: string;
  picked_id: string;
  picked_at: string;
}

/**
 * Persists captain-draft state for matches created in draft matchmaking mode.
 * All board logic lives in the operating layer (matchManager/draftManager);
 * this repository only reads and writes the underlying tables.
 */
export class DraftRepository {
  constructor(private db: ScrimDatabase) {}

  get(matchId: string): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE match_id = ?').get(matchId) as DraftRow | undefined;
  }

  create(draft: {
    match_id: string;
    captain_a: string;
    captain_b: string;
    pool: string;
    current_turn?: string | null;
  }): DraftRow {
    this.db
      .prepare(
        `INSERT INTO drafts (match_id, status, captain_a, captain_b, current_turn, pool, turn_index)
         VALUES (?, 'selecting', ?, ?, ?, ?, 0)`
      )
      .run(draft.match_id, draft.captain_a, draft.captain_b, draft.current_turn ?? 'A', draft.pool);
    return this.get(draft.match_id)!;
  }

  updatePool(matchId: string, pool: string): void {
    this.db
      .prepare(`UPDATE drafts SET pool = ?, updated_at = datetime('now') WHERE match_id = ?`)
      .run(pool, matchId);
  }

  setTurn(matchId: string, turn: 'A' | 'B' | null, turnIndex: number): void {
    this.db
      .prepare(
        `UPDATE drafts SET current_turn = ?, turn_index = ?, updated_at = datetime('now') WHERE match_id = ?`
      )
      .run(turn, turnIndex, matchId);
  }

  setStatus(matchId: string, status: string): void {
    this.db
      .prepare(`UPDATE drafts SET status = ?, updated_at = datetime('now') WHERE match_id = ?`)
      .run(status, matchId);
  }

  addPick(pick: {
    match_id: string;
    pick_index: number;
    turn: string;
    captain_id: string;
    picked_id: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO draft_picks (match_id, pick_index, turn, captain_id, picked_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(pick.match_id, pick.pick_index, pick.turn, pick.captain_id, pick.picked_id);
  }

  picks(matchId: string): DraftPickRow[] {
    return this.db
      .prepare('SELECT * FROM draft_picks WHERE match_id = ? ORDER BY pick_index ASC')
      .all(matchId) as DraftPickRow[];
  }

  /** All 'selecting' drafts — used to recover drafts after a restart. */
  active(): DraftRow[] {
    return this.db.prepare("SELECT * FROM drafts WHERE status = 'selecting'").all() as DraftRow[];
  }
}