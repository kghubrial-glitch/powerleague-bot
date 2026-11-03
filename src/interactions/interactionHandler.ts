import {
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  SelectMenuComponentOptionData,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { AppContext } from '../context';
import { MatchRow } from '../types';
import { leaderboardEmbed, profileEmbed } from '../format';

const CUSTOM_ID_SEPARATOR = ':';
const MAX_CODE_LENGTH = 12;

export class InteractionHandler {
  constructor(private ctx: AppContext) {}

  // -------------------------------------------------------------------------
  // Button entry
  // -------------------------------------------------------------------------

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;
    try {
      if (customId === 'queue:join') {
        await this.handleJoin(interaction);
        return;
      }
      if (customId === 'queue:leave') {
        await this.handleLeave(interaction);
        return;
      }
      if (customId === 'queue:refresh') {
        await interaction.deferUpdate();
        await this.ctx.queue.refreshPanel();
        return;
      }
      if (customId === 'queue:profile') {
        await this.handleQueueProfile(interaction);
        return;
      }
      if (customId === 'queue:leaderboard') {
        await this.handleQueueLeaderboard(interaction);
        return;
      }
      if (customId.startsWith('vote:')) {
        await this.handleVote(interaction, customId);
        return;
      }
      if (customId.startsWith('match:teamcode') || customId === 'match:teamcode') {
        await this.openTeamCodeModal(interaction);
        return;
      }
      if (customId.startsWith('match:ready')) {
        await this.handleReady(interaction);
        return;
      }
      if (customId.startsWith('match:finished')) {
        await this.handleFinished(interaction);
        return;
      }
      if (customId.startsWith('match:cancel')) {
        await this.handleCancelRequest(interaction);
        return;
      }
      if (customId.startsWith('match:copycode')) {
        await this.handleCopyCode(interaction);
        return;
      }
      if (customId === 'fault:select') {
        await this.openFaultCategoryMenu(interaction);
        return;
      }
      if (customId.startsWith('fault:player:')) {
        await this.handleFaultPlayer(interaction, customId);
        return;
      }
      if (customId.startsWith('lb:prev') || customId.startsWith('lb:next')) {
        await this.handleLeaderboardPage(interaction, customId.startsWith('lb:next') ? 1 : -1);
        return;
      }
      // Cancellation confirm modal handled in handleModal.
      await interaction.reply({ content: 'Unknown interaction.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      await this.safeError(interaction, error);
    }
  }

  // -------------------------------------------------------------------------
  // Queue buttons
  // -------------------------------------------------------------------------

  private async handleJoin(interaction: ButtonInteraction): Promise<void> {
    const result = await this.ctx.queue.join(interaction.user.id, interaction.user.username);
    await interaction.reply({
      content: result.ok
        ? `You joined the queue. Current size: ${this.ctx.db.repos.queue.count()}. When all six players are in, a match is created automatically.`
        : result.error ?? 'Could not join the queue.',
      flags: MessageFlags.Ephemeral,
    });
    await this.ctx.queue.refreshPanel().catch(() => {});
  }

  private async handleLeave(interaction: ButtonInteraction): Promise<void> {
    const result = await this.ctx.queue.leave(interaction.user.id);
    await interaction.reply({
      content: result.ok ? 'You left the queue.' : result.error ?? 'Could not leave the queue.',
      flags: MessageFlags.Ephemeral,
    });
    await this.ctx.queue.refreshPanel().catch(() => {});
  }

  private async handleQueueProfile(interaction: ButtonInteraction): Promise<void> {
    const user = this.ctx.db.repos.users.ensureUser(interaction.user.id, interaction.user.username);
    await interaction.reply({ embeds: [profileEmbed(user, this.ctx.settings)], flags: MessageFlags.Ephemeral });
  }

  private async handleQueueLeaderboard(interaction: ButtonInteraction): Promise<void> {
    const minMatches = this.ctx.settings.leaderboardMinMatches;
    const rows = this.ctx.db.repos.users.leaderboard(10, 0, minMatches);
    const total = this.ctx.db.repos.users.countLeaderboard(minMatches);
    await interaction.reply({
      embeds: [leaderboardEmbed(rows, 0, total, 0, 1, this.ctx.settings)],
      flags: MessageFlags.Ephemeral,
    });
  }

  // -------------------------------------------------------------------------
  // Voting buttons
  // -------------------------------------------------------------------------

  private async handleVote(interaction: ButtonInteraction, customId: string): Promise<void> {
    // Format: vote:<choice>[:<matchId>]
    const parts = customId.split(CUSTOM_ID_SEPARATOR);
    const choice = parts[1] as 'A' | 'B' | 'draw';
    const matchId = parts[2] ?? this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!matchId) {
      await interaction.reply({ content: 'Could not determine the match for this vote.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (choice !== 'A' && choice !== 'B' && choice !== 'draw') {
      await interaction.reply({ content: 'Invalid vote choice.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate().catch(() => {});
    const result = await this.ctx.matches.castVote(matchId, interaction.user.id, choice);
    if (!result.ok) {
      await interaction.followUp({ content: result.error, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.followUp({ content: 'Your vote has been recorded (private until voting ends).', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // TeamCode
  // -------------------------------------------------------------------------

  private async openTeamCodeModal(interaction: ButtonInteraction): Promise<void> {
    const match = this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!match) {
      await interaction.reply({ content: 'Could not determine the match.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.status !== 'awaiting_teamcode') {
      await interaction.reply({ content: 'The TeamCode window for this match is closed.', flags: MessageFlags.Ephemeral });
      return;
    }
    const input = new TextInputBuilder()
      .setCustomId('teamcode_input')
      .setLabel('Brawl Stars in-game TeamCode')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(MAX_CODE_LENGTH);
    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    const modal = new ModalBuilder()
      .setCustomId(`modal:teamcode:${match.match_id}`)
      .setTitle('Submit TeamCode')
      .addComponents(row);
    await interaction.showModal(modal);
  }

  private async handleReady(interaction: ButtonInteraction): Promise<void> {
    const match = this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!match) {
      await interaction.reply({ content: 'Could not determine the match.', flags: MessageFlags.Ephemeral });
      return;
    }
    const result = await this.ctx.matches.pressReady(match.match_id, interaction.user.id);
    await interaction.reply({ content: result.ok ? 'You marked yourself ready ✅' : result.error ?? 'Could not set ready.', flags: MessageFlags.Ephemeral });
    await this.ctx.matches.refreshMatchMessage(match.match_id).catch(() => {});
  }

  private async handleFinished(interaction: ButtonInteraction): Promise<void> {
    const match = this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!match) {
      await interaction.reply({ content: 'Could not determine the match.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate().catch(() => {});
    await this.ctx.matches.startVoting(match.match_id, interaction.user.id);
  }

  private async handleCancelRequest(interaction: ButtonInteraction): Promise<void> {
    const match = this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!match) {
      await interaction.reply({ content: 'Could not determine the match.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.status !== 'awaiting_teamcode' && match.status !== 'awaiting_ready' && match.status !== 'in_progress') {
      await interaction.reply({ content: 'This match cannot be cancelled anymore.', flags: MessageFlags.Ephemeral });
      return;
    }
    const text = new TextInputBuilder()
      .setCustomId('cancel_reason')
      .setLabel('Reason for cancellation / issue')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(200);
    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(text);
    const modal = new ModalBuilder()
      .setCustomId(`modal:cancel:${match.match_id}`)
      .setTitle('Cancel / report issue')
      .addComponents(row);
    await interaction.showModal(modal);
  }

  private async handleCopyCode(interaction: ButtonInteraction): Promise<void> {
    const match = this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!match?.team_code) {
      await interaction.reply({ content: 'No TeamCode is available for this match.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: `TeamCode: \`${match.team_code}\``, flags: MessageFlags.Ephemeral });
  }

  // -------------------------------------------------------------------------
  // Leaderboard pagination
  // -------------------------------------------------------------------------

  private async handleLeaderboardPage(interaction: ButtonInteraction, delta: number): Promise<void> {
    const parts = interaction.customId.split(CUSTOM_ID_SEPARATOR);
    const current = parts.length > 2 ? Number(parts[2]) : 0;
    const nextPage = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);
    const minMatches = this.ctx.settings.leaderboardMinMatches;
    const total = this.ctx.db.repos.users.countLeaderboard(minMatches);
    const pageSize = 10;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (nextPage >= pages) {
      await interaction.reply({ content: 'You are on the last page.', flags: MessageFlags.Ephemeral });
      return;
    }
    const rows = this.ctx.db.repos.users.leaderboard(pageSize, nextPage * pageSize, minMatches);
    const embed = leaderboardEmbed(rows, nextPage * pageSize, total, nextPage, pages, this.ctx.settings);

    const prev = new ButtonBuilder()
      .setCustomId(`lb:prev:${nextPage}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextPage === 0);
    const next = new ButtonBuilder()
      .setCustomId(`lb:next:${nextPage}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pages <= 1);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);

    await interaction.update({ embeds: [embed], components: [row] });
  }

  private async openFaultCategoryMenu(interaction: ButtonInteraction): Promise<void> {
    const match = this.currentMatchFor(interaction.user.id, interaction.channelId);
    if (!match) {
      await interaction.reply({ content: 'Could not determine the match.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (match.status !== 'cancelled' && match.status !== 'timed_out') {
      await interaction.reply({ content: 'Fault reporting is only available for cancelled/timed-out matches.', flags: MessageFlags.Ephemeral });
      return;
    }
    const reasons = this.ctx.matches.faultReasons();
    const last = this.ctx.db.repos.faults.forMatch(match.match_id).filter((r) => r.reporter_id === interaction.user.id);
    if (last.some((r) => r.reported_player_id)) {
      await interaction.reply({ content: 'You have already submitted a player report for this match.', flags: MessageFlags.Ephemeral });
      return;
    }

    const options: SelectMenuComponentOptionData[] = reasons.map((r) => ({
      label: r.label,
      value: r.id,
      description: r.playerRelated ? 'Reports a specific player' : 'General report',
    }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`faultreason:${match.match_id}`)
      .setPlaceholder('What happened to the match?')
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.reply({ content: 'What happened to the match?', components: [row], flags: MessageFlags.Ephemeral });
  }

  // -------------------------------------------------------------------------
  // Select menu entry
  // -------------------------------------------------------------------------

  async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;
    try {
      if (customId.startsWith('draft:pick:')) {
        const matchId = customId.split(CUSTOM_ID_SEPARATOR)[2];
        const pickedId = interaction.values[0];
        await interaction.deferUpdate().catch(() => {});
        const result = await this.ctx.matches.handleDraftPick(interaction, matchId, pickedId);
        if (!result.ok) {
          await interaction.followUp({ content: result.error ?? 'Could not process the pick.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
      if (customId.startsWith('faultreason:')) {
        const matchId = customId.split(CUSTOM_ID_SEPARATOR)[1];
        const reasonId = interaction.values[0];
        await this.respondToFaultReason(interaction, matchId, reasonId);
        return;
      }
      if (customId.startsWith('faulttarget:')) {
        const parts = customId.split(CUSTOM_ID_SEPARATOR);
        const matchId = parts[1];
        const reportedId = interaction.values[0];
        const reason = parts[2] ?? 'other';
        await this.recordFaultSubmission(interaction, matchId, reportedId, reason);
        return;
      }
      await interaction.reply({ content: 'Unknown menu.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      await this.safeError(interaction, error);
    }
  }

  private async respondToFaultReason(
    interaction: StringSelectMenuInteraction,
    matchId: string,
    reasonId: string
  ): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) {
      await interaction.update({ content: 'Match not found.', components: [] });
      return;
    }
    const reason = this.ctx.matches.faultReasons().find((r) => r.id === reasonId);
    if (!reason) {
      await interaction.update({ content: 'Unknown reason.', components: [] });
      return;
    }
    if (!reason.playerRelated) {
      await interaction.update({ content: 'Recording your report…', components: [] });
      const result = await this.ctx.matches.submitFault(matchId, interaction.user.id, null, reason.label);
      if (!result.ok) {
        await interaction.update({ content: result.error ?? 'Could not record the report.', components: [] });
      }
      return;
    }

    const participants = this.ctx.db.repos.matches.participantIds(match);
    const others = participants.filter((id) => id !== interaction.user.id);
    const options: SelectMenuComponentOptionData[] = others.map((id) => {
      const user = this.ctx.db.repos.users.getById(id);
      return { label: user?.username ?? 'Unknown player', value: id };
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`faulttarget:${matchId}:${reasonId}`)
      .setPlaceholder('Who was responsible?')
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.update({
      content: `Reason: **${reason.label}**. Who was responsible?`,
      components: [row],
    });
  }

  private async recordFaultSubmission(
    interaction: StringSelectMenuInteraction,
    matchId: string,
    reportedId: string,
    reasonId: string
  ): Promise<void> {
    const reason = this.ctx.matches.faultReasons().find((r) => r.id === reasonId);
    const result = await this.ctx.matches.submitFault(
      matchId,
      interaction.user.id,
      reportedId,
      reason?.label ?? 'Other'
    );
    await interaction.update({
      content: result.ok
        ? 'Your report has been recorded.'
        : result.error ?? 'Could not record the report.',
      components: [],
    });
  }

  private async handleFaultPlayer(interaction: ButtonInteraction, customId: string): Promise<void> {
    const parts = customId.split(CUSTOM_ID_SEPARATOR);
    const matchId = parts[1];
    const reportedId = parts[2];
    const reasonId = parts[3];
    await this.recordFaultFromButton(interaction, matchId, reportedId, reasonId);
  }

  private async recordFaultFromButton(
    interaction: ButtonInteraction,
    matchId: string,
    reportedId: string,
    reasonId: string
  ): Promise<void> {
    const reason = this.ctx.matches.faultReasons().find((r) => r.id === reasonId);
    const result = await this.ctx.matches.submitFault(matchId, interaction.user.id, reportedId, reason?.label ?? 'Other');
    await interaction.reply({
      content: result.ok ? 'Your report has been recorded.' : result.error ?? 'Could not record the report.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // -------------------------------------------------------------------------
  // Modals
  // -------------------------------------------------------------------------

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const customId = interaction.customId;
    try {
      if (customId.startsWith('modal:teamcode:')) {
        const matchId = customId.split(CUSTOM_ID_SEPARATOR)[2];
        const code = (interaction.fields.getTextInputValue('teamcode_input') ?? '').trim();
        if (!code) {
          await interaction.reply({ content: 'The TeamCode cannot be empty.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (code.length > MAX_CODE_LENGTH) {
          await interaction.reply({ content: `TeamCode is too long (max ${MAX_CODE_LENGTH} characters).`, flags: MessageFlags.Ephemeral });
          return;
        }
        const result = await this.ctx.matches.submitTeamCode(matchId, code, interaction.user.id);
        await interaction.reply({ content: result.ok ? 'TeamCode submitted ✅' : result.error ?? 'Could not submit.', flags: MessageFlags.Ephemeral });
        await this.ctx.matches.refreshMatchMessage(matchId).catch(() => {});
        return;
      }
      if (customId.startsWith('modal:cancel:')) {
        const matchId = customId.split(CUSTOM_ID_SEPARATOR)[2];
        const reason = interaction.fields.getTextInputValue('cancel_reason').trim() || 'Cancelled by a player';
        await interaction.deferUpdate().catch(() => {});
        await this.ctx.matches.cancelMatch(matchId, reason, 'cancelled', interaction.user.id);
        await this.ctx.matches.refreshMatchMessage(matchId).catch(() => {});
        await interaction.followUp({ content: 'Match cancelled.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await interaction.reply({ content: 'Unknown modal.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      await this.safeError(interaction, error);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Resolves the match by an explicit matchId, explicit channel, or the user's active match. */
  currentMatchFor(userId: string, channelId?: string): MatchRow | undefined {
    if (channelId) {
      const byChannel = this.ctx.db.repos.matches.getByChannel(channelId);
      if (byChannel) return byChannel;
    }
    return this.ctx.db.repos.matches.getActiveByPlayer(userId);
  }

  private async safeError(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch {
      // Channel may be gone or interaction expired — nothing actionable.
    }
    this.ctx.db.repos.audits.log({
      action: 'interaction_error',
      target_id: interaction.user.id,
      details: JSON.stringify({ customId: interaction.customId, error: message }),
    });
  }
}