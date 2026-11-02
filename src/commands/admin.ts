import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';
import { AppContext } from '../context';
import { rankForElo } from '../elo/rankManager';
import { queueEmbed, queueActionRows, mapsEmbed } from '../format';
import { isStaff } from './commands';

export type AnyCommandBuilder = SlashCommandBuilder | ReturnType<SlashCommandBuilder['addSubcommandGroup']> | ReturnType<SlashCommandBuilder['addSubcommand']>;

export function registerAdminCommandDefinitions(): ReturnType<SlashCommandBuilder['toJSON']>[] {
  const scrim = new SlashCommandBuilder().setName('scrim').setDescription('Administrator scrim controls.');

  scrim.addSubcommand((s) =>
    s.setName('setup').setDescription('Create or refresh the matchmaking panel in this channel.')
  );
  scrim.addSubcommand((s) =>
    s
      .setName('cancel')
      .setDescription('Cancel an active match.')
      .addStringOption((o) => o.setName('match_id').setDescription('scrim-XXXX').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Cancellation reason.').setRequired(false))
  );
  scrim.addSubcommand((s) =>
    s
      .setName('result')
      .setDescription('Manually confirm/correct a match result (applies Elo once).')
      .addStringOption((o) => o.setName('match_id').setDescription('scrim-XXXX').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('winner')
          .setDescription('Winning team')
          .setRequired(true)
          .addChoices(
            { name: 'Team A', value: 'A' },
            { name: 'Team B', value: 'B' },
            { name: 'Draw', value: 'draw' }
          )
      )
      .addIntegerOption((o) => o.setName('score_a').setDescription('Team A series score.').setRequired(false))
      .addIntegerOption((o) => o.setName('score_b').setDescription('Team B series score.').setRequired(false))
  );
  scrim.addSubcommand((s) =>
    s
      .setName('elo')
      .setDescription('Adjust a player’s Elo directly (logged).')
      .addUserOption((o) => o.setName('player').setDescription('Player to adjust.').setRequired(true))
      .addIntegerOption((o) => o.setName('amount').setDescription('Elo delta (e.g. +25 or -20).').setRequired(true))
  );
  scrim.addSubcommandGroup((g) =>
    g
      .setName('map')
      .setDescription('Manage the map pool.')
      .addSubcommand((m) => m.setName('add').setDescription('Add a map.').addStringOption((o) => o.setName('name').setDescription('Map name').setRequired(true)))
      .addSubcommand((m) => m.setName('remove').setDescription('Remove a map.').addStringOption((o) => o.setName('name').setDescription('Map name').setRequired(true)))
      .addSubcommand((m) => m.setName('toggle').setDescription('Enable/disable a map.').addStringOption((o) => o.setName('name').setDescription('Map name').setRequired(true)))
      .addSubcommand((m) =>
        m
          .setName('gamemode')
          .setDescription('Set the game mode for a map.')
          .addStringOption((o) => o.setName('name').setDescription('Map name').setRequired(true))
          .addStringOption((o) => o.setName('mode').setDescription('Game mode (e.g. Gem Grab).').setRequired(false))
      )
  );
  scrim.addSubcommand((s) =>
    s
      .setName('cooldown')
      .setDescription('Apply a matchmaking cooldown to a player.')
      .addUserOption((o) => o.setName('player').setDescription('Player.').setRequired(true))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Cooldown duration in minutes.').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason.').setRequired(false))
  );
  scrim.addSubcommand((s) =>
    s.setName('stats').setDescription('Show server-wide scrim statistics.')
  );
  scrim.addSubcommand((s) =>
    s
      .setName('resetcode')
      .setDescription('Reset the TeamCode of a match so a new one can be submitted.')
      .addStringOption((o) => o.setName('match_id').setDescription('scrim-XXXX').setRequired(true))
  );
  scrim.addSubcommand((s) =>
    s
      .setName('dodge')
      .setDescription('Moderator decision on a dodge report.')
      .addStringOption((o) => o.setName('match_id').setDescription('scrim-XXXX').setRequired(true))
      .addUserOption((o) => o.setName('player').setDescription('Reported player.').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('decision')
          .setDescription('Decision')
          .setRequired(true)
          .addChoices(
            { name: 'Apply cooldown', value: 'cooldown' },
            { name: 'Clear (no action)', value: 'clear' }
          )
      )
      .addIntegerOption((o) => o.setName('minutes').setDescription('Cooldown minutes if applying one.').setRequired(false))
  );
  scrim.addSubcommand((s) =>
    s
      .setName('audit')
      .setDescription('Show the recent audit log.')
      .addIntegerOption((o) => o.setName('limit').setDescription('Number of entries.').setRequired(false))
  );

  return [scrim.toJSON()];
}

