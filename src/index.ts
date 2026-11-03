import { Client, GatewayIntentBits, Routes, REST, Events, Message } from 'discord.js';
import { loadSettings } from './config/settings';
import { initDatabase, Database } from './database';
import { TimerManager } from './services/timerManager';
import { AuditLogger } from './services/auditLogger';
import { MatchLogs } from './services/matchLogs';
import { MatchManager } from './matches/matchManager';
import { QueueManager } from './matchmaking/queueManager';
import { InteractionHandler } from './interactions/interactionHandler';
import { CommandHandler, registerCommandDefinitions } from './commands/commands';
import { AdminCommandHandler, registerAdminCommandDefinitions } from './commands/admin';
import { PrefixHandler } from './commands/prefixHandler';
import { AppContext } from './context';
import { registerInteractionEvents } from './events/interactionCreate';

let queueSweep: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  const settings = loadSettings();
  if (!settings.discordToken) {
    console.error('DISCORD_BOT_TOKEN is required.');
    process.exit(1);
  }

  const client = new Client({
    // GuildMessages (message events) plus MessageContent are both required for
    // the `!`-prefixed chat commands; MessageContent is a privileged intent
    // that must be enabled in the Discord developer portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const db: Database = initDatabase(settings.databasePath);
  const repos = db.repos;

  // Persisted runtime settings override config/env (admin control center).
  settings.matchmakingMode = repos.settings.matchmakingMode();
  settings.logsChannelId = repos.settings.get('logs_channel_id') ?? undefined;

  // Context is built in two passes because the managers reference each other.
  const ctx = {
    client,
    settings,
    db,
    timers: null as unknown as AppContext['timers'],
    audit: null as unknown as AppContext['audit'],
    logs: null as unknown as AppContext['logs'],
    queue: null as unknown as AppContext['queue'],
    matches: null as unknown as AppContext['matches'],
    interactions: null as unknown as AppContext['interactions'],
    commands: null as unknown as AppContext['commands'],
    admin: null as unknown as AppContext['admin'],
    prefix: null as unknown as AppContext['prefix'],
  } satisfies AppContext;

  const matches = new MatchManager(ctx);
  ctx.matches = matches;
  ctx.audit = new AuditLogger(repos.audits);
  ctx.logs = new MatchLogs(ctx);
  ctx.timers = new TimerManager(repos.deadlines, {
    teamcode: (matchId) => void matches.onDeadline(matchId, 'teamcode'),
    ready: (matchId) => void matches.onDeadline(matchId, 'ready'),
    match: (matchId) => void matches.onDeadline(matchId, 'match'),
    vote: (matchId) => void matches.onDeadline(matchId, 'vote'),
    fault_report: (matchId) => void matches.onDeadline(matchId, 'fault_report'),
  });

  ctx.queue = new QueueManager(ctx, {
    onFull: async (entries) => {
      await matches.createMatchFromQueue(entries);
    },
  });
  ctx.interactions = new InteractionHandler(ctx);
  ctx.commands = new CommandHandler(ctx);
  ctx.admin = new AdminCommandHandler(ctx);
  ctx.prefix = new PrefixHandler(ctx);

  registerInteractionEvents(ctx);

  client.on(Events.MessageCreate, (message: Message) => {
    void ctx.prefix.handle(message).catch((e) => console.error('Prefix command error:', e));
  });

  // Register slash commands.
  const rest = new REST({ version: '10' }).setToken(settings.discordToken);
  const commandDefs = [...registerCommandDefinitions(), ...registerAdminCommandDefinitions()];
  try {
    await rest.put(Routes.applicationGuildCommands(settings.applicationId, settings.guildId), {
      body: commandDefs,
    });
    console.log(`Registered ${commandDefs.length} guild slash commands.`);
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    // Recover persisted deadlines so timers survive restarts.
    ctx.timers.recoverAll();
    ctx.timers.startSweep();
    // Refresh the persistent queue panel if one was stored.
    await ctx.queue.reconcilePanel().catch((e) => console.error('Panel reconcile failed:', e));
    // Periodic housekeeping: evict players who waited too long with no match.
    if (!queueSweep) {
      queueSweep = setInterval(() => {
        void ctx.queue.sweepStale().catch((e) => console.error('Queue sweep failed:', e));
      }, 30_000);
      queueSweep.unref();
    }
  });

  process.on('SIGINT', () => {
    ctx.timers.stop();
    if (queueSweep) clearInterval(queueSweep);
    db.db.close();
    process.exit(0);
  });

  await client.login(settings.discordToken);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});