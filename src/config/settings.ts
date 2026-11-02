import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '' || raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalStr(name: string): string | undefined;
function optionalStr(name: string, fallback: string): string;
function optionalStr(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
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
  const dbPath = optionalStr('DATABASE_PATH', './data/scrims.db');
  const absoluteDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(path.dirname(absoluteDbPath))) {
    fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });
  }

  const formatRaw = optionalStr('MATCH_FORMAT', 'best_of_3') ?? 'best_of_3';
  const matchFormat: MatchFormat = formatRaw === 'best_of_1' ? 'best_of_1' : 'best_of_3';

  return {
    discordToken: optionalStr('DISCORD_BOT_TOKEN', '') ?? '',
    applicationId: optionalStr('DISCORD_APPLICATION_ID', '') ?? '',
    guildId: optionalStr('DISCORD_GUILD_ID', '') ?? '',
    queueChannelId: optionalStr('QUEUE_CHANNEL_ID'),
    staffRoleId: optionalStr('STAFF_ROLE_ID'),
    databasePath: absoluteDbPath,
    queueSize: optionalInt('QUEUE_SIZE', 6),
    minElo: optionalStr('MIN_ELO') !== undefined ? optionalInt('MIN_ELO', 0) : undefined,
    maxElo: optionalStr('MAX_ELO') !== undefined ? optionalInt('MAX_ELO', 10000) : undefined,
    teamBalanceTolerance: optionalInt('TEAM_BALANCE_TOLERANCE', 40),
    matchFormat,
    mapRotationMode: optionalStr('MAP_ROTATION_MODE') === 'random' ? 'random' : 'unique',
    timers: {
      teamCode: optionalInt('TIMER_TEAMCODE', 300),
      ready: optionalInt('TIMER_READY', 300),
      match: optionalInt('TIMER_MATCH', 900),
      vote: optionalInt('TIMER_VOTE', 900),
      faultReport: optionalInt('TIMER_FAULT_REPORT', 300),
    },
    ranks: [
      { name: 'Bronze', threshold: optionalInt('RANK_BRONZE', 1000) },
      { name: 'Silver', threshold: optionalInt('RANK_SILVER', 1100) },
      { name: 'Gold', threshold: optionalInt('RANK_GOLD', 1250) },
      { name: 'Diamond', threshold: optionalInt('RANK_DIAMOND', 1400) },
      { name: 'Mythic', threshold: optionalInt('RANK_MYTHIC', 1600) },
      { name: 'Legendary', threshold: optionalInt('RANK_LEGENDARY', 1800) },
    ],
    leaderboardMinMatches: optionalInt('LEADERBOARD_MIN_MATCHES', 0),
  };
}