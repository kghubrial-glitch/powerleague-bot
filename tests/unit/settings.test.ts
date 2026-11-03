import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSettings } from '../../src/config/settings';

const CONFIG_VAR = 'CONFIG_FILE';
const originalConfigFile = process.env[CONFIG_VAR];

afterEach(() => {
  if (originalConfigFile === undefined) {
    delete process.env[CONFIG_VAR];
  } else {
    process.env[CONFIG_VAR] = originalConfigFile;
  }
});

function withConfigFile(contents: Record<string, unknown>, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  process.env[CONFIG_VAR] = file;
  try {
    fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('settings', () => {
  it('defaults to single-game Best of 1 matches', () => {
    const settings = loadSettings({} as NodeJS.ProcessEnv);
    expect(settings.matchFormat).toBe('best_of_1');
  });

  it('allows opting into Best of 3', () => {
    const settings = loadSettings({ MATCH_FORMAT: 'best_of_3' } as NodeJS.ProcessEnv);
    expect(settings.matchFormat).toBe('best_of_3');
  });

  it('loads credentials and options from config.json', () => {
    withConfigFile(
      {
        DISCORD_BOT_TOKEN: 'file-token',
        DISCORD_APPLICATION_ID: 'file-app',
        DISCORD_GUILD_ID: 'file-guild',
        QUEUE_SIZE: 8,
        MATCH_FORMAT: 'best_of_3',
      },
      () => {
        const settings = loadSettings({});
        expect(settings.discordToken).toBe('file-token');
        expect(settings.applicationId).toBe('file-app');
        expect(settings.guildId).toBe('file-guild');
        expect(settings.queueSize).toBe(8);
        expect(settings.matchFormat).toBe('best_of_3');
      }
    );
  });

  it('process env wins over config.json', () => {
    withConfigFile(
      {
        DISCORD_BOT_TOKEN: 'file-token',
        QUEUE_SIZE: 8,
      },
      () => {
        const settings = loadSettings({
          DISCORD_BOT_TOKEN: 'env-token',
          QUEUE_SIZE: '4',
        } as NodeJS.ProcessEnv);
        expect(settings.discordToken).toBe('env-token');
        expect(settings.queueSize).toBe(4);
      }
    );
  });

  it('parses queue and timer defaults', () => {
    const settings = loadSettings({} as NodeJS.ProcessEnv);
    expect(settings.queueSize).toBe(6);
    expect(settings.teamBalanceTolerance).toBe(40);
    expect(settings.timers.teamCode).toBe(300);
    expect(settings.timers.match).toBe(900);
    expect(settings.ranks.length).toBe(6);
  });
});