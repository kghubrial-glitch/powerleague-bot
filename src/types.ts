export interface UserRow {
  discord_id: string;
  username: string;
  elo: number;
  peak_elo: number;
  wins: number;
  losses: number;
  draws: number;
  total_matches: number;
  current_streak: number;
  best_streak: number;
  created_at: string;
  last_match_at: string | null;
  season_wins?: number;
  season_losses?: number;
  season_draws?: number;
  season_peak_elo?: number;
}

export interface QueueEntryRow {
  discord_id: string;
  username: string;
  elo_at_join: number;
  joined_at: string;
}

export type MatchStatus =
  | 'awaiting_teamcode'
  | 'awaiting_ready'
  | 'in_progress'
  | 'voting'
  | 'confirmed'
  | 'disputed'
  | 'cancelled'
  | 'timed_out'
  | 'archived';

export interface MatchRow {
  match_id: string;
  status: MatchStatus;
  team_a_players: string; // JSON array of discord ids
  team_b_players: string;
  team_a_avg_elo: number | null;
  team_b_avg_elo: number | null;
  map: string | null;
  game_mode: string | null;
  format: 'best_of_1' | 'best_of_3';
  channel_id: string | null;
  message_id: string | null;
  team_code: string | null;
  team_code_submitted_by: string | null;
  team_code_submitted_at: string | null;
  best_of_score: string | null; // JSON { "game1": "A"|"B", ... }
  started_at: string | null;
  completed_at: string | null;
  winner: 'A' | 'B' | 'draw' | null;
  team_a_score: number;
  team_b_score: number;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  matchmaking?: string; // 'auto' | 'draft'
  captain_a?: string | null;
  captain_b?: string | null;
  draft_order?: string | null; // JSON array of 'A'|'B' turns
  log_message_id?: string | null;
  log_channel_id?: string | null;
  mvp?: string | null;
  season_id?: string | null;
}

export type VoteChoice = 'A' | 'B' | 'draw';

export interface MapRow {
  map_id: number;
  name: string;
  game_mode: string | null;
  enabled: number;
  last_selected_at: string | null;
}

export interface EloHistoryRow {
  id: number;
  discord_id: string;
  match_id: string;
  previous_elo: number;
  elo_change: number;
  new_elo: number;
  created_at: string;
}

export interface FaultReason {
  id: string;
  label: string;
  playerRelated: boolean;
}

export interface TeamAssignment {
  teamA: string[];
  teamB: string[];
  diff: number;
}