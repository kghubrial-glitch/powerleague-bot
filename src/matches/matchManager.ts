import {
  EmbedBuilder,
  TextChannel,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  Message,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  InteractionCollector,
} from 'discord.js';
import { AppContext } from '../context';
import { MatchRow, QueueEntryRow, VoteChoice } from '../types';
import { generateBalancedTeams } from '../matchmaking/teamBalancer';
import { selectMap } from '../matchmaking/mapSelector';
import { computeTeamEloChanges } from '../elo/eloCalculator';
import { rankForElo, rankKey, displayRank } from '../elo/rankManager';
import { buildMatchEmbed, matchActionRows, winnerLabel, matchChannelName, prettyMatchId } from '../format';
import { EMBED_COLORS } from '../presentation/embeds';
import { CATEGORY_NAME, BRAND_NAME, BRAND_SHORT, EMOJI } from '../presentation/brand';
import { evaluateVotes, VoteRecord } from './resultVoting';
import { shouldEscalateDodge, FAULT_VOTE_REQUIRED } from './faultDecision';
import { NO_REPORTED_PLAYER } from '../database/repositories/faultRepository';
import {
  draftPool,
  DRAFT_ORDER,
  captainForSlot,
  targetForSlot,
  isDraftComplete,
} from './draftManager';
import { Mutex } from '../services/mutex';

const REQUIRED_VOTE_COUNT = 4;

export interface FaultReasonDef {
  id: string;
  label: string;
  playerRelated: boolean;
}

const FAULT_REASONS: FaultReasonDef[] = [
  { id: 'dodge', label: 'Someone dodged', playerRelated: true },
  { id: 'nojoin', label: 'Someone did not join', playerRelated: true },
  { id: 'dc', label: 'Someone disconnected', playerRelated: true },
  { id: 'lobby', label: 'TeamCode did not work', playerRelated: false },
  { id: 'result', label: 'Players could not agree on the result', playerRelated: false },
  { id: 'other', label: 'Other', playerRelated: false },
];

export class MatchManager {
  private mutex = new Mutex();
  private applyingElo = new Set<string>();

  constructor(private ctx: AppContext) {}

  // -------------------------------------------------------------------------
  // Match creation
  // -------------------------------------------------------------------------

  async createMatchFromQueue(entries: QueueEntryRow[]): Promise<MatchRow | null> {
    return this.mutex.run(async () => {
      const settings = this.ctx.settings;
      if (entries.length < settings.queueSize) return null;

      if (settings.matchmakingMode === 'draft') {
        return this.createDraftMatch(entries.slice(0, settings.queueSize));
      }

      const players = entries.slice(0, settings.queueSize).map((e) => ({ discordId: e.discord_id, elo: e.elo_at_join }));
      const assignment = generateBalancedTeams(players, { tolerance: settings.teamBalanceTolerance });

      const enabledMaps = this.ctx.db.repos.maps.enabled();
      if (enabledMaps.length === 0) {
        throw new Error('No enabled maps. An administrator must enable a map first.');
      }
      const recentHistory = this.ctx.db.repos.maps.selectionHistory(20);
      const recentMapIds = recentHistory
        .map((h) => this.ctx.db.repos.maps.getByName(h.name)?.map_id)
        .filter((id): id is number => id !== undefined);
      const selected = selectMap(enabledMaps, recentMapIds, settings.mapRotationMode);

      const teamAIds = assignment.teamA;
      const teamBIds = assignment.teamB;
      const matchId = this.ctx.db.repos.matches.nextMatchId();

      const guild = this.ctx.client.guilds.cache.get(settings.guildId);
      if (!guild) throw new Error('Bot is not in the configured guild.');
      const category = await this.ensureCategory();
      const channel = await guild.channels.create({
        name: matchChannelName(matchId, 'awaiting_teamcode'),
        type: ChannelType.GuildText,
        parent: category,
      });

      // Lock down the channel to just participants + staff + bot.
      await channel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
      if (settings.staffRoleId) {
        const role = guild.roles.cache.get(settings.staffRoleId) ?? (await guild.roles.fetch(settings.staffRoleId).catch(() => null));
        if (role) await channel.permissionOverwrites.create(role, { ViewChannel: true });
      }
      for (const id of [...teamAIds, ...teamBIds]) {
        await channel.permissionOverwrites.create(id, { ViewChannel: true });
      }

      const now = new Date().toISOString();
      const created = this.ctx.db.repos.transaction<MatchRow>(() => {
        const match = this.ctx.db.repos.matches.create({
          match_id: matchId,
          team_a_players: JSON.stringify(teamAIds),
          team_b_players: JSON.stringify(teamBIds),
          team_a_avg_elo: this.avgElo(teamAIds),
          team_b_avg_elo: this.avgElo(teamBIds),
          map: selected.name,
          game_mode: selected.game_mode ?? null,
          format: settings.matchFormat,
          channel_id: channel.id,
        });
        this.ctx.db.repos.maps.markSelected(selected.map_id, matchId, now);
        return match;
      });

      const message = await channel.send({
        embeds: [this.buildEmbed(matchId)],
        components: matchActionRows(this.actionsForStatus('awaiting_teamcode')),
      });
      this.ctx.db.repos.matches.setMessageId(matchId, message.id);

      this.ctx.db.repos.audits.log({
        action: 'match_created',
        match_id: matchId,
        details: JSON.stringify({ channel_id: channel.id, map: selected.name, teamA: teamAIds, teamB: teamBIds }),
      });

      await this.ctx.logs.refresh(matchId).catch(() => {});
      this.scheduleTeamCodeDeadline(matchId);
      return created;
    });
  }

  // -------------------------------------------------------------------------
  // Captain draft
  // -------------------------------------------------------------------------

