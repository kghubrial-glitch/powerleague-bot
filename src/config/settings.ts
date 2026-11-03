import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

function optionalInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '' || raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalStr(name: string, env: NodeJS.ProcessEnv): string | undefined;
function optionalStr(name: string, fallback: string, env: NodeJS.ProcessEnv): string;
function optionalStr(name: string, fallbackOrEnv: string | NodeJS.ProcessEnv, maybeEnv?: NodeJS.ProcessEnv): string | undefined {
  const fallback = typeof fallbackOrEnv === 'string' ? fallbackOrEnv : undefined;
  const env = typeof fallbackOrEnv === 'string' ? maybeEnv ?? process.env : fallbackOrEnv;
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export type MatchFormat = 'best_of_1' | 'best_of_3';

export interface RankTier {
  name: string;
  threshold: number;
}

export interface Settings {
  discordToken: string;
  applicationId: string;
  guildId: string;
  queueChannelId: string | undefined;
  staffRoleId: string | undefined;
  databasePath: string;
  queueSize: number;
  minElo: number | undefined;
  maxElo: number | undefined;
  teamBalanceTolerance: number;
  matchFormat: MatchFormat;
  mapRotationMode: 'unique' | 'random';
  timers: {
    teamCode: number;
    ready: number;
    match: number;
    vote: number;
    faultReport: number;
  };
  ranks: RankTier[];
  leaderboardMinMatches: number;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const dbPath = optionalStr('DATABASE_PATH', './data/scrims.db', env);
  const absoluteDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(path.dirname(absoluteDbPath))) {
    fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });
  }

  const formatRaw = optionalStr('MATCH_FORMAT', 'best_of_1', env);
  const matchFormat: MatchFormat = formatRaw === 'best_of_3' ? 'best_of_3' : 'best_of_1';

  return {
    discordToken: optionalStr('DISCORD_BOT_TOKEN', '', env),
    applicationId: optionalStr('DISCORD_APPLICATION_ID', '', env),
    guildId: optionalStr('DISCORD_GUILD_ID', '', env),
    queueChannelId: optionalStr('QUEUE_CHANNEL_ID', env),
    staffRoleId: optionalStr('STAFF_ROLE_ID', env),
    databasePath: absoluteDbPath,
    queueSize: optionalInt('QUEUE_SIZE', 6, env),
    minElo: optionalStr('MIN_ELO', env) !== undefined ? optionalInt('MIN_ELO', 0, env) : undefined,
    maxElo: optionalStr('MAX_ELO', env) !== undefined ? optionalInt('MAX_ELO', 10000, env) : undefined,
    teamBalanceTolerance: optionalInt('TEAM_BALANCE_TOLERANCE', 40, env),
    matchFormat,
    mapRotationMode: optionalStr('MAP_ROTATION_MODE', env) === 'random' ? 'random' : 'unique',
    timers: {
      teamCode: optionalInt('TIMER_TEAMCODE', 300, env),
      ready: optionalInt('TIMER_READY', 300, env),
      match: optionalInt('TIMER_MATCH', 900, env),
      vote: optionalInt('TIMER_VOTE', 900, env),
      faultReport: optionalInt('TIMER_FAULT_REPORT', 300, env),
    },
    ranks: [
      { name: 'Bronze', threshold: optionalInt('RANK_BRONZE', 1000, env) },
      { name: 'Silver', threshold: optionalInt('RANK_SILVER', 1100, env) },
      { name: 'Gold', threshold: optionalInt('RANK_GOLD', 1250, env) },
      { name: 'Diamond', threshold: optionalInt('RANK_DIAMOND', 1400, env) },
      { name: 'Mythic', threshold: optionalInt('RANK_MYTHIC', 1600, env) },
      { name: 'Legendary', threshold: optionalInt('RANK_LEGENDARY', 1800, env) },
    ],
    leaderboardMinMatches: optionalInt('LEADERBOARD_MIN_MATCHES', 0, env),
  };
}