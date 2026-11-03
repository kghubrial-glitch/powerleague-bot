import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Settings, RankTier } from './config/settings';
import { QueueEntryRow, MatchRow, UserRow, MapRow } from './types';
import { rankForElo } from './elo/rankManager';
import { MatchRepository } from './database/repositories/matchRepository';

export function clampElo(n: number): number {
  return Math.max(0, Math.round(n));
}

export function userDisplay(user: { username: string; elo: number }): string {
  return `**${user.username}**`;
}

// ---------------------------------------------------------------------------
// Queue panel
// ---------------------------------------------------------------------------

export function queueEmbed(entries: QueueEntryRow[], settings: Settings, enabledMaps?: number): EmbedBuilder {
  const size = settings.queueSize;
  const embed = new EmbedBuilder()
    .setTitle('3V3 SCRIM MATCHMAKING')
    .setColor(0x58b9ff)
    .setDescription(`Players: ${entries.length}/${size}`);

  const lines: string[] = [];
  const slotCount = Math.max(size, entries.length);
  for (let i = 0; i < slotCount; i++) {
    const entry = entries[i];
    lines.push(
      entry
        ? `${i + 1}. ${entry.username} — ${entry.elo_at_join} Elo`
        : `${i + 1}. Waiting…`
    );
  }
  const body: string[] = ['', ...lines.map((l) => `\`${l}\``)];

  const extra: string[] = [];
  if (settings.minElo !== undefined || settings.maxElo !== undefined) {
    const min = settings.minElo ?? 'any';
    const max = settings.maxElo ?? 'any';
    extra.push(`Elo range: ${min} – ${max}`);
  }
  if (enabledMaps !== undefined) {
    extra.push(`Map pool: ${enabledMaps} enabled`);
  }
  if (extra.length) {
    body.push('', ...extra.map((l) => `\`${l}\``));
  }
  embed.setDescription(body.join('\n'));
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(join, leave, refresh);
  return [row];
}

// ---------------------------------------------------------------------------
// Match embeds
// ---------------------------------------------------------------------------

export interface MatchPlayerInfo {
  id: string;
  username: string;
  elo: number;
}

export interface MatchView {
  match: MatchRow;
  teamA: MatchPlayerInfo[];
  teamB: MatchPlayerInfo[];
  ready: string[];
  votesCount: number;
  voteTotals: Record<string, number>;
  rankFn: (elo: number) => RankTier;
  maps: MapRow[];
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
      return `STATUS: Confirmed — Winner: ${winnerLabel(match.winner)}`;
    case 'disputed':
      return 'STATUS: Disputed (awaiting staff)';
    case 'cancelled':
      return `STATUS: Cancelled — ${match.cancellation_reason ?? 'no reason'}`;
    case 'timed_out':
      return `STATUS: Timed out — ${match.cancellation_reason ?? 'no reason'}`;
    case 'archived':
      return 'STATUS: Archived';
    default:
      return 'STATUS: Unknown';
  }
}

export function winnerLabel(winner: MatchRow['winner']): string {
  return winner === 'A' ? 'TEAM A' : winner === 'B' ? 'TEAM B' : 'DRAW';
}

export function buildMatchEmbed(view: MatchView): EmbedBuilder {
  const { match, teamA, teamB } = view;
  const embed = new EmbedBuilder()
    .setTitle(`SCRIM MATCH #${match.match_id.replace('scrim-', '')}`)
    .setColor(matchColor(match))
    .setDescription(matchStatusLine(match));

  const teamLines = (players: MatchPlayerInfo[]) =>
    players
      .map((p) => {
        const rank = view.rankFn(p.elo).name;
        return `• ${p.username} — ${p.elo} Elo (${rank})`;
      })
      .join('\n');

  embed.addFields(
    { name: `TEAM A${match.winner === 'A' ? ' 🏆' : ''}`, value: teamLines(teamA), inline: true },
    { name: `TEAM B${match.winner === 'B' ? ' 🏆' : ''}`, value: teamLines(teamB), inline: true }
  );

  const details: string[] = [];
  if (match.map) details.push(`**MAP:** ${match.map}${match.game_mode ? ` (${match.game_mode})` : ''}`);
  details.push(`**FORMAT:** ${match.format === 'best_of_3' ? 'Best of 3' : 'Best of 1'}`);
  if (match.status === 'awaiting_ready' || match.status === 'in_progress') {
    if (match.format === 'best_of_3') {
      details.push(`**SERIES:** ${match.team_a_score}-${match.team_b_score} (first to 2 of 3)`);
    } else {
      details.push(`**SERIES:** ${match.team_a_score}-${match.team_b_score} (single game)`);
    }
  }
  if (match.status === 'confirmed' || match.status === 'disputed') {
    details.push(`**FINAL SCORE:** ${match.team_a_score} – ${match.team_b_score}`);
    if (match.winner) details.push(`**WINNER:** ${winnerLabel(match.winner)}`);
  }
  if (match.status === 'voting') {
    // Reveal only the number of ballots, never individual choices.
    details.push(`**VOTES:** ${view.votesCount}/6 cast (choices stay private until voting ends)`);
  }
  if (match.status === 'confirmed' || match.status === 'disputed') {
    const countLine = Object.entries(view.voteTotals)
      .filter(([, c]) => c > 0)
      .map(([k, c]) => `${k === 'A' ? 'Team A' : k === 'B' ? 'Team B' : 'Draw'}: ${c}`)
      .join('  •  ');
    if (countLine) details.push(countLine);
  }
  if (match.team_code) {
    details.push('**TEAMCODE:** submitted ✅');
  }

  embed.addFields({ name: 'Details', value: details.join('\n') || 'No details yet' });
  embed.setFooter({ text: match.match_id });
  return embed;
}

