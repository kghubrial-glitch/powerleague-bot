import { EmbedBuilder } from 'discord.js';
import { parseDbTimestamp } from './dbTime';

/**
 * Shared visual identity for every bot message.
 *
 * Color system:
 *  - BLUE   information / neutral
 *  - GREEN  confirmed / completed
 *  - ORANGE pending / waiting
 *  - RED    errors / cancellations
 *  - PURPLE competitive information (profiles, leaderboards)
 *  - GRAY   archived matches
 *
 * No emojis are used anywhere; titles/descriptions use plain text.
 */
export const EMBED_COLORS = {
  info: 0x5865f2, // blue
  success: 0x57f287, // green
  pending: 0xfee75c, // orange/yellow
  error: 0xed4245, // red
  competitive: 0x9b59b6, // purple
  muted: 0x808080, // gray
} as const;

export type EmbedColor = keyof typeof EMBED_COLORS;

/** Creates a consistent embed with a title, description and color key. */
export function scrimEmbed(color: EmbedColor, title: string, description = ''): EmbedBuilder {
  return new EmbedBuilder().setColor(EMBED_COLORS[color]).setTitle(title).setDescription(description);
}

/** A colored bullet for listing lines. */
export function bullet(text: string): string {
  return `\u2022 ${text}`;
}

/** Converts a DB/ISO timestamp into a Discord relative timestamp markdown. */
export function relativeTimestamp(iso: string): string {
  const ms = parseDbTimestamp(iso);
  if (Number.isNaN(ms)) return iso;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** Converts a DB/ISO timestamp into a Discord short-date/time markdown. */
export function shortTimestamp(iso: string): string {
  const ms = parseDbTimestamp(iso);
  if (Number.isNaN(ms)) return iso;
  return `<t:${Math.floor(ms / 1000)}:d> <t:${Math.floor(ms / 1000)}:t>`;
}
