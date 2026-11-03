import { ScrimDatabase } from '../connection';

/**
 * Per-player, per-map statistics for confirmed matches only. Enables
 * map-specific win-rate and performance insights in player profiles.
 */
export class MapStatsRepository {
  constructor(private db: ScrimDatabase) {}

  /** Records the outcome of a player on a given map. */
  record(discordId: string, map: string, outcome: 'win' | 'loss' | 'draw'): void {
    // Seed a 1 in the affected column so the first match counts.
    const seeds =
      outcome === 'win' ? '1, 0, 0' : outcome === 'loss' ? '0, 1, 0' : '0, 0, 1';
    const column = outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'draws';
    this.db
      .prepare(
        `INSERT INTO map_stats (discord_id, map, wins, losses, draws) VALUES (?, ?, ${seeds})
         ON CONFLICT(discord_id, map) DO UPDATE SET ${column} = ${column} + 1`
      )
      .run(discordId, map);
  }

  /** All maps a player has played, sorted by most matches. */
  forPlayer(discordId: string, limit = 20): Array<{ map: string; wins: number; losses: number; draws: number }> {
    return this.db
      .prepare(
        `SELECT map, wins, losses, draws FROM map_stats WHERE discord_id = ?
         ORDER BY (wins + losses + draws) DESC, wins DESC LIMIT ?`
      )
      .all(discordId, limit) as Array<{ map: string; wins: number; losses: number; draws: number }>;
  }

  /** Map-specific win rate for a player (0..1 or undefined if unplayed). */
  winRate(discordId: string, map: string): number | undefined {
    const row = this.db
      .prepare('SELECT wins, losses, draws FROM map_stats WHERE discord_id = ? AND map = ?')
      .get(discordId, map) as { wins: number; losses: number; draws: number } | undefined;
    if (!row) return undefined;
    const total = row.wins + row.losses + row.draws;
    return total === 0 ? undefined : row.wins / total;
  }

  /** Most-played map for a player, if any. */
  favoriteMap(discordId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT map FROM map_stats WHERE discord_id = ? ORDER BY (wins + losses + draws) DESC LIMIT 1`
      )
      .get(discordId) as { map: string } | undefined;
    return row?.map;
  }
}