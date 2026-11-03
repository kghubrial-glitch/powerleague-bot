import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Settings, RankTier } from './config/settings';
import { QueueEntryRow, MatchRow, UserRow, MapRow } from './types';
import { rankForElo, displayRank, divisionForElo, divisionName } from './elo/rankManager';
import { MatchRepository } from './database/repositories/matchRepository';
import { EMBED_COLORS, relativeTimestamp, shortTimestamp, bullet } from './presentation/embeds';

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

export function queueEmbed(entries: QueueEntryRow[], settings: Settings, enabledMaps?: number, queueActive = true): EmbedBuilder {
  const size = settings.queueSize;
  const embed = new EmbedBuilder()
    .setTitle('POWER LEAGUE | COMPETITIVE SCRIMS')
    .setColor(EMBED_COLORS.info)
    .setDescription(
      '3V3 MATCHMAKING\n\n' +
        `Queue Status: **${queueActive ? 'OPEN' : 'LOCKED'}**\n` +
        `Players Waiting: **${entries.length}/${size}**`
    );

  const lines: string[] = [];
  const slotCount = Math.max(size, entries.length);
  for (let i = 0; i < slotCount; i++) {
    const entry = entries[i];
    lines.push(entry ? `${i + 1}. ${entry.username} — ${entry.elo_at_join} Elo` : `${i + 1}. Waiting...`);
  }
  embed.addFields({ name: 'Current Queue', value: lines.map((l) => `\`${l}\``).join('\n') });

  const body: string[] = [];
  if (entries.length > 0) {
    const avg = Math.round(entries.reduce((a, e) => a + e.elo_at_join, 0) / entries.length);
    body.push(`Average Queue Elo: **${avg}**`);
  }
  body.push(`Match Format: **${settings.matchFormat === 'best_of_3' ? 'Best of 3' : 'Best of 1'}**`);
  body.push(`Matchmaking: **${settings.matchmakingMode === 'draft' ? 'Captain Draft' : 'Automatic Balanced'}**`);
  if (settings.minElo !== undefined || settings.maxElo !== undefined) {
    const min = settings.minElo ?? 0;
    const max = settings.maxElo ?? 15000;
    body.push(`Elo Range: **${min} - ${max}**`);
  }
  if (enabledMaps !== undefined) {
    body.push(`Map Pool: **${enabledMaps} maps enabled**`);
  }
  embed.addFields({ name: 'Matchmaking Settings', value: body.join('\n') || 'Default settings' });
  embed.setFooter({ text: 'Six players start a scrim automatically.' });
  return embed;
}

