import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js';
import { AppContext } from '../context';
import {
  profileEmbed,
  leaderboardEmbed,
  historyEmbed,
  mapsEmbed,
  queueEmbed,
  queueActionRows,
} from '../format';

const PAGE_SIZE = 10;

export type CommandDefinition = ReturnType<SlashCommandBuilder['toJSON']>;
export function registerCommandDefinitions(): CommandDefinition[] {
  const defs = [
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Show a player’s profile and Elo.')
      .addUserOption((o) => o.setName('player').setDescription('Player to inspect (defaults to you).').setRequired(false)),

    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the current Elo leaderboard.'),

    new SlashCommandBuilder()
      .setName('history')
      .setDescription('Display a player’s previous matches.')
      .addUserOption((o) => o.setName('player').setDescription('Player whose history to view.').setRequired(false)),

    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Show the active matchmaking queue.'),

    new SlashCommandBuilder()
      .setName('maps')
      .setDescription('Display the available map pool.'),

    new SlashCommandBuilder()
      .setName('match')
      .setDescription('Show your current match.'),

    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Leave the matchmaking queue.'),
  ];
  return defs.map((b) => b.toJSON());
}

export class CommandHandler {
  constructor(private ctx: AppContext) {}

  async handle(command: string, interaction: ChatInputCommandInteraction): Promise<void> {
    switch (command) {
      case 'profile':
        return this.profile(interaction);
      case 'leaderboard':
        return this.leaderboard(interaction);
      case 'history':
        return this.history(interaction);
      case 'queue':
        return this.queueInfo(interaction);
      case 'maps':
        return this.maps(interaction);
      case 'match':
        return this.matchInfo(interaction);
      case 'leave':
        return this.leaveQueue(interaction);
      default:
        await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
    }
  }

  private async profile(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser('player') ?? interaction.user;
    const user = this.ctx.db.repos.users.ensureUser(target.id, target.username);
    await interaction.reply({
      embeds: [profileEmbed(user, this.ctx.settings, this.ctx.db.repos.mapStats.forPlayer(user.discord_id))],
    });
  }

  private async leaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
    const page = 0;
    const minMatches = this.ctx.settings.leaderboardMinMatches;
    const total = this.ctx.db.repos.users.countLeaderboard(minMatches);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rows = this.ctx.db.repos.users.leaderboard(PAGE_SIZE, page * PAGE_SIZE, minMatches);
    const embed = leaderboardEmbed(rows, 0, total, page, pages, this.ctx.settings);

    const prev = new ButtonBuilder()
      .setCustomId(`lb:prev:${page}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0);
    const next = new ButtonBuilder()
      .setCustomId(`lb:next:${page}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pages <= 1);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  private async history(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser('player') ?? interaction.user;
    const user = this.ctx.db.repos.users.ensureUser(target.id, target.username);
    const entries = this.ctx.db.repos.users.getEloHistory(user.discord_id, 50, 0);
    const historyRows: Array<{ match: NonNullable<ReturnType<AppContext['db']['repos']['matches']['get']>>; eloChange: number }> = [];
    for (const e of entries) {
      const match = this.ctx.db.repos.matches.get(e.match_id);
      if (match) historyRows.push({ match, eloChange: e.elo_change });
    }
    const pages = Math.max(1, Math.ceil(historyRows.length / PAGE_SIZE));
    const embed = historyEmbed(historyRows, user.discord_id, 0, pages, this.ctx.db.repos.matches);
    await interaction.reply({ embeds: [embed] });
  }

  private async queueInfo(interaction: ChatInputCommandInteraction): Promise<void> {
    const entries = this.ctx.queue.entries();
    await interaction.reply({ embeds: [queueEmbed(entries, this.ctx.settings)], components: queueActionRows() });
  }

  private async maps(interaction: ChatInputCommandInteraction): Promise<void> {
    const maps = this.ctx.db.repos.maps.list();
    const recent = this.ctx.db.repos.maps.selectionHistory(5);
    await interaction.reply({ embeds: [mapsEmbed(maps, recent)] });
  }

  private async matchInfo(interaction: ChatInputCommandInteraction): Promise<void> {
    const active = this.ctx.db.repos.matches.getActiveByPlayer(interaction.user.id);
    if (!active) {
      await interaction.reply({ content: 'You are not in an active match.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (active.channel_id) {
      await interaction.reply({ content: `🎮 Your current match: <#${active.channel_id}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: `🎮 You are in match **${active.match_id}**.`, flags: MessageFlags.Ephemeral });
  }

  private async leaveQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    const result = await this.ctx.queue.leave(interaction.user.id);
    await interaction.reply({ content: result.ok ? '🚪 You left the queue.' : result.error ?? 'Could not leave.', flags: MessageFlags.Ephemeral });
    await this.ctx.queue.refreshPanel().catch(() => {});
  }
}

export function isStaff(interaction: ChatInputCommandInteraction, staffRoleId: string | undefined): boolean {
  if (!staffRoleId) {
    return interaction.memberPermissions?.has('Administrator') ?? false;
  }
  const member = interaction.member;
  if (!member) return false;
  const roles = (member as { roles?: { cache?: { has?: (id: string) => boolean } } }).roles?.cache;
  return roles?.has?.(staffRoleId) ?? false;
}