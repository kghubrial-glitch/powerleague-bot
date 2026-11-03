import { ScrimDatabase } from '../connection';
import { MapRow } from '../../types';
import { canonicalGameMode } from '../../matchmaking/gameModes';

/**
 * Official map pool. Every mode is one of the five the bot accepts
 * (Gem Grab, Bounty, Knockout, Brawl Ball, Hot Zone) so the /scrim map
 * commands and the pool can never disagree with each other.
 */
export const DEFAULT_MAPS: Array<{ name: string; gameMode: string }> = [
  // Gem Grab
  { name: 'Hard Rock Mine', gameMode: 'Gem Grab' },
  { name: 'Crystal Arcade', gameMode: 'Gem Grab' },
  { name: 'Deathcap Trap', gameMode: 'Gem Grab' },
  // Bounty
  { name: 'Dry Season', gameMode: 'Bounty' },
  { name: 'Hideout', gameMode: 'Bounty' },
  { name: 'Shooting Star', gameMode: 'Bounty' },
  // Knockout
  { name: "Belle's Rock", gameMode: 'Knockout' },
  { name: 'Flaring Phoenix', gameMode: 'Knockout' },
  { name: 'New Horizons', gameMode: 'Knockout' },
  { name: 'Out in the Open', gameMode: 'Knockout' },
  // Brawl Ball
  { name: 'Backyard Bowl', gameMode: 'Brawl Ball' },
  { name: 'Center Stage', gameMode: 'Brawl Ball' },
  { name: 'Sneaky Fields', gameMode: 'Brawl Ball' },
  { name: 'Triple Dribble', gameMode: 'Brawl Ball' },
];

export class MapRepository {
  constructor(private db: ScrimDatabase) {}

  ensureDefaults(): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO maps (name, game_mode) VALUES (?, ?)');
    for (const map of DEFAULT_MAPS) {
      insert.run(map.name, map.gameMode);
    }
  }

  list(): MapRow[] {
    return this.db.prepare('SELECT * FROM maps ORDER BY name ASC').all() as MapRow[];
  }

  enabled(): MapRow[] {
    return this.db.prepare('SELECT * FROM maps WHERE enabled = 1 ORDER BY name ASC').all() as MapRow[];
  }

  getByName(name: string): MapRow | undefined {
    return this.db.prepare('SELECT * FROM maps WHERE LOWER(name) = LOWER(?)').get(name) as MapRow | undefined;
  }

  getById(mapId: number): MapRow | undefined {
    return this.db.prepare('SELECT * FROM maps WHERE map_id = ?').get(mapId) as MapRow | undefined;
  }

  add(name: string, gameMode?: string): MapRow {
    const mode = canonicalGameMode(gameMode ?? '') ?? null;
    this.db
      .prepare('INSERT OR IGNORE INTO maps (name, game_mode) VALUES (?, ?)')
      .run(name, mode);
    const row = this.getByName(name);
    if (!row) throw new Error(`Failed to add map "${name}"`);
    if (mode && row.game_mode !== mode) this.setGameMode(row.map_id, mode);
    return this.getByName(name)!;
  }

  remove(name: string): boolean {
    const res = this.db.prepare('DELETE FROM maps WHERE LOWER(name) = LOWER(?)').run(name);
    return res.changes > 0;
  }

  toggle(name: string): MapRow | undefined {
    const row = this.getByName(name);
    if (!row) return undefined;
    this.db.prepare('UPDATE maps SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE map_id = ?').run(row.map_id);
    return this.getById(row.map_id);
  }

  setGameMode(nameOrId: string | number, gameMode: string | null): boolean {
    const row =
      typeof nameOrId === 'number' ? this.getById(nameOrId) : (this.getByName(nameOrId) ?? (this.getById(Number(nameOrId)) as MapRow | undefined));
    if (!row) return false;
    const mode = canonicalGameMode(gameMode ?? '') ?? null;
    this.db.prepare('UPDATE maps SET game_mode = ? WHERE map_id = ?').run(mode, row.map_id);
    return true;
  }

  markSelected(mapId: number, matchId: string | null, at: string): void {
    this.db
      .prepare('UPDATE maps SET last_selected_at = ? WHERE map_id = ?')
      .run(at, mapId);
    this.db
      .prepare('INSERT INTO map_selection_history (map_id, match_id, selected_at) VALUES (?, ?, ?)')
      .run(mapId, matchId, at);
  }

  selectionHistory(limit: number): Array<{ id: number; name: string; match_id: string | null; selected_at: string }> {
    return this.db
      .prepare(
        `SELECT h.id, m.name, h.match_id, h.selected_at
         FROM map_selection_history h JOIN maps m ON m.map_id = h.map_id
         ORDER BY h.selected_at DESC LIMIT ?`
      )
      .all(limit) as Array<{ id: number; name: string; match_id: string | null; selected_at: string }>;
  }
}