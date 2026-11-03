import { Message, MessageFlags, TextChannel, ThreadChannel } from 'discord.js';
import { AppContext } from '../context';
import { queueEmbed, queueActionRows, leaderboardEmbed, profileEmbed, historyEmbed, mapsEmbed, helpText } from '../format';

const PREFIX = '!';
const PAGE_SIZE = 10;

/** Resolves a Discord user ID from a raw command argument (mention, ID or bare name). */
function resolveUserId(raw: string, message: Message): string | null {
  const mention = message.mentions.users.first();
  if (mention) return mention.id;
  const trimmed = raw.replace(/<@!?(\d+)>/, '$1').trim();
  if (/^\d{15,20}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * `!`-prefixed chat commands. This is the non-panel path to the queue and the
 * player-facing read commands, so the matchmaking panel is never the only way
 * to queue up.
 */
export class PrefixHandler {
  constructor(private ctx: AppContext) {}

  async handle(message: Message): Promise<void> {
    if (message.author.bot) return;
    const channel = message.channel;
    if (!(channel instanceof TextChannel) && !(channel instanceof ThreadChannel)) return;
    const content = message.content.trim();
    if (!content.startsWith(PREFIX)) return;

    const [rawCmd, ...rest] = content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(' ');

    const channelArg = channel;
    try {
      switch (cmd) {
        case 'join':
          await this.join(message);
          return;
        case 'leave':
          await this.leave(message);
          return;
        case 'queue':
          await this.queueInfo(channelArg);
          return;
        case 'profile':
          await this.profile(channelArg, message, arg);
          return;
        case 'leaderboard':
          await this.leaderboard(channelArg);
          return;
        case 'history':
          await this.history(channelArg, message, arg);
          return;
        case 'maps':
          await this.maps(channelArg);
          return;
        case 'match':
          await this.matchInfo(message);
          return;
        case 'help':
          await this.help(channelArg);
          return;
        default:
          await message.reply(`Unknown command \`!${cmd}\`. Try \`!help\` for the full list.`);
      }
    } catch (error) {
      console.error(`Prefix command !${cmd} failed:`, error);
      await message.reply('Something went wrong while running that command. Please try again.').catch(() => {});
    }
  }

  private async join(message: Message): Promise<void> {
    const result = await this.ctx.queue.join(message.author.id, message.author.username);
    if (result.ok) {
      await message.reply(`You joined the queue. **${result.size}/${this.ctx.settings.queueSize}** players — a match starts automatically once full.`);
    } else {
      await message.reply(result.error ?? 'Could not join the queue.');
    }
  }

  private async leave(message: Message): Promise<void> {
    const result = await this.ctx.queue.leave(message.author.id);
    await message.reply(result.ok ? 'You left the queue.' : result.error ?? 'Could not leave the queue.');
  }

  private async queueInfo(channel: TextChannel | ThreadChannel): Promise<void> {
    const entries = this.ctx.queue.entries();
    await channel.send({
      embeds: [queueEmbed(entries, this.ctx.settings)],
      components: queueActionRows(),
      flags: MessageFlags.SuppressNotifications,
    });
  }

  private async profile(channel: TextChannel | ThreadChannel, message: Message, arg: string): Promise<void> {
    const id = arg.trim() ? resolveUserId(arg, message) : null;
    const target = id ? (message.mentions.users.first() ?? message.author) : message.author;
    const user = this.ctx.db.repos.users.ensureUser(target.id, target.username);
    await channel.send({
      embeds: [profileEmbed(user, this.ctx.settings, this.ctx.db.repos.mapStats.forPlayer(user.discord_id))],
      flags: MessageFlags.SuppressNotifications,
    });
  }

  private async leaderboard(channel: TextChannel | ThreadChannel): Promise<void> {
    const minMatches = this.ctx.settings.leaderboardMinMatches;
    const total = this.ctx.db.repos.users.countLeaderboard(minMatches);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = this.ctx.db.repos.users.leaderboard(PAGE_SIZE, 0, minMatches);
    await channel.send({
      embeds: [leaderboardEmbed(rows, 0, total, 0, pages, this.ctx.settings)],
      flags: MessageFlags.SuppressNotifications,
    });
  }

  private async history(channel: TextChannel | ThreadChannel, message: Message, arg: string): Promise<void> {
    const id = arg.trim() ? resolveUserId(arg, message) : null;
    const target = id ? (message.mentions.users.first() ?? message.author) : message.author;
    const user = this.ctx.db.repos.users.ensureUser(target.id, target.username);
    const rows: Array<{ match: NonNullable<ReturnType<AppContext['db']['repos']['matches']['get']>>; eloChange: number }> = [];
    for (const e of this.ctx.db.repos.users.getEloHistory(user.discord_id, 50, 0)) {
      const match = this.ctx.db.repos.matches.get(e.match_id);
      if (match) rows.push({ match, eloChange: e.elo_change });
    }
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    await channel.send({
      embeds: [historyEmbed(rows, user.discord_id, 0, pages, this.ctx.db.repos.matches)],
      flags: MessageFlags.SuppressNotifications,
    });
  }

  private async maps(channel: TextChannel | ThreadChannel): Promise<void> {
    const maps = this.ctx.db.repos.maps.list();
    const recent = this.ctx.db.repos.maps.selectionHistory(5);
    await channel.send({
      embeds: [mapsEmbed(maps, recent)],
      flags: MessageFlags.SuppressNotifications,
    });
  }

  private async matchInfo(message: Message): Promise<void> {
    const active = this.ctx.db.repos.matches.getActiveByPlayer(message.author.id);
    if (!active) {
      await message.reply('You are not in an active match.');
      return;
    }
    await message.reply(active.channel_id ? `Your current match: <#${active.channel_id}>` : `You are in match **${active.match_id}**.`);
  }

  private async help(channel: TextChannel | ThreadChannel): Promise<void> {
    await channel.send({ content: helpText(), flags: MessageFlags.SuppressNotifications });
  }
}