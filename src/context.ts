import { Client, TextChannel } from 'discord.js';
import { Settings } from './config/settings';
import { Database } from './database';
import { TimerManager } from './services/timerManager';
import { AuditLogger } from './services/auditLogger';
import { MatchManager } from './matches/matchManager';
import { QueueManager } from './matchmaking/queueManager';
import { InteractionHandler } from './interactions/interactionHandler';
import { CommandHandler } from './commands/commands';
import { AdminCommandHandler } from './commands/admin';

/**
 * Central application context.
 *
 * Managers are wired together in `index.ts`; this object is passed around so
 * commands and interaction handlers can access every subsystem.
 */
export interface AppContext {
  client: Client;
  settings: Settings;
  db: Database;
  timers: TimerManager;
  audit: AuditLogger;
  queue: QueueManager;
  matches: MatchManager;
  interactions: InteractionHandler;
  commands: CommandHandler;
  admin: AdminCommandHandler;
}

export function getTextChannel(ctx: AppContext, channelId: string): TextChannel | null {
  const channel = ctx.client.channels.cache.get(channelId);
  return channel instanceof TextChannel ? channel : null;
}