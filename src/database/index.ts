import { openDatabase, migrate, ScrimDatabase } from './connection';
import { Repositories } from './repositories';

export interface Database {
  db: ScrimDatabase;
  repos: Repositories;
}

export function initDatabase(dbPath: string): Database {
  const db = openDatabase(dbPath);
  migrate(db);
  const repos = new Repositories(db);
  repos.maps.ensureDefaults();
  return { db, repos };
}

export * from './connection';
export * from './repositories';