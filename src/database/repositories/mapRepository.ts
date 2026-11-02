import { ScrimDatabase } from '../connection';
import { MapRow } from '../../types';

const DEFAULT_MAPS = [
  'Hard Rock Mine',
  'Crystal Arcade',
  'Deathcap Trap',
  'Kaboom Canyon',
  'Safe Zone',
  'Hot Potato',
  'Bridge Too Far',
  'Shooting Star',
  'Hideout',
  'Dry Season',
  'Belles Rock',
  'Out in the Open',
  'Flaring Phoenix',
  'New Horizon',
];

export class MapRepository {
  constructor(private db: ScrimDatabase) {}

  ensureDefaults(): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO maps (name) VALUES (?)');
    for (const name of DEFAULT_MAPS) {
      insert.run(name);
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
    this.db
      .prepare('INSERT OR IGNORE INTO maps (name, game_mode) VALUES (?, ?)')
      .run(name, gameMode ?? null);
    const row = this.getByName(name);
    if (!row) throw new Error(`Failed to add map "${name}"`);
    return row;
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

  setGameMode(nameOrId: string, gameMode: string | null): boolean {
    const row = this.getByName(nameOrId) ?? (this.getById(Number(nameOrId)) as MapRow | undefined);
    if (!row) return false;
    this.db.prepare('UPDATE maps SET game_mode = ? WHERE map_id = ?').run(gameMode, row.map_id);
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