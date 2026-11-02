import { EmbedBuilder, TextChannel, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder, Message } from 'discord.js';
import { AppContext } from '../context';
import { MatchRow, QueueEntryRow, VoteChoice } from '../types';
import { generateBalancedTeams } from '../matchmaking/teamBalancer';
import { selectMap } from '../matchmaking/mapSelector';
import { computeTeamEloChanges } from '../elo/eloCalculator';
import { rankForElo } from '../elo/rankManager';
import { buildMatchEmbed, matchActionRows, winnerLabel } from '../format';
import { evaluateVotes, VoteRecord } from './resultVoting';
import { Mutex } from '../services/mutex';

const CATEGORY_NAME = '⚔️ Scrims';
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
        name: `scrim-${matchId.replace('scrim-', '')}`,
        type: ChannelType.GuildText,
        parent: category,
      });

      // Lock down the channel to just participants + staff + bot.
      await channel.permissionOverwrites.create(guild.roles.everyone, { ViewChannel: false });
      if (settings.staffRoleId) {
        const role = guild.roles.cache.get(settings.staffRoleId) ?? (await guild.roles.fetch(settings.staffRoleId).catch(() => null));
        if (role) {
          await channel.permissionOverwrites.create(role, { ViewChannel: true });
        }
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

      this.scheduleTeamCodeDeadline(matchId);
      return created;
    });
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
      components: matchActionRows(this.actionsForStatus(match.status)),
    });
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
      .setTitle(`TEAM CODE SUBMITTED — #${matchId.replace('scrim-', '')}`)
      .setColor(0x57f287)
      .setDescription(
        `Code: \`${match.team_code}\`\n\nAll six players, join the in-game team using the code above.\nSubmitted by: **${submitter}**`
      )
      .setFooter({ text: 'The code stays visible only in this private channel.' });

    const copyCode = new ButtonBuilder()
      .setCustomId(`match:copycode:${matchId}`)
      .setLabel('COPY / VIEW CODE')
      .setStyle(ButtonStyle.Secondary);
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
        `All **${participants.length}** players are ready. The match has **started** — Good luck! ` +
          `First team to win ${match.format === 'best_of_3' ? 'two games' : 'one game'} wins the series.`
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
      .setTitle(`MATCH RESULT — #${matchId.replace('scrim-', '')}`)
      .setColor(0xfee75c)
      .setDescription(
        'Has the match ended?\n\nSelect the winning team. Votes are **private** until voting is completed.\n\n' +
          `**Rule:** a result requires **${REQUIRED_VOTE_COUNT} of 6** votes for the same outcome, including at least one vote from each team.`
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`vote:A:${matchId}`).setLabel('TEAM A WON').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`vote:B:${matchId}`).setLabel('TEAM B WON').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`vote:draw:${matchId}`).setLabel('DRAW').setStyle(ButtonStyle.Secondary)
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

      this.ctx.db.repos.transaction(() => {
        const now = new Date().toISOString();
        this.applyEloToTeam(teamA, matchId, outcomeA, changes.teamAChange, now);
        const outcomeB: 'win' | 'loss' | 'draw' = outcomeA === 'win' ? 'loss' : outcomeA === 'loss' ? 'win' : 'draw';
        this.applyEloToTeam(teamB, matchId, outcomeB, changes.teamBChange, now);
        this.ctx.db.repos.matches.confirmResult(matchId, winner, scoreA, scoreB);
      });

      this.ctx.timers.cancelAllForMatch(matchId);
      await this.announceResult(matchId, winner);
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

  private applyEloToTeam(
    ids: string[],
    matchId: string,
    outcome: 'win' | 'loss' | 'draw',
    change: number,
    timestamp: string
  ): void {
    for (const id of ids) {
      const user = this.ctx.db.repos.users.getById(id);
      if (!user) continue;
      this.ctx.db.repos.users.applyEloChange(id, matchId, user.elo, change, outcome, timestamp);
    }
  }

  private async announceResult(matchId: string, winner: VoteChoice): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match?.channel_id) return;
    const channel = this.ctx.client.channels.cache.get(match.channel_id);
    if (!channel || !(channel instanceof TextChannel)) return;
    const embed = new EmbedBuilder()
      .setTitle(`RESULT CONFIRMED — #${matchId.replace('scrim-', '')}`)
      .setColor(0x57f287)
      .setDescription(
        `Winner: **${winnerLabel(winner)}**\n\n` +
          `Final score:\n**TEAM A: ${match.team_a_score}**\n**TEAM B: ${match.team_b_score}**\n\n` +
          'Elo has been updated for all participating players.'
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
      `Match **#${matchId.replace('scrim-', '')}** was marked **disputed**: ${reason}\n` +
        'An administrator can confirm, correct or cancel this match with `/scrim result` or `/scrim cancel`.'
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
      .setTitle(`MATCH CANCELLED — #${matchId.replace('scrim-', '')}`)
      .setColor(0xed4245)
      .setDescription(`Reason: **${reason}**\n\nWhat happened to the match? Let us know below.`);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('fault:select').setLabel('REPORT WHAT HAPPENED').setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ embeds: [embed], components: [row] });
    this.scheduleFaultDeadline(matchId);
  }

  // -------------------------------------------------------------------------
  // Fault reporting
  // -------------------------------------------------------------------------

  faultReasons(): FaultReasonDef[] {
    return FAULT_REASONS;
  }

  async submitFault(
    matchId: string,
    reporterId: string,
    reportedId: string | null,
    reason: string
  ): Promise<{ ok: boolean; error?: string }> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return { ok: false, error: 'Match not found.' };
    if (!this.ctx.db.repos.matches.isParticipant(match, reporterId)) {
      return { ok: false, error: 'Only participants can report.' };
    }
    if (reportedId) {
      if (reportedId === reporterId) return { ok: false, error: 'You cannot report yourself.' };
      const inserted = this.ctx.db.repos.faults.add({
        match_id: matchId,
        reporter_id: reporterId,
        reported_player_id: reportedId,
        reason,
      });
      if (!inserted) return { ok: false, error: 'You have already reported this player for this match.' };
      await this.processFaultReport(matchId, reportedId);
    } else {
      this.ctx.db.repos.audits.log({
        action: 'fault_category',
        match_id: matchId,
        target_id: reporterId,
        details: JSON.stringify({ reason }),
      });
      await this.notify(matchId, `Report recorded: **${reason}**. Staff will review.`);
    }
    this.scheduleFaultDeadline(matchId);
    return { ok: true };
  }

  private async processFaultReport(matchId: string, reportedId: string): Promise<void> {
    const match = this.ctx.db.repos.matches.get(matchId);
    if (!match) return;
    const teamA = this.ctx.db.repos.matches.teamAIds(match);
    const teamB = this.ctx.db.repos.matches.teamBIds(match);

    const reports = this.ctx.db.repos.faults.forMatch(matchId).filter(
      (r) => r.reported_player_id === reportedId && r.reporter_id !== reportedId
    );
    const count = reports.length;
    if (count >= REQUIRED_VOTE_COUNT) {
      const reporterTeams = new Set(
        reports.map((r) => (teamA.includes(r.reporter_id) ? 'A' : teamB.includes(r.reporter_id) ? 'B' : '?'))
      );
      if (reporterTeams.size >= 2) {
        this.ctx.db.repos.faults.addDodge({
          match_id: matchId,
          reported_player_id: reportedId,
          reports: count,
          status: 'awaiting_moderator',
        });
        await this.notifyStaff(
          `**DODGE REPORT**\n\nMatch: **#${matchId.replace('scrim-', '')}**\nReported player: <@${reportedId}>\n` +
            `Reports: ${count}\nStatus: **AWAITING MODERATOR REVIEW**`
        );
      }
    }
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
    this.ctx.db.repos.faults.addDodge({
      match_id: matchId,
      reported_player_id: reportedId,
      reports: decision === 'cooldown' ? 0 : 0,
      status: decision === 'cooldown' ? 'moderator_cooldown' : 'moderator_clear',
    });
    this.ctx.db.repos.audits.log({
      action: 'moderator_dodge_decision',
      match_id: matchId,
      administrator_id: adminId,
      target_id: reportedId,
      details: JSON.stringify({ decision, durationMinutes }),
    });
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
          await this.cancelMatch(matchId, 'Timeout: no TeamCode was submitted in time');
        }
        break;
      case 'ready':
        if (match.status === 'awaiting_ready') {
          const ready = this.ctx.db.repos.matches.readyIds(matchId);
          const participants = this.ctx.db.repos.matches.participantIds(match);
          const missing = participants.filter((id) => !ready.includes(id));
          await this.cancelMatch(matchId, 'Timeout: not all players became ready in time');
          await this.notify(
            matchId,
            `Players who were not ready: ${missing.map((id) => `<@${id}>`).join(', ') || 'none'}\nPlease report what happened.`
          );
        }
        break;
      case 'match':
        if (match.status === 'in_progress') {
          await this.cancelMatch(matchId, 'Match did not finish before the deadline', 'timed_out');
        }
        break;
      case 'vote':
        if (match.status === 'voting') {
          await this.markDisputed(matchId, 'The voting period expired without a confirmed result.');
        }
        break;
      case 'fault_report':
        await this.notify(matchId, 'The fault-reporting window has closed.');
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

    return buildMatchEmbed({
      match,
      teamA: info(teamA),
      teamB: info(teamB),
      ready,
      votesCount: votes.length,
      voteTotals: tallies,
      rankFn: (elo) => rankForElo(elo, this.ctx.settings.ranks),
      maps: [],
    });
  }

  /** Chooses which buttons are live for a given match status. */
  private actionsForStatus(status: MatchRow['status']) {
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
        return { teamCode: false, ready: false, finished: false, cancel: false, vote: false, copyCode: false, faultButtons: true };
      default:
        return { teamCode: false, ready: false, finished: false, cancel: false, vote: false, copyCode: false, faultButtons: false };
    }
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