function matchColor(match: MatchRow): number {
  switch (match.status) {
    case 'confirmed':
      return 0x57f287;
    case 'cancelled':
    case 'timed_out':
      return 0xed4245;
    case 'disputed':
      return 0xfee75c;
    case 'voting':
      return 0xfee75c;
    default:
      return 0x5865f2;
  }
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
  // A cancelled/timed-out match offers a persistent fault-report entry point.
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

export function profileEmbed(user: UserRow, settings: Settings): EmbedBuilder {
  const rank = rankForElo(user.elo, settings.ranks);
  const winRate = user.total_matches > 0 ? ((user.wins / user.total_matches) * 100).toFixed(1) : '0.0';
  const streakLabel =
    user.current_streak === 0 ? '—' : `${user.current_streak} ${user.current_streak > 0 ? 'Win' : 'Loss'}${Math.abs(user.current_streak) === 1 ? '' : 'es'}`;

  const embed = new EmbedBuilder()
    .setTitle('PLAYER PROFILE')
    .setDescription(`Player: **${user.username}**`)
    .setColor(0x9b59b6)
    .addFields(
      { name: 'ELO', value: `${user.elo}`, inline: true },
      { name: 'Peak Elo', value: `${user.peak_elo}`, inline: true },
      { name: 'Rank', value: rank.name, inline: true },
      { name: 'Matches Played', value: `${user.total_matches}`, inline: true },
      { name: 'Wins', value: `${user.wins}`, inline: true },
      { name: 'Losses', value: `${user.losses}`, inline: true },
      { name: 'Draws', value: `${user.draws}`, inline: true },
      { name: 'Win Rate', value: `${winRate}%`, inline: true },
      { name: 'Current Streak', value: streakLabel, inline: true },
      { name: 'Best Streak', value: `${user.best_streak}`, inline: true },
      { name: 'Registered', value: user.created_at, inline: true }
    );
  if (user.last_match_at) {
    embed.addFields({ name: 'Last Match', value: user.last_match_at, inline: true });
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
    .setColor(0xf1c40f)
    .setDescription(`Sorted by current Elo • Page ${page + 1}/${pages}`);
  const lines = rows.map((r, i) => {
    const rankTier = rankForElo(r.elo, settings.ranks);
    return `#${startIndex + i + 1} **${r.username}** — ${r.elo} Elo (${rankTier.name}) · ${r.wins}W/${r.losses}L`;
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
    .setColor(0x2ecc71)
    .setDescription(`Last matches • Page ${page + 1}/${pages}`);

  const lines = rows.map(({ match, eloChange }) => {
    const teamA = repo.teamAIds(match);
    const onA = teamA.includes(userId);
    const outcome = match.winner === null ? '—' : match.winner === 'draw' ? 'DRAW' : onA === (match.winner === 'A') ? 'WIN' : (match.status === 'cancelled' || match.status === 'timed_out') ? statusShort(match.status) : 'LOSS';
    const elo = eloChange === null ? '' : `${eloChange >= 0 ? '+' : ''}${eloChange} Elo`;
    return `**#${match.match_id.replace('scrim-', '')}** ${match.created_at}  |  ${statusShort(match.status)}  |  ${onA ? 'TEAM A' : 'TEAM B'}  |  ${match.map ?? '?'}\n↳ ${outcome}${elo ? ' • ' + elo : ''}`;
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
    .setColor(0x3498db);
  const enabled = maps.filter((m) => m.enabled === 1);
  const disabled = maps.filter((m) => m.enabled === 0);
  embed.addFields(
    {
      name: `Enabled (${enabled.length})`,
      value: enabled.map((m) => `• ${m.name}${m.game_mode ? ` — ${m.game_mode}` : ''}`).join('\n') || 'None',
    },
    {
      name: `Disabled (${disabled.length})`,
      value: disabled.map((m) => `• ${m.name}`).join('\n') || 'None',
    }
  );
  if (recent.length) {
    embed.addFields({
      name: 'Recently used',
      value: recent.map((r) => `• ${r.name} (${r.selected_at})`).join('\n'),
    });
  }
  return embed;
}

export { rankForElo };