const STAFF_ONLY = "You don't have permission to use this command (staff role or Administrator required).";

export class AdminCommandHandler {
  constructor(private ctx: AppContext) {}

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isStaff(interaction, this.ctx.settings.staffRoleId)) {
      await interaction.reply({ content: STAFF_ONLY, ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand(true);
    switch (sub) {
      case 'setup':
        return this.setup(interaction);
      case 'cancel':
        return this.cancel(interaction);
      case 'result':
        return this.result(interaction);
      case 'elo':
        return this.eloAdjust(interaction);
      case 'add':
      case 'remove':
      case 'toggle':
      case 'gamemode':
        return this.mapManage(interaction);
      case 'cooldown':
        return this.cooldown(interaction);
      case 'stats':
        return this.stats(interaction);
      case 'resetcode':
        return this.resetCode(interaction);
      case 'dodge':
        return this.dodge(interaction);
      case 'audit':
        return this.audit(interaction);
      default:
        await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    }
  }

  private async setup(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !(channel instanceof TextChannel)) {
      await interaction.reply({ content: 'This command must be run in a text channel.', ephemeral: true });
      return;
    }
    const message = await channel.send({
      embeds: [queueEmbed(this.ctx.queue.entries(), this.ctx.settings)],
      components: queueActionRows(),
    });
    this.ctx.db.repos.panels.set(channel.id, message.id);
    await interaction.reply({ content: 'Matchmaking panel created.', ephemeral: true });
    this.ctx.db.repos.audits.log({
      action: 'panel_created',
      administrator_id: interaction.user.id,
      details: JSON.stringify({ channel_id: channel.id, message_id: message.id }),
    });
  }

  private async cancel(interaction: ChatInputCommandInteraction): Promise<void> {
    const matchId = interaction.options.getString('match_id', true);
    const reason = interaction.options.getString('reason') ?? 'Cancelled by an administrator';
    const ok = await this.ctx.matches.cancelMatch(matchId, reason, 'cancelled', interaction.user.id);
    await interaction.reply({ content: ok ? `Match ${matchId} cancelled.` : `Could not cancel ${matchId} (not found or already ended).`, ephemeral: true });
  }

  private async result(interaction: ChatInputCommandInteraction): Promise<void> {
    const matchId = interaction.options.getString('match_id', true);
    const winnerRaw = interaction.options.getString('winner', true);
    const winner = winnerRaw === 'A' || winnerRaw === 'B' ? (winnerRaw as 'A' | 'B') : 'draw';
    const scoreA = interaction.options.getInteger('score_a') ?? undefined;
    const scoreB = interaction.options.getInteger('score_b') ?? undefined;
    const result = await this.ctx.matches.adminResolve(matchId, winner, interaction.user.id, scoreA, scoreB);
    await interaction.reply({ content: result.ok ? `Match ${matchId} resolved with winner ${winner.toUpperCase()}.` : result.error, ephemeral: true });
  }

  private async eloAdjust(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser('player', true);
    const amount = interaction.options.getInteger('amount', true);
    const user = this.ctx.db.repos.users.ensureUser(target.id, target.username);
    const now = new Date().toISOString();
    this.ctx.db.repos.users.applyEloChange(user.discord_id, 'admin-adjust', user.elo, amount, amount >= 0 ? 'win' : 'loss', now);
    const updated = this.ctx.db.repos.users.getById(user.discord_id)!;
    await interaction.reply({
      content: `Adjusted ${target.username}: ${amount >= 0 ? '+' : ''}${amount} Elo. New Elo: ${updated.elo} (peak ${updated.peak_elo}).`,
      ephemeral: true,
    });
    this.ctx.db.repos.audits.log({
      action: 'admim_elo_adjust',
      administrator_id: interaction.user.id,
      target_id: user.discord_id,
      details: JSON.stringify({ amount, previous: user.elo, newElo: updated.elo }),
    });
  }

  private async mapManage(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = interaction.options.getSubcommand(true);
    if (action === 'add') {
      const name = interaction.options.getString('name', true);
      const row = this.ctx.db.repos.maps.add(name);
      await interaction.reply({ content: `Map added: **${row.name}**.`, ephemeral: true });
    } else if (action === 'remove') {
      const name = interaction.options.getString('name', true);
      const ok = this.ctx.db.repos.maps.remove(name);
      await interaction.reply({ content: ok ? `Map removed: **${name}**.` : `Map **${name}** not found.`, ephemeral: true });
    } else if (action === 'toggle') {
      const name = interaction.options.getString('name', true);
      const row = this.ctx.db.repos.maps.toggle(name);
      await interaction.reply({
        content: row ? `Map **${row.name}** is now ${row.enabled === 1 ? 'enabled' : 'disabled'}.` : `Map **${name}** not found.`,
        ephemeral: true,
      });
    } else if (action === 'gamemode') {
      const name = interaction.options.getString('name', true);
      const mode = interaction.options.getString('mode') ?? null;
      const ok = this.ctx.db.repos.maps.setGameMode(name, mode);
      await interaction.reply({
        content: ok ? `Game mode for **${name}** set to ${mode ?? '(not configured)'}.` : `Map **${name}** not found.`,
        ephemeral: true,
      });
    }
    this.ctx.db.repos.audits.log({
      action: `map_${action}`,
      administrator_id: interaction.user.id,
      details: JSON.stringify({ action, option: interaction.options.getString('name') ?? null }),
    });
  }

  private async cooldown(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getUser('player', true);
    const minutes = interaction.options.getInteger('minutes', true);
    const reason = interaction.options.getString('reason') ?? 'Set by an administrator';
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    this.ctx.db.repos.cooldowns.set(target.id, until, reason, interaction.user.id);
    await interaction.reply({ content: `${target.username} is on a matchmaking cooldown for ${minutes} minutes.`, ephemeral: true });
    this.ctx.db.repos.audits.log({
      action: 'cooldown_applied',
      administrator_id: interaction.user.id,
      target_id: target.id,
      details: JSON.stringify({ minutes, reason }),
    });
  }

  private async stats(interaction: ChatInputCommandInteraction): Promise<void> {
    const users = this.ctx.db.repos.users.listAll();
    const total = users.length;
    const totalElo = users.reduce((a, u) => a + u.elo, 0);
    const avgElo = total > 0 ? Math.round(totalElo / total) : 0;
    const activeMatches = this.ctx.db.repos.matches.activeCount();
    const queueSize = this.ctx.db.repos.queue.count();
    const inQueue = this.ctx.db.repos.queue.count();

    const embed = new EmbedBuilder()
      .setTitle('SCRIM STATISTICS')
      .setColor(0x2ecc71)
      .addFields(
        { name: 'Registered players', value: `${total}`, inline: true },
        { name: 'Average Elo', value: `${avgElo}`, inline: true },
        { name: 'Active matches', value: `${activeMatches}`, inline: true },
        { name: 'In queue', value: `${queueSize}`, inline: true },
        { name: 'Queue target', value: `${this.ctx.settings.queueSize}`, inline: true }
      );
    const top3 = users
      .slice()
      .sort((a, b) => b.elo - a.elo)
      .slice(0, 3)
      .map((u, i) => `#${i + 1} ${u.username} — ${u.elo} Elo`)
      .join('\n');
    if (top3) embed.addFields({ name: 'Top 3', value: top3 });
    void inQueue;
    await interaction.reply({ embeds: [embed] });
  }

  private async resetCode(interaction: ChatInputCommandInteraction): Promise<void> {
    const matchId = interaction.options.getString('match_id', true);
    const ok = await this.ctx.matches.staffResetTeamCode(matchId, interaction.user.id);
    await interaction.reply({ content: ok ? `TeamCode for ${matchId} has been reset.` : `Match ${matchId} not found.`, ephemeral: true });
  }

  private async dodge(interaction: ChatInputCommandInteraction): Promise<void> {
    const matchId = interaction.options.getString('match_id', true);
    const target = interaction.options.getUser('player', true);
    const decision = interaction.options.getString('decision', true) as 'cooldown' | 'clear';
    const minutes = interaction.options.getInteger('minutes') ?? 60;
    await this.ctx.matches.moderateDodge(matchId, target.id, decision, minutes, interaction.user.id);
    await interaction.reply({
      content: decision === 'cooldown'
        ? `Dodge confirmed for ${target.username}: ${minutes}-minute matchmaking cooldown applied.`
        : `Dodge report for ${target.username} cleared (no action).`,
      ephemeral: true,
    });
  }

  private async audit(interaction: ChatInputCommandInteraction): Promise<void> {
    const limit = Math.min(interaction.options.getInteger('limit') ?? 10, 25);
    const entries = this.ctx.db.repos.audits.recent(limit, 0);
    const lines = entries.map((e) => `**${e.created_at}** \`${e.action}\` by ${e.administrator_id ? `<@${e.administrator_id}>` : 'system'}${e.match_id ? ` (${e.match_id})` : ''}`);
    const embed = new EmbedBuilder()
      .setTitle('AUDIT LOG')
      .setColor(0x9b59b6)
      .setDescription(lines.join('\n') || 'No entries.');
    await interaction.reply({ embeds: [embed] });
  }
}