  /** In-memory channel -> collector map for non-persistent draft menus. */
  private draftCollectors = new Map<string, InteractionCollector<StringSelectMenuInteraction>>();

  /**
   * Creates a match in `drafting` state: private channel, a DB match with
   * empty team arrays, and a draft panel that the two captains operate.
   */
  async createDraftMatch(entries: QueueEntryRow[]): Promise<MatchRow | null> {
    const settings = this.ctx.settings;
    const matchId = this.ctx.db.repos.matches.nextMatchId();

    const enabledMaps = this.ctx.db.repos.maps.enabled();
    if (enabledMaps.length === 0) {
      throw new Error('No enabled maps. An administrator must enable a map first.');
    }
    const recentMapIds = this.ctx.db.repos.maps
      .selectionHistory(20)
      .map((h) => this.ctx.db.repos.maps.getByName(h.name)?.map_id)
      .filter((id): id is number => id !== undefined);
    const selected = selectMap(enabledMaps, recentMapIds, settings.mapRotationMode);

    const { captainA, captainB, pool } = draftPool(
      entries.map((e) => ({ discordId: e.discord_id, elo: e.elo_at_join }))
    );

    const guild = this.ctx.client.guilds.cache.get(settings.guildId);
    if (!guild) throw new Error('Bot is not in the configured guild.');
    const category = await this.ensureCategory();
    const channel = await guild.channels.create({
      name: matchChannelName(matchId, 'drafting'),
      type: ChannelType.GuildText,
      parent: category,
    });
    await channel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
    if (settings.staffRoleId) {
      const role = guild.roles.cache.get(settings.staffRoleId) ?? (await guild.roles.fetch(settings.staffRoleId).catch(() => null));
      if (role) await channel.permissionOverwrites.create(role, { ViewChannel: true });
    }
    for (const id of entries.map((e) => e.discord_id)) {
      await channel.permissionOverwrites.create(id, { ViewChannel: true });
    }

    const now = new Date().toISOString();
    const created = this.ctx.db.repos.transaction<MatchRow>(() => {
      const match = this.ctx.db.repos.matches.create({
        match_id: matchId,
        team_a_players: JSON.stringify([]),
        team_b_players: JSON.stringify([]),
        team_a_avg_elo: 0,
        team_b_avg_elo: 0,
        map: selected.name,
        game_mode: selected.game_mode ?? null,
        format: settings.matchFormat,
        channel_id: channel.id,
      });
      this.ctx.db.repos.matches.updateStatus(matchId, 'drafting');
      this.ctx.db.repos.matches.setMatchmakingMode(matchId, 'draft');
      this.ctx.db.repos.maps.markSelected(selected.map_id, matchId, now);
      this.ctx.db.repos.drafts.create({
        match_id: matchId,
        captain_a: captainA,
        captain_b: captainB,
        pool: JSON.stringify(pool),
        current_turn: 'A',
      });
      return match;
    });

    const draftMessage = await channel.send({
      embeds: [this.draftPanelEmbed(matchId)],
      components: [this.draftSelectRow(matchId, 'A')],
    });
    this.ctx.db.repos.matches.setMessageId(matchId, draftMessage.id);
    this.ctx.db.repos.audits.log({
      action: 'draft_created',
      match_id: matchId,
      details: JSON.stringify({ captainA, captainB, pool }),
    });
    await this.ctx.logs.refresh(matchId).catch(() => {});
    return created;
  }

