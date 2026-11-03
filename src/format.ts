import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Settings, RankTier } from './config/settings';
import { QueueEntryRow, MatchRow, UserRow, MapRow, MatchStatus } from './types';
import { rankForElo, displayRank, divisionForElo, divisionName } from './elo/rankManager';
import { MatchRepository } from './database/repositories/matchRepository';
import { EMBED_COLORS, relativeTimestamp, shortTimestamp, bullet } from './presentation/embeds';
import { parseDbTimestamp } from './presentation/dbTime';
import { BRAND_NAME, BRAND_SHORT, BRAND_FOOTER, EMOJI } from './presentation/brand';

export function clampElo(n: number): number {
  return Math.max(0, Math.round(n));
}

export function userDisplay(user: { username: string; elo: number }): string {
  return `**${user.username}**`;
}

/** Percent progress from one threshold toward the next (0..100). */
export function rankProgress(elo: number, rank: RankTier, ranks: RankTier[]): number {
  const idx = ranks.findIndex((r) => r.name === rank.name);
  const next = idx >= 0 ? ranks[idx + 1] : undefined;
  if (!next) return 100;
  const span = next.threshold - rank.threshold;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((elo - rank.threshold) / span) * 100)));
}

// ---------------------------------------------------------------------------
// Queue panel
// ---------------------------------------------------------------------------

/** Replaces "scrim-1234" with "svm-1234" for display, or keeps other ids. */
export function prettyMatchId(matchId: string): string {
  return matchId.startsWith('scrim-') ? `svm-${matchId.slice('scrim-'.length)}` : matchId;
}

/** The safe, lowercase base name of a match channel (e.g. svm-0042). */
export function matchChannelBaseName(matchId: string): string {
  return prettyMatchId(matchId).toLowerCase();
}

/** Status-aware channel name so the room title reflects the match phase. */
export function matchChannelName(matchId: string, status: MatchStatus): string {
  const base = matchChannelBaseName(matchId);
  switch (status) {
    case 'drafting':
      return `${base}-draft`;
    case 'awaiting_teamcode':
      return `${base}-code`;
    case 'awaiting_ready':
      return `${base}-ready`;
    case 'in_progress':
      return `${base}-live`;
    case 'voting':
      return `${base}-vote`;
    case 'confirmed':
      return `${base}-done`;
    case 'disputed':
      return `${base}-dispute`;
    case 'cancelled':
      return `${base}-cancel`;
    case 'timed_out':
      return `${base}-timeout`;
    case 'archived':
      return `${base}-done`;
    default:
      return base;
  }
}

/** Number of full game series each format targets (for the queue panel). */
function seriesTarget(format: Settings['matchFormat']): string {
  return format === 'best_of_3' ? 'first to win 2 games' : 'single game';
}

