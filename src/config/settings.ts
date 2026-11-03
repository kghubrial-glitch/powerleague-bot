import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

/**
 * Configuration sources, in priority order (highest wins):
 *   1. shell / process environment (e.g. secrets injected by a host)
 *   2. a local, gitignored `config.json` file (recommended for the token and
 *      client id on a panel host that pulls the repo every restart)
 *   3. an optional legacy `.env` file
 *   4. built-in defaults
 *
 * Credentials MUST live in gitignored files (`config.json`, `.env`) or in
 * environment variables — never committed to the repository.
 */

function configFilePath(): string {
  return process.env.CONFIG_FILE || './config.json';
}

function dotenvFilePath(): string {
  return process.env.DOTENV_FILE || './.env';
}

type ConfigMap = Record<string, string>;

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Reads the gitignored config.json (if any) into an env-style map.
 *
 * Top-level keys mirror env var names exactly (e.g. `"DISCORD_BOT_TOKEN"`).
 * Nested value-types are flattened the same way as legacy env files, so
 * `"RANK_BRONZE": 1100` becomes the string `"1100"`.
 */
function loadFileConfig(): ConfigMap {
  const raw = readJson<Record<string, unknown>>(path.resolve(process.cwd(), configFilePath()));
  if (!raw) return {};
  const flat: ConfigMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    flat[key] = String(value);
  }
  return flat;
}

/** Parses the legacy .env file without mutating process.env. */
function loadDotEnv(): ConfigMap {
  try {
    const parsed = dotenv.parse(fs.readFileSync(path.resolve(process.cwd(), dotenvFilePath()), 'utf8'));
    return { ...parsed };
  } catch {
    return {};
  }
}

/**
 * Merges all sources into a single env-style map.
 * Priority: passed/process env > config.json > .env.
 */
function envFor(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shellEnv = env ?? process.env;
  return { ...loadDotEnv(), ...loadFileConfig(), ...shellEnv } as NodeJS.ProcessEnv;
}

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

export function loadSettings(env?: NodeJS.ProcessEnv): Settings {
  // Merge config.json + .env + the explicit/process environment.
  const merged = envFor(env);
  const dbPath = optionalStr('DATABASE_PATH', './data/scrims.db', merged);
  const absoluteDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(path.dirname(absoluteDbPath))) {
    fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });
  }

  const formatRaw = optionalStr('MATCH_FORMAT', 'best_of_1', merged);
  const matchFormat: MatchFormat = formatRaw === 'best_of_3' ? 'best_of_3' : 'best_of_1';

  return {
    discordToken: optionalStr('DISCORD_BOT_TOKEN', '', merged),
    applicationId: optionalStr('DISCORD_APPLICATION_ID', '', merged),
    guildId: optionalStr('DISCORD_GUILD_ID', '', merged),
    queueChannelId: optionalStr('QUEUE_CHANNEL_ID', merged),
    staffRoleId: optionalStr('STAFF_ROLE_ID', merged),
    databasePath: absoluteDbPath,
    queueSize: optionalInt('QUEUE_SIZE', 6, merged),
    minElo: optionalStr('MIN_ELO', merged) !== undefined ? optionalInt('MIN_ELO', 0, merged) : undefined,
    maxElo: optionalStr('MAX_ELO', merged) !== undefined ? optionalInt('MAX_ELO', 10000, merged) : undefined,
    teamBalanceTolerance: optionalInt('TEAM_BALANCE_TOLERANCE', 40, merged),
    matchFormat,
    mapRotationMode: optionalStr('MAP_ROTATION_MODE', merged) === 'random' ? 'random' : 'unique',
    timers: {
      teamCode: optionalInt('TIMER_TEAMCODE', 300, merged),
      ready: optionalInt('TIMER_READY', 300, merged),
      match: optionalInt('TIMER_MATCH', 900, merged),
      vote: optionalInt('TIMER_VOTE', 900, merged),
      faultReport: optionalInt('TIMER_FAULT_REPORT', 300, merged),
    },
    ranks: [
      { name: 'Bronze', threshold: optionalInt('RANK_BRONZE', 1000, merged) },
      { name: 'Silver', threshold: optionalInt('RANK_SILVER', 1100, merged) },
      { name: 'Gold', threshold: optionalInt('RANK_GOLD', 1250, merged) },
      { name: 'Diamond', threshold: optionalInt('RANK_DIAMOND', 1400, merged) },
      { name: 'Mythic', threshold: optionalInt('RANK_MYTHIC', 1600, merged) },
      { name: 'Legendary', threshold: optionalInt('RANK_LEGENDARY', 1800, merged) },
    ],
    leaderboardMinMatches: optionalInt('LEADERBOARD_MIN_MATCHES', 0, merged),
  };
}