  /**
   * Renders the current draft state: who is picking, the draft order, current
   * teams and the remaining pool.
   */
  draftPanelEmbed(matchId: string): EmbedBuilder {
    const draft = this.ctx.db.repos.drafts.get(matchId);
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!draft || !match) {
      return new EmbedBuilder().setTitle('Draft').setDescription('Draft state not found.');
    }
    const remaining = JSON.parse(draft.pool) as string[];
    const picks = this.ctx.db.repos.drafts.picks(matchId);
    const teamA: string[] = [draft.captain_a];
    const teamB: string[] = [draft.captain_b];
    for (const p of picks) (p.turn === 'A' ? teamA : teamB).push(p.picked_id);

    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI.leaderboard} ${BRAND_SHORT} · Captain Draft · ${prettyMatchId(matchId).toUpperCase()}`)
      .setColor(0x5865f2)
      .setDescription(
        draft.status === 'completed'
          ? 'Draft complete — teams are locked.'
          : `**On the clock:** <@${draft.current_turn === 'A' ? draft.captain_a : draft.captain_b}>\nPick order: **${DRAFT_ORDER.join(' → ')}**`
      );

    const formatTeam = (captain: string, members: string[]) =>
      members.map((id) => `<@${id}>${id === captain ? ' · captain' : ''}`).join('\n') || '...';

    embed.addFields(
      { name: `🅰️ TEAM A`, value: formatTeam(draft.captain_a, teamA), inline: true },
      { name: `🅱️ TEAM B`, value: formatTeam(draft.captain_b, teamB), inline: true }
    );
    embed.addFields({
      name: 'Players left to pick',
      value: remaining.length > 0 ? remaining.map((id) => `<@${id}>`).join('\n') : 'None',
      inline: false,
    });
    if (match.map) {
      embed.addFields({ name: `🗺️ Map`, value: `${match.map}${match.game_mode ? ` · ${match.game_mode}` : ''}`, inline: false });
    }
    embed.setFooter({ text: BRAND_NAME });
    return embed;
  }

  /** Select row listing the current pool for the captain who is on the clock. */
  draftSelectRow(matchId: string, forTurn: 'A' | 'B'): ActionRowBuilder<StringSelectMenuBuilder> {
    const draft = this.ctx.db.repos.drafts.get(matchId);
    const pool = draft ? (JSON.parse(draft.pool) as string[]) : [];
    const options = pool.map((id) => {
      const user = this.ctx.db.repos.users.getById(id);
      return { label: user?.username ?? 'Unknown player', value: id };
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`draft:pick:${matchId}`)
      .setPlaceholder(`Pick a teammate for Team ${forTurn}`)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options.length > 0 ? options : [{ label: 'No players available', value: '_none' }]);
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  }

  /**
   * Handles a captain's pick from the draft select menu. Validates that the
   * acting captain is the correct one, applies the pick, then either advances
   * the turn or completes the draft and transitions to `awaiting_teamcode`.
   */
  async handleDraftPick(
    interaction: StringSelectMenuInteraction,
    matchId: string,
    pickedId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const draft = this.ctx.db.repos.drafts.get(matchId);
    if (!draft) return { ok: false, error: 'Draft not found.' };
    if (draft.status !== 'selecting') return { ok: false, error: 'This draft is already complete or expired.' };
    const actingCaptain = draft.current_turn === 'A' ? draft.captain_a : draft.captain_b;
    if (interaction.user.id !== actingCaptain) {
      return { ok: false, error: `Only the captain (<@${actingCaptain}>) can pick right now.` };
    }
    if (!JSON.parse(draft.pool).includes(pickedId)) {
      return { ok: false, error: 'That player is no longer in the pool.' };
    }

    const pickIndex = draft.turn_index;
    const turn = captainForSlot(pickIndex);
    this.ctx.db.repos.drafts.addPick({ match_id: matchId, pick_index: pickIndex, turn, captain_id: interaction.user.id, picked_id: pickedId });

    const newPool = (JSON.parse(draft.pool) as string[]).filter((id) => id !== pickedId);
    this.ctx.db.repos.drafts.updatePool(matchId, JSON.stringify(newPool));
    const nextIndex = pickIndex + 1;

    if (isDraftComplete(nextIndex)) {
      // Finalize teams and open the real match.
      this.ctx.db.repos.drafts.setStatus(matchId, 'completed');
      this.ctx.db.repos.drafts.setTurn(matchId, null, nextIndex);
      await this.finalizeDraft(matchId);
      return { ok: true };
    }

    const nextTurn = captainForSlot(nextIndex);
    this.ctx.db.repos.drafts.setTurn(matchId, nextTurn, nextIndex);
    await this.refreshDraftMessage(matchId);
    return { ok: true };
  }

  /** Finalizes teams from the completed draft, then posts the standard match embed. */
  private async finalizeDraft(matchId: string): Promise<void> {
    const draft = this.ctx.db.repos.drafts.get(matchId);
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!draft || !match) return;
    const picks = this.ctx.db.repos.drafts.picks(matchId);
    const teamA = [draft.captain_a];
    const teamB = [draft.captain_b];
    for (const p of picks) (p.turn === 'A' ? teamA : teamB).push(p.picked_id);

    const tx = this.ctx.db.repos.transaction(() => {
      this.ctx.db.repos.matches.finalizeDraftTeams(matchId, teamA, teamB, draft.captain_a, draft.captain_b);
      this.ctx.db.repos.matches.updateStatus(matchId, 'awaiting_teamcode');
    });
    // Update the panel message in place.
    const channel = match.channel_id ? (this.ctx.client.channels.cache.get(match.channel_id) as TextChannel | undefined) : undefined;
    if (channel && match.message_id) {
      const message = await channel.messages.fetch(match.message_id).catch(() => null);
      if (message) {
        await message.edit({
          embeds: [this.buildEmbed(matchId)],
          components: matchActionRows(this.actionsForStatus('awaiting_teamcode')),
        });
      }
    }
    this.scheduleTeamCodeDeadline(matchId);
    this.ctx.db.repos.audits.log({
      action: 'draft_completed',
      match_id: matchId,
      details: JSON.stringify({ teamA, teamB }),
    });
  }

  private async refreshDraftMessage(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id || !match?.message_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    const message = await channel.messages.fetch(match.message_id).catch(() => null);
    if (!message) return;
    const draft = this.ctx.db.repos.drafts.get(matchId);
    if (!draft) return;
    await message.edit({
      embeds: [this.draftPanelEmbed(matchId)],
      components: [this.draftSelectRow(matchId, draft.current_turn as 'A' | 'B')],
    });
  }

  /** Re-attaches a draft collector after a restart. */
  async reconcileDraft(matchId: string): Promise<void> {
    const draft = this.ctx.db.repos.drafts.get(matchId);
    if (!draft || draft.status !== 'selecting') return;
    // The select menu is persistent (custom id), so no collector is strictly
    // required; this hook exists for future scheduled expiry handling.
  }

  private avgElo(ids: string[]): number {
    const elos = ids
      .map((id) => this.ctx.db.repos.users.getById(id)?.elo)
      .filter((v): v is number => v !== undefined);
    if (elos.length === 0) return 1000;
    return elos.reduce((a, b) => a + b, 0) / elos.length;
  }

  private async ensureCategory(): Promise<string | null> {
    const guild = this.ctx.client.guilds.cache.get(this.ctx.settings.guildId);
    if (!guild) return null;
    const existing = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
    );
    if (existing) return existing.id;
    const created = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
    return created.id;
  }

  // -------------------------------------------------------------------------
  // Message refresh
  // -------------------------------------------------------------------------

  async refreshMatchMessage(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id || !match?.message_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    let message: Message;
    try {
      message = await channel.messages.fetch(match.message_id);
    } catch {
      return; // message deleted — nothing to refresh
    }
    if (!message.editable) return;
    await message.edit({
      embeds: [this.buildEmbed(matchId)],
      components: matchActionRows(this.actionsForStatus(match.status, matchId)),
    });
    await this.renameMatchChannel(matchId);
    await this.ctx.logs.refresh(matchId).catch(() => {});
  }

  /** Updates the channel title to reflect the current match phase. */
  private async renameMatchChannel(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id) return;
    const target = matchChannelName(matchId, match.status);
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    if (channel.name !== target) {
      await channel.setName(target).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // TeamCode
  // -------------------------------------------------------------------------

  async submitTeamCode(matchId: string, code: string, submittedBy: string): Promise<{ ok: boolean; error?: string }> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return { ok: false, error: 'Match not found.' };
    if (match.status !== 'awaiting_teamcode') {
      return { ok: false, error: `TeamCode submission is only open before readiness (status: ${match.status}).` };
    }
    if (!this.ctx.db.repos.matches.isParticipant(match, submittedBy)) {
      return { ok: false, error: 'Only participants of this match can submit the TeamCode.' };
    }
    if (match.team_code) return { ok: false, error: 'A TeamCode was already accepted for this match.' };
    const accepted = this.ctx.db.repos.matches.setTeamCode(matchId, code, submittedBy, new Date().toISOString());
    if (!accepted) return { ok: false, error: 'A TeamCode was already accepted for this match.' };
    await this.publishTeamCode(matchId);
    this.scheduleReadyDeadline(matchId);
    return { ok: true };
  }

  private async publishTeamCode(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id || !match.team_code) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;

    const submitter = this.submitterName(match);
    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI.teamcode} ${BRAND_SHORT} · TeamCode submitted · ${prettyMatchId(matchId).toUpperCase()}`)
      .setColor(0x57f287)
      .setDescription(
        `Code: \`${match.team_code}\`\n\nAll players, join the in-game team with the code above, then press **Ready**.\nSubmitted by: **${submitter}**`
      )
      .setFooter({ text: `${BRAND_NAME} · the code stays in this private channel` });

    const copyCode = new ButtonBuilder()
      .setCustomId(`match:copycode:${matchId}`)
      .setLabel('View code')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👁️');
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(copyCode);

    await channel.send({ embeds: [embed], components: [row] });
    this.setMatchStatus(matchId, 'awaiting_ready');
    await this.refreshMatchMessage(matchId);
  }

  private submitterName(match: MatchRow): string {
    if (!match.team_code_submitted_by) return 'someone';
    return this.ctx.db.repos.users.getById(match.team_code_submitted_by)?.username ?? 'someone';
  }

  async staffResetTeamCode(matchId: string, adminId: string): Promise<boolean> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return false;
    this.ctx.db.repos.matches.resetTeamCode(matchId);
    this.setMatchStatus(matchId, 'awaiting_teamcode');
    this.scheduleTeamCodeDeadline(matchId);
    await this.refreshMatchMessage(matchId);
    this.ctx.db.repos.audits.log({ action: 'teamcode_reset', match_id: matchId, administrator_id: adminId });
    return true;
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  async pressReady(matchId: string, discordId: string): Promise<{ ok: boolean; error?: string }> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return { ok: false, error: 'Match not found.' };
    if (!this.ctx.db.repos.matches.isParticipant(match, discordId)) {
      return { ok: false, error: 'Only participants can mark themselves ready.' };
    }
    if (match.status !== 'awaiting_ready') {
      return { ok: false, error: `Readiness is only active after a TeamCode is posted (status: ${match.status}).` };
    }
    this.ctx.db.repos.matches.setReady(matchId, discordId);
    await this.refreshMatchMessage(matchId);
    await this.tryStartMatch(matchId);
    return { ok: true };
  }

  private async tryStartMatch(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match || match.status !== 'awaiting_ready') return;
    const ready = this.ctx.db.repos.matches.readyIds(matchId);
    const participants = this.ctx.db.repos.matches.participantIds(match);
    if (ready.length >= participants.length) {
      this.ctx.db.repos.matches.startMatch(matchId, new Date().toISOString());
      this.ctx.timers.cancel(matchId, 'ready');
      this.scheduleMatchDeadline(matchId);
      await this.notify(
        matchId,
        `🎮 All **${participants.length}** players are ready — the match is **live**! Good luck!\n` +
          `${match.format === 'best_of_3' ? 'First team to win **2 games** takes the series.' : 'Single game — win it!'}`
      );
      await this.refreshMatchMessage(matchId);
    }
  }

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------

  async startVoting(matchId: string, proposerId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return;
    if (match.status !== 'in_progress') {
      await this.notify(matchId, 'The match is not in progress, so voting cannot start.');
      return;
    }
    if (!this.ctx.db.repos.matches.isParticipant(match, proposerId)) {
      await this.notify(matchId, 'Only participants can start result voting.');
      return;
    }
    this.setMatchStatus(matchId, 'voting');
    this.ctx.db.repos.matches.clearVotes(matchId);
    this.ctx.timers.cancel(matchId, 'match');
    await this.postVotingPrompt(matchId);
    this.scheduleVoteDeadline(matchId);
    await this.refreshMatchMessage(matchId);
  }

  private async postVotingPrompt(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;

    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI.vote} ${BRAND_SHORT} · Result vote · ${prettyMatchId(matchId).toUpperCase()}`)
      .setColor(0xfee75c)
      .setDescription(
        `The match has ended. Vote below — choices are **private** until everyone votes.\n\n` +
          `**Rule:** a result needs **${REQUIRED_VOTE_COUNT} of 6** votes for the same outcome, **from both teams**.`
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`vote:A:${matchId}`).setLabel('Team A won').setStyle(ButtonStyle.Success).setEmoji('🅰️'),
      new ButtonBuilder().setCustomId(`vote:B:${matchId}`).setLabel('Team B won').setStyle(ButtonStyle.Danger).setEmoji('🅱️'),
      new ButtonBuilder().setCustomId(`vote:draw:${matchId}`).setLabel('Draw').setStyle(ButtonStyle.Secondary).setEmoji('🤝')
    );
    await channel.send({ embeds: [embed], components: [row] });
  }

  async castVote(matchId: string, discordId: string, vote: VoteChoice): Promise<{ ok: boolean; error?: string }> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return { ok: false, error: 'Match not found.' };
    if (match.status !== 'voting') {
      return { ok: false, error: 'Voting is not open for this match.' };
    }
    if (!this.ctx.db.repos.matches.isParticipant(match, discordId)) {
      return { ok: false, error: 'Only participants can vote.' };
    }
    const inserted = this.ctx.db.repos.matches.createVote(matchId, discordId, vote);
    if (!inserted) {
      return { ok: false, error: 'You have already cast your vote. Votes cannot be changed.' };
    }
    await this.maybeResolveVoting(matchId);
    return { ok: true };
  }

  private async maybeResolveVoting(matchId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match || match.status !== 'voting') return;
    const votes = this.ctx.db.repos.matches.getVotes(matchId);
    const teamA = this.ctx.db.repos.matches.teamAIds(match);
    const teamB = this.ctx.db.repos.matches.teamBIds(match);
    const participants = this.ctx.db.repos.matches.participantIds(match);

    const evaluation = evaluateVotes(votes as VoteRecord[], teamA, teamB);
    if (evaluation.decided) {
      this.ctx.timers.cancel(matchId, 'vote');
      await this.applyConfirmedResult(matchId, evaluation.winner!);
      return;
    }
    if (votes.length >= participants.length) {
      this.ctx.timers.cancel(matchId, 'vote');
      const summary = Object.entries(evaluation.tallies)
        .map(([choice, c]) => `${choice === 'A' ? 'Team A' : choice === 'B' ? 'Team B' : 'Draw'}: ${c}`)
        .join(', ');
      await this.markDisputed(matchId, `No majority outcome after all ${votes.length} votes (${summary}).`);
      return;
    }
    await this.refreshMatchMessage(matchId);
  }

  // -------------------------------------------------------------------------
  // Confirmed results & Elo
  // -------------------------------------------------------------------------

  async applyConfirmedResult(matchId: string, winner: VoteChoice): Promise<void> {
    if (this.applyingElo.has(matchId)) return; // defensive idempotency
    this.applyingElo.add(matchId);
    try {
      const match = this.ctx.db.repos.matches.get(matchId);
      if (!match) return;
      if (match.status === 'confirmed') return; // never apply twice
      if (match.status === 'cancelled' || match.status === 'timed_out') {
        return; // a cancelled/timed-out match cannot receive a later result update
      }

      const teamA = this.ctx.db.repos.matches.teamAIds(match);
      const teamB = this.ctx.db.repos.matches.teamBIds(match);

      const teamAAvg = this.avgElo(teamA);
      const teamBAvg = this.avgElo(teamB);
      const teamAMatches = this.avgMatches(teamA);
      const teamBMatches = this.avgMatches(teamB);
      const outcomeA: 'win' | 'loss' | 'draw' = winner === 'A' ? 'win' : winner === 'B' ? 'loss' : 'draw';
      const changes = computeTeamEloChanges(teamAAvg, teamBAvg, outcomeA, teamAMatches, teamBMatches);

      const { scoreA, scoreB } = seriesScore(match, winner);

      const rankChanges: Array<{ tag: string; before: string; after: string; elo: number }> = [];
      this.ctx.db.repos.transaction(() => {
        const now = new Date().toISOString();
        this.applyEloToTeam(teamA, matchId, outcomeA, changes.teamAChange, now, rankChanges);
        const outcomeB: 'win' | 'loss' | 'draw' = outcomeA === 'win' ? 'loss' : outcomeA === 'loss' ? 'win' : 'draw';
        this.applyEloToTeam(teamB, matchId, outcomeB, changes.teamBChange, now, rankChanges);
        this.recordMapStats(teamA, teamB, match.map, outcomeA);
        this.ctx.db.repos.matches.confirmResult(matchId, winner, scoreA, scoreB);
      });

      this.ctx.timers.cancelAllForMatch(matchId);
      await this.announceResult(matchId, winner, rankChanges);
      await this.refreshMatchMessage(matchId);
      await this.ctx.queue.refreshPanel().catch(() => {});
    } finally {
      this.applyingElo.delete(matchId);
    }
  }

  private avgMatches(ids: string[]): number {
    const counts = ids
      .map((id) => this.ctx.db.repos.users.getById(id)?.total_matches)
      .filter((v): v is number => v !== undefined);
    if (counts.length === 0) return 0;
    return counts.reduce((a, b) => a + b, 0) / counts.length;
  }

  private recordMapStats(
    teamA: string[],
    teamB: string[],
    map: string | null | undefined,
    outcomeA: 'win' | 'loss' | 'draw'
  ): void {
    if (!map) return;
    for (const id of teamA) this.ctx.db.repos.mapStats.record(id, map, outcomeA);
    const outcomeB: 'win' | 'loss' | 'draw' = outcomeA === 'win' ? 'loss' : outcomeA === 'loss' ? 'win' : 'draw';
    for (const id of teamB) this.ctx.db.repos.mapStats.record(id, map, outcomeB);
  }

  private applyEloToTeam(
    ids: string[],
    matchId: string,
    outcome: 'win' | 'loss' | 'draw',
    change: number,
    timestamp: string,
    rankChanges?: Array<{ tag: string; before: string; after: string; elo: number }>
  ): void {
    for (const id of ids) {
      const user = this.ctx.db.repos.users.getById(id);
      if (!user) continue;
      const beforeKey = rankKey(user.elo, this.ctx.settings.ranks);
      this.ctx.db.repos.users.applyEloChange(id, matchId, user.elo, change, outcome, timestamp);
      const after = this.ctx.db.repos.users.getById(id);
      const afterKey = after ? rankKey(after.elo, this.ctx.settings.ranks) : beforeKey;
      if (beforeKey !== afterKey && after) {
        rankChanges?.push({ tag: `<@${id}>`, before: displayRank(user.elo, this.ctx.settings.ranks), after: displayRank(after.elo, this.ctx.settings.ranks), elo: after.elo });
      }
    }
  }

  private async announceResult(
    matchId: string,
    winner: VoteChoice,
    rankChanges: Array<{ tag: string; before: string; after: string; elo: number }> = []
  ): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    const changedLines = rankChanges.map((c) => `${c.tag}: **${c.before}** → **${c.after}**`);
    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI.trophy} ${BRAND_SHORT} · Result confirmed · ${prettyMatchId(matchId).toUpperCase()}`)
      .setColor(EMBED_COLORS.success)
      .setDescription(
        `Winner: **${winnerLabel(winner)}**\n` +
          `Final score: **${match.team_a_score}–${match.team_b_score}**\n\n` +
          'Elo has been updated for every participant.' +
          (changedLines.length ? `\n\n**Rank changes**\n${changedLines.join('\n')}` : '')
      );
    await channel.send({ embeds: [embed] });
  }

  /** Admin override: confirm or correct a result, applying Elo exactly once. */
  async adminResolve(
    matchId: string,
    winner: VoteChoice,
    adminId: string,
    scoreA?: number,
    scoreB?: number
  ): Promise<{ ok: boolean; error?: string }> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return { ok: false, error: 'Match not found.' };
    const alreadyConfirmed = match.status === 'confirmed';
    const sA = scoreA ?? (winner === 'A' ? (match.format === 'best_of_3' ? 2 : 1) : winner === 'draw' ? 1 : 0);
    const sB = scoreB ?? (winner === 'B' ? (match.format === 'best_of_3' ? 2 : 1) : winner === 'draw' ? 1 : 0);

    if (!alreadyConfirmed && match.status !== 'cancelled' && match.status !== 'timed_out') {
      await this.applyConfirmedResult(matchId, winner);
    } else {
      this.ctx.db.repos.matches.adminResolve(matchId, winner, sA, sB, 'confirmed');
    }
    this.ctx.timers.cancelAllForMatch(matchId);
    await this.refreshMatchMessage(matchId);
    this.ctx.db.repos.audits.log({
      action: 'admin_result',
      match_id: matchId,
      administrator_id: adminId,
      details: JSON.stringify({ winner, scoreA: sA, scoreB: sB }),
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Disputes & cancellation
  // -------------------------------------------------------------------------

  async markDisputed(matchId: string, reason: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return;
    if (['confirmed', 'cancelled', 'timed_out', 'disputed'].includes(match.status)) return;
    this.ctx.db.repos.matches.markDisputed(matchId);
    this.ctx.timers.cancelAllForMatch(matchId);
    await this.notifyStaff(
      `🚩 Match **${prettyMatchId(matchId).toUpperCase()}** was marked **disputed**: ${reason}\n` +
        'Resolve with `/scrim result` (confirm/correct) or `/scrim cancel`.'
    );
    await this.refreshMatchMessage(matchId);
  }

  async cancelMatch(
    matchId: string,
    reason: string,
    status: 'cancelled' | 'timed_out' = 'cancelled',
    actor?: string
  ): Promise<boolean> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return false;
    if (['confirmed', 'cancelled', 'timed_out', 'disputed'].includes(match.status)) return false;
    if (status === 'cancelled') {
      this.ctx.db.repos.matches.cancel(matchId, reason);
    } else {
      this.ctx.db.repos.matches.timeout(matchId, reason);
    }
    this.ctx.timers.cancelAllForMatch(matchId);
    await this.postCancellationUI(matchId, reason);
    if (actor) {
      this.ctx.db.repos.audits.log({
        action: 'match_cancelled',
        match_id: matchId,
        administrator_id: actor,
        details: JSON.stringify({ reason, status }),
      });
    }
    return true;
  }

  private async postCancellationUI(matchId: string, reason: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI.cancel} ${BRAND_SHORT} · Match cancelled · ${prettyMatchId(matchId).toUpperCase()}`)
      .setColor(0xed4245)
      .setDescription(
        `Reason: **${reason}**\n\nWhat happened? Tell us below — each player can report once.\n` +
          `If **4 players from both teams** accuse the same player, staff is notified.`
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('fault:select').setLabel('What happened?').setStyle(ButtonStyle.Secondary).setEmoji('📋')
    );
    await channel.send({ embeds: [embed], components: [row] });
    this.scheduleFaultDeadline(matchId);
    // Keep the main match embed in the cancelled state so the live dashboard
    // (reporter count, tallies) stays visible and up to date.
    await this.refreshMatchMessage(matchId).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Fault reporting
  // -------------------------------------------------------------------------

  faultReasons(): FaultReasonDef[] {
    return FAULT_REASONS;
  }

  /** Whether a cancelled/timed-out match still accepts fault reports. */
  isFaultReportingOpen(matchId: string): boolean {
    return this.isFaultWindowOpen(matchId);
  }

  async submitFault(
    matchId: string,
    reporterId: string,
    reportedId: string | null,
    reason: string
  ): Promise<{ ok: boolean; error?: string; escalated?: boolean }> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return { ok: false, error: 'Match not found.' };
    if (match.status !== 'cancelled' && match.status !== 'timed_out') {
      return { ok: false, error: 'Fault reporting is only available for cancelled/timed-out matches.' };
    }
    if (!this.isFaultWindowOpen(matchId)) {
      return { ok: false, error: 'The fault-report window for this match has closed.' };
    }
    if (!this.ctx.db.repos.matches.isParticipant(match, reporterId)) {
      return { ok: false, error: 'Only participants can report.' };
    }
    if (reportedId && reportedId === reporterId) {
      return { ok: false, error: 'You cannot report yourself.' };
    }
    const inserted = this.ctx.db.repos.faults.add({
      match_id: matchId,
      reporter_id: reporterId,
      reported_player_id: reportedId || NO_REPORTED_PLAYER,
      reason,
    });
    if (!inserted) {
      return { ok: false, error: 'You have already submitted a report for this match. One report per player.' };
    }

    this.ctx.db.repos.audits.log({
      action: reportedId ? 'fault_report' : 'fault_category',
      match_id: matchId,
      target_id: reporterId,
      details: JSON.stringify({ reported_id: reportedId ?? null, reason }),
    });
    this.scheduleFaultDeadline(matchId);

    if (reportedId) {
      const escalated = await this.processFaultReport(matchId, reportedId);
      await this.refreshMatchMessage(matchId).catch(() => {});
      if (escalated) {
        return { ok: true, escalated: true };
      }
    } else {
      await this.refreshMatchMessage(matchId).catch(() => {});
    }
    return { ok: true };
  }

  /**
   * Counts reports for `reportedId` (excluding the accused player's own voice)
   * and — when at least REQUIRED_VOTE_COUNT players from both teams agree —
   * upserts an `awaiting_moderator` dodge report and notifies staff + channel.
   * Returns true when a dodge was escalated.
   */
  private async processFaultReport(matchId: string, reportedId: string): Promise<boolean> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return false;
    const teamA = this.ctx.db.repos.matches.teamAIds(match);
    const teamB = this.ctx.db.repos.matches.teamBIds(match);

    const reports = this.ctx.db.repos.faults.forMatch(matchId).filter(
      (r) => r.reported_player_id === reportedId && r.reporter_id !== reportedId
    );
    if (!shouldEscalateDodge({ reportedPlayerId: reportedId, reporterIds: reports.map((r) => r.reporter_id), teamA, teamB })) {
      return false;
    }
    const count = reports.length;

    this.ctx.db.repos.faults.addDodge({
      match_id: matchId,
      reported_player_id: reportedId,
      reports: count,
      status: 'awaiting_moderator',
    });

    const embed = new EmbedBuilder()
      .setTitle(`⚠️ ${BRAND_SHORT} · Dodge report · ${prettyMatchId(matchId).toUpperCase()}`)
      .setColor(0xed4245)
      .setDescription(
        `Reported player: **<@${reportedId}>**\nAccusations: **${count}**\n\n` +
          `Needs **moderator review** — nobody is punished automatically.\n` +
          `Resolve with \`/scrim dodge\`.`
      )
      .setFooter({ text: BRAND_NAME });
    const channel = match.channel_id ? this.ctx.client.channels.cache.get(match.channel_id) : undefined;
    if (channel instanceof TextChannel) {
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
    await this.notifyStaff(
      `⚠️ **DODGE REPORT**\n\nMatch: **${prettyMatchId(matchId).toUpperCase()}**\nReported player: <@${reportedId}>\n` +
        `Accusations: ${count}\nStatus: **AWAITING MODERATOR REVIEW**\n` +
        `Resolve with \`/scrim dodge\`.`
    );
    return true;
  }

  /** Admin decision on a dodge report: apply a cooldown or clear it. */
  async moderateDodge(
    matchId: string,
    reportedId: string,
    decision: 'cooldown' | 'clear',
    durationMinutes: number,
    adminId: string
  ): Promise<void> {
    if (decision === 'cooldown') {
      const until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
      this.ctx.db.repos.cooldowns.set(reportedId, until, `Dodge in match ${matchId}`, adminId);
    }
    const existing = this.ctx.db.repos.faults
      .dodgeEntries(matchId)
      .find((d) => d.reported_player_id === reportedId);
    this.ctx.db.repos.faults.addDodge({
      match_id: matchId,
      reported_player_id: reportedId,
      reports: existing?.reports ?? 0,
      status: decision === 'cooldown' ? 'moderator_cooldown' : 'moderator_clear',
    });
    this.ctx.db.repos.audits.log({
      action: 'moderator_dodge_decision',
      match_id: matchId,
      administrator_id: adminId,
      target_id: reportedId,
      details: JSON.stringify({ decision, durationMinutes }),
    });
    await this.refreshMatchMessage(matchId).catch(() => {});
    await this.notify(
      matchId,
      decision === 'cooldown'
        ? `⛔ **Dodge confirmed** for <@${reportedId}> — ${durationMinutes}-minute matchmaking cooldown.`
        : `✅ **Dodge report** for <@${reportedId}> was cleared — no action taken.`
    );
  }

  // -------------------------------------------------------------------------
  // Timers / deadlines
  // -------------------------------------------------------------------------

  private scheduleTeamCodeDeadline(matchId: string): void {
    const due = new Date(Date.now() + this.ctx.settings.timers.teamCode * 1000).toISOString();
    this.ctx.timers.schedule(matchId, 'teamcode', due);
  }

  private scheduleReadyDeadline(matchId: string): void {
    const due = new Date(Date.now() + this.ctx.settings.timers.ready * 1000).toISOString();
    this.ctx.timers.schedule(matchId, 'ready', due);
  }

  private scheduleMatchDeadline(matchId: string): void {
    const due = new Date(Date.now() + this.ctx.settings.timers.match * 1000).toISOString();
    this.ctx.timers.schedule(matchId, 'match', due);
  }

  private scheduleVoteDeadline(matchId: string): void {
    const due = new Date(Date.now() + this.ctx.settings.timers.vote * 1000).toISOString();
    this.ctx.timers.schedule(matchId, 'vote', due);
  }

  private scheduleFaultDeadline(matchId: string): void {
    const due = new Date(Date.now() + this.ctx.settings.timers.faultReport * 1000).toISOString();
    this.ctx.timers.schedule(matchId, 'fault_report', due);
  }

  /** Entry point used by the TimerManager for every deadline kind. */
  async onDeadline(matchId: string, kind: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return;
    switch (kind) {
      case 'teamcode':
        if (match.status === 'awaiting_teamcode') {
          await this.cancelMatch(matchId, 'No TeamCode was submitted in time');
        }
        break;
      case 'ready':
        if (match.status === 'awaiting_ready') {
          const ready = this.ctx.db.repos.matches.readyIds(matchId);
          const participants = this.ctx.db.repos.matches.participantIds(match);
          const missing = participants.filter((id) => !ready.includes(id));
          await this.cancelMatch(matchId, 'Not all players became ready in time');
          await this.notify(
            matchId,
            `⏳ Timed out while waiting for readiness. Not ready: ${missing.map((id) => `<@${id}>`).join(', ') || 'none'}\nPlease report what happened.`
          );
        }
        break;
      case 'match':
        if (match.status === 'in_progress') {
          await this.cancelMatch(matchId, 'The match did not finish before the deadline', 'timed_out');
        }
        break;
      case 'vote':
        if (match.status === 'voting') {
          await this.markDisputed(matchId, 'The voting period expired without a confirmed result');
        }
        break;
      case 'fault_report':
        await this.notify(matchId, '📋 The fault-reporting window has closed.');
        await this.refreshMatchMessage(matchId).catch(() => {}); // disables the report button
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Embeds & actions
  // -------------------------------------------------------------------------

  private buildEmbed(matchId: string): EmbedBuilder {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return new EmbedBuilder().setTitle('Match not found');
    const teamA = this.ctx.db.repos.matches.teamAIds(match);
    const teamB = this.ctx.db.repos.matches.teamBIds(match);
    const info = (ids: string[]) =>
      ids.map((id) => {
        const user = this.ctx.db.repos.users.getById(id);
        return { id, username: user?.username ?? 'Unknown', elo: user?.elo ?? 1000 };
      });
    const ready = this.ctx.db.repos.matches.readyIds(matchId);
    const votes = this.ctx.db.repos.matches.getVotes(matchId);
    const tallies: Record<string, number> = { A: 0, B: 0, draw: 0 };
    for (const v of votes) tallies[v.vote] = (tallies[v.vote] ?? 0) + 1;

    const participants = match.status === 'cancelled' || match.status === 'timed_out' ? [...teamA, ...teamB] : [];
    const fault =
      match.status === 'cancelled' || match.status === 'timed_out'
        ? {
            reporterCount: this.ctx.db.repos.faults.reporterCount(matchId),
            participantCount: participants.length,
            byReported: this.ctx.db.repos.faults.talliesByReported(matchId),
            general: this.ctx.db.repos.faults.generalReasonTallies(matchId),
            dodges: this.ctx.db.repos.faults.dodgeEntries(matchId),
          }
        : undefined;

    return buildMatchEmbed({
      match,
      teamA: info(teamA),
      teamB: info(teamB),
      ready,
      votesCount: votes.length,
      voteTotals: tallies,
      ranks: this.ctx.settings.ranks,
      maps: [],
      fault,
    });
  }

  /** Chooses which buttons are live for a given match status. */
  private actionsForStatus(status: MatchRow['status'], matchId?: string) {
    switch (status) {
      case 'awaiting_teamcode':
        return { teamCode: true, ready: false, finished: false, cancel: true, vote: false, copyCode: false, faultButtons: false };
      case 'awaiting_ready':
        return { teamCode: false, ready: true, finished: false, cancel: true, vote: false, copyCode: true, faultButtons: false };
      case 'in_progress':
        return { teamCode: false, ready: false, finished: true, cancel: true, vote: false, copyCode: true, faultButtons: false };
      case 'voting':
        return { teamCode: false, ready: false, finished: false, cancel: false, vote: true, copyCode: false, faultButtons: false };
      case 'cancelled':
      case 'timed_out':
        return {
          teamCode: false,
          ready: false,
          finished: false,
          cancel: false,
          vote: false,
          copyCode: false,
          faultButtons: matchId ? this.isFaultWindowOpen(matchId) : true,
        };
      default:
        return { teamCode: false, ready: false, finished: false, cancel: false, vote: false, copyCode: false, faultButtons: false };
    }
  }

  /** Whether the fault-report window is still open for a cancelled match. */
  private isFaultWindowOpen(matchId: string): boolean {
    const deadline = this.ctx.db.repos.deadlines.get(matchId, 'fault_report');
    if (!deadline) return true;
    return new Date(deadline.due_at).getTime() > Date.now();
  }

  private setMatchStatus(matchId: string, status: MatchRow['status']): void {
    this.ctx.db.repos.matches.updateStatus(matchId, status);
  }

  private async notifyStaff(text: string): Promise<void> {
    const channelId = this.ctx.settings.queueChannelId;
    if (!channelId) return;
    const channel = this.ctx.client.channels.cache.get(channelId);
    if (!channel || !(channel instanceof TextChannel)) return;
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  }

  private async notify(matchId: string, text: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  }
}

function seriesScore(match: MatchRow, winner: VoteChoice): { scoreA: number; scoreB: number } {
  if (winner === 'draw') {
    return { scoreA: 1, scoreB: 1 };
  }
  const winningScore = match.format === 'best_of_3' ? 2 : 1;
  return winner === 'A' ? { scoreA: winningScore, scoreB: 0 } : { scoreA: 0, scoreB: winningScore };
}