export function queueEmbed(
  entries: QueueEntryRow[],
  settings: Settings,
  enabledMaps?: number,
  queueActive = true
): EmbedBuilder {
  const size = settings.queueSize;
  const fmt = settings.matchFormat === 'best_of_3' ? 'Best of 3' : 'Best of 1';
  const mm = settings.matchmakingMode === 'draft' ? 'Captain Draft' : 'Auto Balanced';
  const status = queueActive ? `${EMOJI.join} Queue **OPEN**` : `${EMOJI.forbidden} Queue **LOCKED**`;
  const waitingNeeded = Math.max(0, size - entries.length);

  const embed = new EmbedBuilder()
    .setTitle(`${EMOJI.queue} ${BRAND_NAME} · 3v3 SCRIMS`)
    .setColor(queueActive ? EMBED_COLORS.success : EMBED_COLORS.error)
    .setDescription(
      `**${status}**\n` +
        `Players in queue: **${entries.length}/${size}**\n` +
        (waitingNeeded > 0 ? `Need **${waitingNeeded} more** to start a match.` : 'Queue is full — assembling teams…')
    );

  const lines: string[] = [];
  const slotCount = Math.max(size, entries.length);
  for (let i = 0; i < slotCount; i++) {
    const entry = entries[i];
    if (entry) {
      const waited = waitedTime(entry.joined_at);
      lines.push(`${i + 1}. ${EMOJI.approved} **${entry.username}** — ${entry.elo_at_join} Elo · waiting ${waited}`);
    } else {
      lines.push(`${i + 1}. ${EMOJI.waiting} Waiting…`);
    }
  }
  embed.addFields({ name: 'CURRENT QUEUE', value: lines.map((l) => `\`${l}\``).join('\n') });

  const body: string[] = [];
  if (entries.length > 0) {
    const avg = Math.round(entries.reduce((a, e) => a + e.elo_at_join, 0) / entries.length);
    body.push(`Average elo: **${avg}**`);
  }
  body.push(`Format: **${fmt}** (${seriesTarget(settings.matchFormat)})`);
  body.push(`Matchmaking: **${mm}**`);
  if (settings.minElo !== undefined || settings.maxElo !== undefined) {
    const min = settings.minElo ?? 0;
    const max = settings.maxElo ?? 15000;
    body.push(`Elo range: **${min}–${max}**`);
  }
  if (enabledMaps !== undefined) {
    body.push(`Map pool: **${enabledMaps}** enabled`);
  }
  embed.addFields({ name: 'SETTINGS', value: body.join('\n') });

  embed.setFooter({ text: `${BRAND_FOOTER} · six ready players start a scrim` });
  return embed;
}