export function queueActionRows(): ActionRowBuilder<ButtonBuilder>[] {
  const join = new ButtonBuilder()
    .setCustomId('queue:join')
    .setLabel('JOIN QUEUE')
    .setStyle(ButtonStyle.Success);
  const leave = new ButtonBuilder()
    .setCustomId('queue:leave')
    .setLabel('LEAVE QUEUE')
    .setStyle(ButtonStyle.Danger);
  const refresh = new ButtonBuilder()
    .setCustomId('queue:refresh')
    .setLabel('REFRESH')
    .setStyle(ButtonStyle.Secondary);
  const profile = new ButtonBuilder()
    .setCustomId('queue:profile')
    .setLabel('MY PROFILE')
    .setStyle(ButtonStyle.Secondary);
  const leaderboard = new ButtonBuilder()
    .setCustomId('queue:leaderboard')
    .setLabel('LEADERBOARD')
    .setStyle(ButtonStyle.Secondary);

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

export function matchStatusLine(match: MatchRow): string {
  switch (match.status) {
    case 'awaiting_teamcode':
      return 'STATUS: Waiting for TeamCode';
    case 'awaiting_ready':
      return 'STATUS: Waiting for readiness';
    case 'in_progress':
      return 'STATUS: Match in progress';
    case 'voting':
      return 'STATUS: Result voting in progress';
    case 'confirmed':
      return `STATUS: Confirmed - Winner: ${winnerLabel(match.winner)}`;
    case 'disputed':
      return 'STATUS: Disputed (awaiting staff)';
    case 'cancelled':
      return `STATUS: Cancelled - ${match.cancellation_reason ?? 'no reason'}`;
    case 'timed_out':
      return `STATUS: Timed out - ${match.cancellation_reason ?? 'no reason'}`;
    case 'archived':
      return 'STATUS: Archived';
    default:
      return 'STATUS: Unknown';
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
    .setTitle(`SCRIM MATCH #${match.match_id.replace('scrim-', '')}`)
    .setColor(matchColor(match))
    .setDescription(matchStatusLine(match));

  const ranks = view.ranks;
  const teamLines = (players: MatchPlayerInfo[]) =>
    players
      .map((p) => {
        const rank = displayRank(p.elo, ranks);
        return `<@${p.id}> — ${p.elo} Elo (${rank})`;
      })
      .join('\n');

  embed.addFields(
    { name: `TEAM A${match.winner === 'A' ? ' (WINNER)' : ''}`, value: teamLines(teamA), inline: true },
    { name: `TEAM B${match.winner === 'B' ? ' (WINNER)' : ''}`, value: teamLines(teamB), inline: true }
  );

  const details: string[] = [];
  details.push(`Game Mode: **${match.game_mode ?? 'Not configured'}**`);
  details.push(`Map: **${match.map ?? 'Not selected'}**`);
  details.push(`Format: **${match.format === 'best_of_3' ? 'Best of 3' : 'Best of 1'}**`);
  details.push(`Matchmaking: **${match.matchmaking === 'draft' ? 'Captain Draft' : 'Automatic Balanced'}**`);
  if (match.status === 'awaiting_ready' || match.status === 'in_progress') {
    if (match.format === 'best_of_3') {
      details.push(`Series: **${match.team_a_score}-${match.team_b_score}** (first to 2 of 3)`);
    } else {
      details.push(`Series: **${match.team_a_score}-${match.team_b_score}** (single game)`);
    }
  }
  if (match.status === 'confirmed' || match.status === 'disputed') {
    details.push(`Final Score: **${match.team_a_score} - ${match.team_b_score}**`);
    if (match.winner) details.push(`Winner: **${winnerLabel(match.winner)}**`);
  }
  if (match.status === 'voting') {
    details.push(`Votes: **${view.votesCount}/6** cast (choices stay private until voting ends)`);
  }
  if (match.status === 'confirmed' || match.status === 'disputed') {
    const countLine = Object.entries(view.voteTotals)
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k === 'A' ? 'Team A' : k === 'B' ? 'Team B' : 'Draw'}: ${c}`)
      .join('  |  ');
    if (countLine) details.push(countLine);
  }
  if (match.team_code) {
    details.push('TeamCode: submitted');
  }
  if (match.created_at) {
    details.push(`Created: ${relativeTimestamp(match.created_at)}`);
  }

  embed.addFields({ name: 'Match Details', value: details.join('\n') });

  // Live fault-report dashboard for cancelled / timed-out matches.
  if (view.fault && (match.status === 'cancelled' || match.status === 'timed_out')) {
    const fault = view.fault;
    const lines: string[] = [];
    lines.push(`**${fault.reporterCount}/${fault.participantCount}** players have reported`);
    if (fault.reporterCount >= fault.participantCount) {
      lines.push('All participants have reported — the report window is closed.');
    }
    const dodges = fault.dodges.map((d) => `⚠️ <@${d.reported_player_id}> — ${d.reports} reports (${d.status.replace(/_/g, ' ')} )`).join('\n');
    if (dodges) lines.push(dodges);
    const playerLines = fault.byReported
      .map((t) => `<@${t.reported_player_id}> — **${t.count}** report${t.count === 1 ? '' : 's'}${Object.keys(t.reasons).length ? ` (${Object.entries(t.reasons).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`)
      .join('\n');
    if (playerLines) {
      lines.push('**Player reports**');
      lines.push(playerLines);
    }
    const generalEntries = Object.entries(fault.general);
    if (generalEntries.length) {
      lines.push(`**General** — ${generalEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    }
    lines.push('**Rule:** if **4 players from both teams** report the same player, staff is notified for review.');
    embed.addFields({ name: 'FAULT REPORTS', value: lines.join('\n') });
  }

  // Live readiness section.
  if (match.status === 'awaiting_ready' || match.status === 'in_progress') {
    const readyMembers = new Set(view.ready);
    const participants = [...teamA, ...teamB];
    const allReady = readyMembers.size >= participants.length;
    const sections = ['MATCH READINESS'];
    for (const [label, team] of [
      ['TEAM A', teamA],
      ['TEAM B', teamB],
    ] as const) {
      sections.push(label);
      for (const p of team) {
        const isReady = readyMembers.has(p.id);
        sections.push(`${isReady ? 'READY' : 'WAITING'}  <@${p.id}>`);
      }
    }
    sections.push(`${readyMembers.size}/${participants.length} PLAYERS READY`);
    const waiting = participants.filter((p) => !readyMembers.has(p.id));
    if (waiting.length > 0 && !allReady) {
      sections.push(`Players Waiting: ${waiting.map((p) => `<@${p.id}>`).join(' ')}`);
    }
    embed.addFields({ name: 'Readiness', value: sections.join('\n') });
  }

  embed.setFooter({ text: match.match_id });
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
      new ButtonBuilder().setCustomId('vote:A').setLabel('TEAM A WON').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('vote:B').setLabel('TEAM B WON').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('vote:draw').setLabel('DRAW').setStyle(ButtonStyle.Secondary)
    );
  } else {
    if (actions.teamCode) {
      main.push(new ButtonBuilder().setCustomId('match:teamcode').setLabel('TEAM CODE').setStyle(ButtonStyle.Primary));
    }
    if (actions.ready) {
      main.push(new ButtonBuilder().setCustomId('match:ready').setLabel('READY (JOINED TEAM)').setStyle(ButtonStyle.Success));
    }
    if (actions.copyCode) {
      main.push(new ButtonBuilder().setCustomId('match:copycode').setLabel('COPY / VIEW CODE').setStyle(ButtonStyle.Secondary));
    }
    if (actions.finished) {
      main.push(new ButtonBuilder().setCustomId('match:finished').setLabel('MATCH FINISHED').setStyle(ButtonStyle.Primary));
    }
    if (actions.cancel) {
      main.push(new ButtonBuilder().setCustomId('match:cancel').setLabel('CANCEL / REPORT ISSUE').setStyle(ButtonStyle.Danger));
    }
  }
  if (actions.faultButtons) {
    main.push(
      new ButtonBuilder().setCustomId('fault:select').setLabel('REPORT WHAT HAPPENED').setStyle(ButtonStyle.Secondary)
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
    .setTitle('PLAYER PROFILE')
    .setDescription(`Player: <@${user.discord_id}>`)
    .setColor(EMBED_COLORS.competitive)
    .addFields(
      {
        name: 'COMPETITIVE RATING',
        value: `${user.elo} ELO\nRANK: **${displayRank(user.elo, ranks)}**${isTopRank ? '' : ` (Division ${divisionName(division)})`}`,
        inline: false,
      },
      { name: 'Next Rank Progress', value: `${progress}%`, inline: true },
      { name: 'Peak Elo', value: `${user.peak_elo}`, inline: true },
      { name: 'CAREER STATISTICS', value: `Matches: ${user.total_matches}\nWins: ${user.wins}\nLosses: ${user.losses}\nDraws: ${user.draws}\nWin Rate: ${winRate}%`, inline: false },
      { name: 'Streaks', value: `Current: ${streakLabel}\nBest: ${user.best_streak}`, inline: true }
    );
  if (user.created_at) {
    embed.addFields({ name: 'Registered', value: shortTimestamp(user.created_at), inline: true });
  }
  if (user.last_match_at) {
    embed.addFields({ name: 'Last Match', value: relativeTimestamp(user.last_match_at), inline: true });
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
    embed.addFields({ name: 'TOP MAPS', value: lines || 'No data', inline: false });
  }
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
  const embed = new EmbedBuilder()
    .setTitle('SCRIM LEADERBOARD')
    .setColor(EMBED_COLORS.competitive)
    .setDescription(`Sorted by current Elo | Page ${page + 1}/${pages}`);
  const lines = rows.map((r, i) => {
    return `#${startIndex + i + 1} **${r.username}** — ${r.elo} Elo (${displayRank(r.elo, settings.ranks)}) | ${r.wins}W/${r.losses}L`;
  });
  embed.addFields({ name: `Top players (${total})`, value: lines.join('\n') || 'No players yet' });
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
    .setTitle('MATCH HISTORY')
    .setColor(EMBED_COLORS.competitive)
    .setDescription(`Recent matches | Page ${page + 1}/${pages}`);

  const lines = rows.map(({ match, eloChange }) => {
    const teamA = repo.teamAIds(match);
    const onA = teamA.includes(userId);
    const outcome = match.winner === null ? '—' : match.winner === 'draw' ? 'DRAW' : onA === (match.winner === 'A') ? 'WIN' : match.status === 'cancelled' || match.status === 'timed_out' ? statusShort(match.status) : 'LOSS';
    const elo = eloChange === null ? '' : `${eloChange >= 0 ? '+' : ''}${eloChange} Elo`;
    return `**#${match.match_id.replace('scrim-', '')}** ${shortTimestamp(match.created_at)} | ${statusShort(match.status)} | ${onA ? 'TEAM A' : 'TEAM B'} | ${match.map ?? '?'}\n↳ ${outcome}${elo ? ' | ' + elo : ''}`;
  });
  embed.addFields({ name: 'Recent matches', value: lines.join('\n') || 'No matches yet' });
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
    .setTitle('MAP POOL')
    .setColor(EMBED_COLORS.info);
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
    embed.addFields({ name: `Enabled (${enabled.length})`, value: modeLines.join('\n') || 'None' });
  } else {
    embed.addFields({
      name: `Enabled (${enabled.length})`,
      value: enabled.map((m) => bullet(m.name)).join('\n') || 'None',
    });
  }
  embed.addFields({
    name: `Disabled (${disabled.length})`,
    value: disabled.map((m) => bullet(m.name)).join('\n') || 'None',
  });
  if (recent.length) {
    embed.addFields({
      name: 'Recently used',
      value: recent.map((r) => bullet(`${r.name} (${relativeTimestamp(r.selected_at)})`)).join('\n'),
    });
  }
  return embed;
}

export { rankForElo };