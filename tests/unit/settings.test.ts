import { describe, it, expect } from 'vitest';
import { loadSettings } from '../../src/config/settings';

describe('settings', () => {
  it('defaults to single-game Best of 1 matches', () => {
    const settings = loadSettings({} as NodeJS.ProcessEnv);
    expect(settings.matchFormat).toBe('best_of_1');
  });

  it('allows opting into Best of 3', () => {
    const settings = loadSettings({ MATCH_FORMAT: 'best_of_3' } as NodeJS.ProcessEnv);
    expect(settings.matchFormat).toBe('best_of_3');
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