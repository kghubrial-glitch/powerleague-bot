/**
 * The only game modes the bot accepts from administrators. Maps are always
 * pinned to one of these — admins cannot invent free-text modes, which kept
 * producing duplicates ("BRAWL BALL" vs "Brawl Ball") and UNSPECIFIED entries.
 *
 * The Discord choice *values* are the short slugs below (as requested:
 * hotzone, brawlball, bounty, knockout, gemgrab); the display names are shown
 * to users and stored in the database.
 */
export const GAME_MODE_CHOICES: Array<{ name: string; value: string }> = [
  { name: 'Hot Zone', value: 'hotzone' },
  { name: 'Brawl Ball', value: 'brawlball' },
  { name: 'Bounty', value: 'bounty' },
  { name: 'Knockout', value: 'knockout' },
  { name: 'Gem Grab', value: 'gemgrab' },
];

export type GameMode = 'Gem Grab' | 'Bounty' | 'Knockout' | 'Brawl Ball' | 'Hot Zone';

/** Slugs → canonical display names (also accepts the display name itself). */
const MODE_BY_SLUG: Record<string, GameMode> = {
  gemgrab: 'Gem Grab',
  bounty: 'Bounty',
  knockout: 'Knockout',
  brawlball: 'Brawl Ball',
  hotzone: 'Hot Zone',
  'gem grab': 'Gem Grab',
  'brawl ball': 'Brawl Ball',
  'hot zone': 'Hot Zone',
};

/** Human-readable list for error messages (e.g. "Gem Grab, Bounty, ..."). */
export const GAME_MODES: GameMode[] = ['Gem Grab', 'Bounty', 'Knockout', 'Brawl Ball', 'Hot Zone'];

/** True when the input is one of the allowed mode slugs/names. */
export function isGameMode(value: string): value is GameMode {
  return canonicalGameMode(value) !== null;
}

/** Canonical spelling for a slug or display name, or `null` if unknown. */
export function canonicalGameMode(value: string): GameMode | null {
  const key = value.trim().toLowerCase();
  if (MODE_BY_SLUG[key]) return MODE_BY_SLUG[key];
  return null;
}