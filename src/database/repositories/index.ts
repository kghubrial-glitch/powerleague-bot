import { ScrimDatabase } from '../connection';
import { UserRepository } from './userRepository';
import { QueueRepository } from './queueRepository';
import { MatchRepository } from './matchRepository';
import { MapRepository } from './mapRepository';
import { FaultRepository } from './faultRepository';
import { AuditRepository } from './auditRepository';
import { DeadlineRepository } from './deadlineRepository';
import { CooldownRepository } from './cooldownRepository';
import { PanelRepository } from './panelRepository';
import { DraftRepository } from './draftRepository';
import { SettingsRepository } from './settingsRepository';
import { MapStatsRepository } from './mapStatsRepository';

export class Repositories {
  users: UserRepository;
  queue: QueueRepository;
  matches: MatchRepository;
  maps: MapRepository;
  faults: FaultRepository;
  audits: AuditRepository;
  deadlines: DeadlineRepository;
  cooldowns: CooldownRepository;
  panels: PanelRepository;
  drafts: DraftRepository;
  settings: SettingsRepository;
  mapStats: MapStatsRepository;

  constructor(public db: ScrimDatabase) {
    this.users = new UserRepository(db);
    this.queue = new QueueRepository(db);
    this.matches = new MatchRepository(db);
    this.maps = new MapRepository(db);
    this.faults = new FaultRepository(db);
    this.audits = new AuditRepository(db);
    this.deadlines = new DeadlineRepository(db);
    this.cooldowns = new CooldownRepository(db);
    this.panels = new PanelRepository(db);
    this.drafts = new DraftRepository(db);
    this.settings = new SettingsRepository(db);
    this.mapStats = new MapStatsRepository(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export * from './userRepository';
export * from './queueRepository';
export * from './matchRepository';
export * from './mapRepository';
export * from './faultRepository';
export * from './auditRepository';
export * from './deadlineRepository';
export * from './cooldownRepository';
export * from './panelRepository';
export * from './draftRepository';
export * from './settingsRepository';
export * from './mapStatsRepository';