import { EmbedBuilder, TextChannel, Message } from 'discord.js';
import { AppContext } from '../context';
import { EMBED_COLORS, shortTimestamp } from '../presentation/embeds';

/**
 * Maintains one public "Match Logs" message per match in a dedicated logs
 * channel. Each match gets a single embed that tracks its lifecycle:
 * created -> awaiting_teamcode -> awaiting_ready -> in_progress -> voting ->
 * confirmed/disputed/cancelled/timed_out.
 *
 * The per-match message id is stored on the matches table
 * (`log_message_id`/`log_channel_id`) so logs survive bot restarts and never
 * duplicate. If no logs channel is configured, this service is a no-op.
 */
export class MatchLogs {
  constructor(private ctx: AppContext) {}

  /** The configured logs channel, if any. */
  private channel(): TextChannel | null {
    const id = this.ctx.settings.logsChannelId;
    if (!id) return null;
    const ch = this.ctx.client.channels.cache.get(id);
    return ch instanceof TextChannel ? ch : null;
  }

  /**
   * Posts (or updates) the public log message for a match. Called on creation
   * and whenever the match embed is refreshed.
   */
  async refresh(matchId: string): Promise<void> {
    const channel = this.channel();
    if (!channel) return;
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return;

    const embed = this.buildLogEmbed(matchId);
    if (!embed) return;

    if (!match.log_message_id) {
      const message = await channel.send({ embeds: [embed] });
      this.ctx.db.repos.matches.setLogMessage(matchId, message.id, channel.id);
    } else {
      const existing = await channel.messages.fetch(match.log_message_id).catch(() => null);
      if (existing && existing.editable) {
        await existing.edit({ embeds: [embed] });
      } else if (match.log_channel_id === channel.id) {
        // Message was deleted; repost and refresh the pointer.
        const message = await channel.send({ embeds: [embed] });
        this.ctx.db.repos.matches.setLogMessage(matchId, message.id, channel.id);
      }
    }
  }

  /** Deletes the public log message for a finished match (optional cleanup). */
  async remove(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.log_message_id) return;
    const channel = this.channel();
    if (!channel) return;
    const message = await channel.messages
      .fetch(match.log_message_id)
      .catch(() => null as Message | null);
    if (message?.deletable) await message.delete().catch(() => {});
    this.ctx.db.repos.matches.clearLogMessage(matchId);
  }

  private buildLogEmbed(matchId: string): EmbedBuilder | null {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return null;
    const teamA = this.ctx.db.repos.matches.teamAIds(match);
    const teamB = this.ctx.db.repos.matches.teamBIds(match);

    const colorFor = (status: string): number => {
      switch (status) {
        case 'confirmed':
          return EMBED_COLORS.success;
        case 'cancelled':
        case 'timed_out':
          return EMBED_COLORS.error;
        case 'disputed':
          return EMBED_COLORS.pending;
        case 'voting':
          return EMBED_COLORS.pending;
        default:
          return EMBED_COLORS.info;
      }
    };

    const names = (ids: string[]) =>
      ids
        .map((id) => this.ctx.db.repos.users.getById(id)?.username ?? 'Unknown')
        .join(', ');

    const embed = new EmbedBuilder()
      .setTitle(`SCRIM #${matchId.replace('scrim-', '')}`)
      .setColor(colorFor(match.status))
      .setDescription(matchStatusPublic(match))
      .addFields(
        { name: 'TEAM A', value: names(teamA) || '...', inline: true },
        { name: 'TEAM B', value: names(teamB) || '...', inline: true }
      )
      .addFields({
        name: 'MATCH',
        value: `${match.map ?? 'No map'}${match.game_mode ? ` (${match.game_mode})` : ''} | ${match.format === 'best_of_3' ? 'Best of 3' : 'Best of 1'}${
          match.matchmaking === 'draft' ? ' | Captain Draft' : ''
        }`,
      });
    if (match.status === 'confirmed') {
      embed.addFields({ name: 'RESULT', value: `${match.team_a_score} - ${match.team_b_score} (${match.winner === 'A' ? 'Team A' : match.winner === 'B' ? 'Team B' : 'Draw'})` });
    }
    if (match.created_at) {
      embed.setFooter({ text: `Created ${shortTimestamp(match.created_at)}` });
    }

    return embed;
  }
}

function matchStatusPublic(match: { status: string; cancellation_reason?: string | null }): string {
  switch (match.status) {
    case 'awaiting_teamcode':
      return 'Waiting for TeamCode';
    case 'awaiting_ready':
      return 'Waiting for players to ready';
    case 'in_progress':
      return 'Match in progress';
    case 'voting':
      return 'Result voting in progress';
    case 'confirmed':
      return 'Result confirmed';
    case 'disputed':
      return 'Disputed (awaiting staff)';
    case 'cancelled':
      return `Cancelled${match.cancellation_reason ? `: ${match.cancellation_reason}` : ''}`;
    case 'timed_out':
      return `Timed out${match.cancellation_reason ? `: ${match.cancellation_reason}` : ''}`;
    case 'drafting':
      return 'Captain draft in progress';
    case 'archived':
      return 'Archived';
    default:
      return match.status;
  }
}