/** "2m 10s" wait label from a join timestamp. */
function waitedTime(iso: string): string {
  const ms = Date.now() - parseDbTimestamp(iso);
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}m ${rest}s`;
}

export function queueActionRows(): ActionRowBuilder<ButtonBuilder>[] {
  const join = new ButtonBuilder()
    .setCustomId('queue:join')
    .setLabel('Join Queue')
    .setStyle(ButtonStyle.Success)
    .setEmoji('✅');
  const leave = new ButtonBuilder()
    .setCustomId('queue:leave')
    .setLabel('Leave Queue')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🚪');
  const refresh = new ButtonBuilder()
    .setCustomId('queue:refresh')
    .setLabel('Refresh')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('🔄');
  const profile = new ButtonBuilder()
    .setCustomId('queue:profile')
    .setLabel('My Profile')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('👤');
  const leaderboard = new ButtonBuilder()
    .setCustomId('queue:leaderboard')
    .setLabel('Leaderboard')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🏆');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(join, leave, refresh);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(profile, leaderboard);
  return [row, row2];
}

// ---------------------------------------------------------------------------
// Match embeds
// ---------------------------------------------------------------------------

export interface MatchPlayerInfo {
  id: string;
  username: string;
  elo: number;
}

export interface FaultTally {
  reported_player_id: string;
  count: number;
  reasons: Record<string, number>;
}

export interface FaultDashboard {
  reporterCount: number;
  participantCount: number;
  byReported: FaultTally[];
  general: Record<string, number>;
  dodges: Array<{ reported_player_id: string; reports: number; status: string }>;
}

export interface MatchView {
  match: MatchRow;
  teamA: MatchPlayerInfo[];
  teamB: MatchPlayerInfo[];
  ready: string[];
  votesCount: number;
  voteTotals: Record<string, number>;
  ranks: RankTier[];
  maps: MapRow[];
  fault?: FaultDashboard;
}

/** Human-friendly, progress-oriented status for the match embed. */
export function matchStatusLine(match: MatchRow): string {
  switch (match.status) {
    case 'drafting':
      return 'Phase: **captain draft in progress** — pick your teams';
    case 'awaiting_teamcode':
      return 'Phase: **waiting for TeamCode** — join the in-game lobby with the code';
    case 'awaiting_ready':
      return 'Phase: **waiting for everyone to ready in-game**';
    case 'in_progress':
      return 'Phase: **match is live** — good luck!';
    case 'voting':
      return 'Phase: **result voting** — cast a private vote';
    case 'confirmed':
      return `Phase: **completed** — ${EMOJI.trophy} Winner: **${winnerLabel(match.winner)}**`;
    case 'disputed':
      return 'Phase: **disputed** — staff must resolve this match';
    case 'cancelled':
      return `Phase: **cancelled** — ${match.cancellation_reason ?? 'no reason given'}`;
    case 'timed_out':
      return `Phase: **timed out** — ${match.cancellation_reason ?? 'no reason given'}`;
    case 'archived':
      return 'Phase: **archived**';
    default:
      return 'Phase: unknown';
  }
}

export function winnerLabel(winner: MatchRow['winner']): string {
  return winner === 'A' ? 'TEAM A' : winner === 'B' ? 'TEAM B' : 'DRAW';
}

function matchColor(match: MatchRow): number {
  switch (match.status) {
    case 'confirmed':
      return EMBED_COLORS.success;
    case 'cancelled':
    case 'timed_out':
      return EMBED_COLORS.error;
    case 'disputed':
      return EMBED_COLORS.pending;
    case 'voting':
      return EMBED_COLORS.pending;
    case 'archived':
      return EMBED_COLORS.muted;
    default:
      return EMBED_COLORS.info;
  }
}

export function buildMatchEmbed(view: MatchView): EmbedBuilder {
  const { match, teamA, teamB } = view;
  const embed = new EmbedBuilder()
    .setTitle(`${EMOJI.queue} ${BRAND_SHORT} MATCH · ${prettyMatchId(match.match_id).toUpperCase()}`)
    .setColor(matchColor(match))
    .setDescription(matchStatusLine(match));

  const ranks = view.ranks;
  const teamLines = (players: MatchPlayerInfo[]) =>
    players
      .map((p) => {
        const rank = displayRank(p.elo, ranks);
        return `${EMOJI.approved} <@${p.id}> — ${p.elo} Elo (${rank})`;
      })
      .join('\n');

  embed.addFields(
    { name: `TEAM A${match.winner === 'A' ? ' · WINNER' : ''}`, value: teamLines(teamA), inline: true },
    { name: `TEAM B${match.winner === 'B' ? ' · WINNER' : ''}`, value: teamLines(teamB), inline: true }
  );

  const details: string[] = [];
  details.push(`${EMOJI.map} Map: **${match.map ?? 'Not selected'}** · Mode: **${match.game_mode ?? '—'}**`);
  details.push(`📏 Format: **${match.format === 'best_of_3' ? 'Best of 3' : 'Best of 1'}** · ${match.matchmaking === 'draft' ? 'Captain Draft' : 'Auto Balanced'}`);
  if (match.status === 'awaiting_ready' || match.status === 'in_progress' || match.status === 'voting') {
    const target = match.format === 'best_of_3' ? 'first to 2 of 3' : 'single game';
    details.push(`🔢 Series: **${match.team_a_score}–${match.team_b_score}** (${target})`);
  }
  if (match.status === 'confirmed' || match.status === 'disputed') {
    details.push(`🔢 Final score: **${match.team_a_score}–${match.team_b_score}**`);
    if (match.winner) details.push(`🏅 Winner: **${winnerLabel(match.winner)}**`);
  }
  if (match.status === 'voting') {
    details.push(`🗳️ Votes: **${view.votesCount}/6** cast — choices stay private until voting ends`);
  }
  if (match.status === 'confirmed' || match.status === 'disputed') {
    const countLine = Object.entries(view.voteTotals)
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k === 'A' ? 'Team A' : k === 'B' ? 'Team B' : 'Draw'}: ${c}`)
      .join(' · ');
    if (countLine) details.push(`🗳️ Final votes: ${countLine}`);
  }
  if (match.team_code) {
    details.push(`🔑 TeamCode: **submitted** (keep it in this channel only)`);
  }
  if (match.created_at) {
    details.push(`🕒 Created: ${relativeTimestamp(match.created_at)}`);
  }

  embed.addFields({ name: 'MATCH DETAILS', value: details.join('\n') });

  // Live fault-report dashboard for cancelled / timed-out matches.
  if (view.fault && (match.status === 'cancelled' || match.status === 'timed_out')) {
    const fault = view.fault;
    const lines: string[] = [];
    lines.push(`📋 **${fault.reporterCount}/${fault.participantCount}** players have reported`);
    if (fault.reporterCount >= fault.participantCount) {
      lines.push('All participants reported — suggestions are closed.');
    }
    const dodges = fault.dodges.map((d) => `⚠️ <@${d.reported_player_id}> — ${d.reports} reports (${d.status.replace(/_/g, ' ')})`).join('\n');
    if (dodges) lines.push(dodges);
    const playerLines = fault.byReported
      .map((t) => `<@${t.reported_player_id}> — **${t.count}** report${t.count === 1 ? '' : 's'}${Object.keys(t.reasons).length ? ` (${Object.entries(t.reasons).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`)
      .join('\n');
    if (playerLines) {
      lines.push('**Accusations**');
      lines.push(playerLines);
    }
    const generalEntries = Object.entries(fault.general);
    if (generalEntries.length) {
      lines.push(`**General** — ${generalEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    }
    lines.push('**Rule:** if **4 players from both teams** accuse the same player, staff is notified.');
    embed.addFields({ name: 'FAULT REPORTS', value: lines.join('\n') });
  }

  // Live readiness section.
  if (match.status === 'awaiting_ready' || match.status === 'in_progress') {
    const readyMembers = new Set(view.ready);
    const participants = [...teamA, ...teamB];
    const allReady = readyMembers.size >= participants.length;
    const sections: string[] = [];
    for (const [label, team] of [
      ['TEAM A', teamA],
      ['TEAM B', teamB],
    ] as const) {
      sections.push(`**${label}**`);
      for (const p of team) {
        const isReady = readyMembers.has(p.id);
        sections.push(`${isReady ? EMOJI.ready : '🔘'} <@${p.id}> — ${isReady ? 'READY' : 'WAITING'}`);
      }
    }
    sections.push(`${EMOJI.ready} **${readyMembers.size}/${participants.length}** players ready`);
    const waiting = participants.filter((p) => !readyMembers.has(p.id));
    if (waiting.length > 0 && !allReady) {
      sections.push(`🔎 Still waiting: ${waiting.map((p) => `<@${p.id}>`).join(' ')}`);
    }
    embed.addFields({ name: 'READINESS', value: sections.join('\n') });
  }

  embed.setFooter({ text: `${prettyMatchId(match.match_id)} · ${BRAND_NAME}` });
  return embed;
}

export interface MatchActions {
  teamCode: boolean;
  ready: boolean;
  finished: boolean;
  cancel: boolean;
  vote: boolean;
  copyCode: boolean;
  faultButtons: boolean;
}

export function matchActionRows(actions: MatchActions): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const main: Array<ButtonBuilder | null> = [];
  if (actions.vote) {
    main.push(
      new ButtonBuilder().setCustomId('vote:A').setLabel('Team A won').setStyle(ButtonStyle.Success).setEmoji('🅰️'),
      new ButtonBuilder().setCustomId('vote:B').setLabel('Team B won').setStyle(ButtonStyle.Danger).setEmoji('🅱️'),
      new ButtonBuilder().setCustomId('vote:draw').setLabel('Draw').setStyle(ButtonStyle.Secondary).setEmoji('🤝')
    );
  } else {
    if (actions.teamCode) {
      main.push(new ButtonBuilder().setCustomId('match:teamcode').setLabel('TeamCode').setStyle(ButtonStyle.Primary).setEmoji('🔑'));
    }
    if (actions.ready) {
      main.push(new ButtonBuilder().setCustomId('match:ready').setLabel('Ready · I joined in-game').setStyle(ButtonStyle.Success).setEmoji('✅'));
    }
    if (actions.copyCode) {
      main.push(new ButtonBuilder().setCustomId('match:copycode').setLabel('View TeamCode').setStyle(ButtonStyle.Secondary).setEmoji('👁️'));
    }
    if (actions.finished) {
      main.push(new ButtonBuilder().setCustomId('match:finished').setLabel('Match finished').setStyle(ButtonStyle.Primary).setEmoji('🏁'));
    }
    if (actions.cancel) {
      main.push(new ButtonBuilder().setCustomId('match:cancel').setLabel('Cancel / issue').setStyle(ButtonStyle.Danger).setEmoji('🚫'));
    }
  }
  if (actions.faultButtons) {
    main.push(
      new ButtonBuilder().setCustomId('fault:select').setLabel('What happened?').setStyle(ButtonStyle.Secondary).setEmoji('📋')
    );
  }
  const nonNull = main.filter((b): b is ButtonBuilder => b !== null);
  while (nonNull.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(nonNull.splice(0, 5)));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Player profile
// ---------------------------------------------------------------------------

export function profileEmbed(user: UserRow, settings: Settings, mapStats?: Array<{ map: string; wins: number; losses: number; draws: number }>): EmbedBuilder {
  const ranks = settings.ranks;
  const rank = rankForElo(user.elo, ranks);
  const division = divisionForElo(user.elo, ranks);
  const winRate = user.total_matches > 0 ? ((user.wins / user.total_matches) * 100).toFixed(1) : '0.0';
  const streakLabel =
    user.current_streak === 0 ? '—' : `${user.current_streak} ${user.current_streak > 0 ? 'Win' : 'Loss'}${Math.abs(user.current_streak) === 1 ? '' : 'es'}`;
  const progress = rankProgress(user.elo, rank, ranks);
  const isTopRank = ranks.findIndex((r) => r.name === rank.name) === ranks.length - 1;

  const embed = new EmbedBuilder()
    .setTitle(`${EMOJI.profile} PLAYER PROFILE`)
    .setDescription(`Player: <@${user.discord_id}>`)
    .setColor(EMBED_COLORS.competitive)
    .addFields(
      {
        name: '🏆 COMPETITIVE RATING',
        value: `${user.elo} Elo\nRank: **${displayRank(user.elo, ranks)}**${isTopRank ? '' : ` · ${divisionName(division)}`}`,
        inline: false,
      },
      { name: 'Next rank', value: `${progress}%`, inline: true },
      { name: 'Peak Elo', value: `${user.peak_elo}`, inline: true },
      {
        name: '📊 CAREER',
        value: `Matches: **${user.total_matches}**\nWins: **${user.wins}** · Losses: **${user.losses}** · Draws: **${user.draws}**\nWin rate: **${winRate}%**`,
        inline: false,
      },
      { name: '🔥 Streaks', value: `Current: ${streakLabel}\nBest: ${user.best_streak}`, inline: true }
    );
  if (user.created_at) {
    embed.addFields({ name: '📅 Registered', value: shortTimestamp(user.created_at), inline: true });
  }
  if (user.last_match_at) {
    embed.addFields({ name: '💀 Last match', value: relativeTimestamp(user.last_match_at), inline: true });
  }
  if (mapStats && mapStats.length > 0) {
    const lines = mapStats
      .slice(0, 5)
      .map((s) => {
        const total = s.wins + s.losses + s.draws;
        const rate = total > 0 ? ((s.wins / total) * 100).toFixed(0) : '0';
        return `${s.map}: ${s.wins}W/${s.losses}L (${rate}%)`;
      })
      .join('\n');
    embed.addFields({ name: '🗺️ TOP MAPS', value: lines || 'No data', inline: false });
  }
  embed.setFooter({ text: BRAND_NAME });
  return embed;
}

export function leaderboardEmbed(
  rows: UserRow[],
  startIndex: number,
  total: number,
  page: number,
  pages: number,
  settings: Settings
): EmbedBuilder {
  const medal = (i: number): string => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${startIndex + i + 1}.`);
  const embed = new EmbedBuilder()
    .setTitle(`${EMOJI.leaderboard} ${BRAND_NAME} · LEADERBOARD`)
    .setColor(EMBED_COLORS.competitive)
    .setDescription(`Sorted by Elo · page **${page + 1}/${pages}**`);
  const lines = rows.map((r, i) => {
    return `${medal(i)} **${r.username}** — ${r.elo} Elo · ${displayRank(r.elo, settings.ranks)} · ${r.wins}W/${r.losses}L`;
  });
  embed.addFields({ name: `Top players`, value: lines.join('\n') || 'No players yet' });
  embed.setFooter({ text: BRAND_NAME });
  return embed;
}

export function historyEmbed(
  rows: Array<{ match: MatchRow; eloChange: number | null }>,
  userId: string,
  page: number,
  pages: number,
  repo: MatchRepository
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${EMOJI.queue} ${BRAND_NAME} · MATCH HISTORY`)
    .setColor(EMBED_COLORS.competitive)
    .setDescription(`Previous matches · page **${page + 1}/${pages}**`);

  const lines = rows.map(({ match, eloChange }) => {
    const teamA = repo.teamAIds(match);
    const onA = teamA.includes(userId);
    const outcome = match.winner === null ? '—' : match.winner === 'draw' ? 'DRAW' : onA === (match.winner === 'A') ? 'WIN' : match.status === 'cancelled' || match.status === 'timed_out' ? statusShort(match.status) : 'LOSS';
    const elo = eloChange === null ? '' : `${eloChange >= 0 ? '+' : ''}${eloChange} Elo`;
    return `**${prettyMatchId(match.match_id.toUpperCase())}** · ${shortTimestamp(match.created_at)} · ${statusShort(match.status)} · ${onA ? 'TEAM A' : 'TEAM B'} · ${match.map ?? '?'}\n↳ ${outcome}${elo ? ' · ' + elo : ''}`;
  });
  embed.addFields({ name: 'Recent matches', value: lines.join('\n') || 'No matches yet' });
  embed.setFooter({ text: BRAND_NAME });
  return embed;
}

function statusShort(status: MatchRow['status']): string {
  return status.toUpperCase();
}

// ---------------------------------------------------------------------------
// Map pool
// ---------------------------------------------------------------------------

export function mapsEmbed(maps: MapRow[], recent: Array<{ id: number; name: string; match_id: string | null; selected_at: string }>): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${EMOJI.map} ${BRAND_NAME} · MAP POOL`)
    .setColor(EMBED_COLORS.info)
    .setDescription(`${enabledCount(maps)} enabled · ${maps.length - enabledCount(maps)} disabled`);
  const enabled = maps.filter((m) => m.enabled === 1);
  const disabled = maps.filter((m) => m.enabled === 0);

  const byMode = new Map<string, MapRow[]>();
  for (const m of enabled) {
    const mode = m.game_mode ?? 'Unspecified';
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode)!.push(m);
  }
  const modeLines: string[] = [];
  for (const [mode, list] of byMode.entries()) {
    modeLines.push(`**${mode.toUpperCase()}**`);
    for (const m of list) {
      modeLines.push(bullet(m.name));
    }
  }
  if (modeLines.length) {
    embed.addFields({ name: 'ENABLED', value: modeLines.join('\n') || 'None' });
  } else {
    embed.addFields({
      name: 'ENABLED',
      value: enabled.map((m) => bullet(m.name)).join('\n') || 'None',
    });
  }
  if (disabled.length) {
    embed.addFields({
      name: 'DISABLED',
      value: disabled.map((m) => bullet(m.name)).join('\n') || 'None',
    });
  }
  if (recent.length) {
    embed.addFields({
      name: 'Recently used',
      value: recent.map((r) => bullet(`${r.name} (${relativeTimestamp(r.selected_at)})`)).join('\n'),
    });
  }
  embed.setFooter({ text: BRAND_NAME });
  return embed;
}

function enabledCount(maps: MapRow[]): number {
  return maps.filter((m) => m.enabled === 1).length;
}

export { rankForElo };