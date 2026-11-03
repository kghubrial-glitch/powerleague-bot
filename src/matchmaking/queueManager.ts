import { TextChannel, Message, DMChannel } from 'discord.js';
import { AppContext } from '../context';
import { queueEmbed, queueActionRows, prettyMatchId } from '../format';
import { parseDbTimestamp } from '../presentation/dbTime';
import { Mutex } from '../services/mutex';
import { QueueEntryRow } from '../types';

export interface QueueDependencies {
  /** Invoked exactly once the queue reaches the configured size. */
  onFull: (entries: QueueEntryRow[]) => Promise<void>;
}

/**
 * Persistent queue backed by the database. Matchmaking trigger is serialized
 * through an in-process mutex plus a guarded DB check so two concurrent
 * handlers can never process the same full queue twice.
 */
export class QueueManager {
  private mutex = new Mutex();
  /** Guards the message/embeds/buttons roundtrip from mid-flight races. */
  private panelLock = false;

  constructor(private ctx: AppContext, private deps: QueueDependencies) {}

  entries(): QueueEntryRow[] {
    return this.ctx.db.repos.queue.list();
  }

  async join(discordId: string, username: string): Promise<{ ok: boolean; error?: string; size?: number }> {
    return this.mutex.run(async () => {
      const settings = this.ctx.settings;
      if (this.ctx.db.repos.queue.get(discordId)) {
        return { ok: false, error: 'You are already in the queue.' };
      }
      const active = this.ctx.db.repos.matches.getActiveByPlayer(discordId);
      if (active) {
        return {
          ok: false,
          error: `You are still in active match **${prettyMatchId(active.match_id)}**. You cannot queue while in a match.`,
        };
      }
      const user = this.ctx.db.repos.users.ensureUser(discordId, username);
      if (settings.minElo !== undefined && user.elo < settings.minElo) {
        return { ok: false, error: `Your Elo (${user.elo}) is below the minimum (${settings.minElo}).` };
      }
      if (settings.maxElo !== undefined && user.elo > settings.maxElo) {
        return { ok: false, error: `Your Elo (${user.elo}) is above the maximum (${settings.maxElo}).` };
      }
      const cooldown = this.ctx.db.repos.cooldowns.active(discordId, new Date().toISOString());
      if (cooldown) {
        return {
          ok: false,
          error: `You are on a matchmaking cooldown until ${cooldown.until}.${cooldown.reason ? ` Reason: ${cooldown.reason}` : ''}`,
        };
      }
      const entry = { discord_id: discordId, username, elo_at_join: user.elo };
      this.ctx.db.repos.queue.add(entry);
      await this.refreshPanel();
      const size = this.ctx.db.repos.queue.count();
      if (size >= settings.queueSize) {
        await this.triggerMatchmaking();
      }
      return { ok: true, size: this.ctx.db.repos.queue.count() };
    });
  }

  async leave(discordId: string): Promise<{ ok: boolean; error?: string }> {
    return this.mutex.run(async () => {
      const removed = this.ctx.db.repos.queue.remove(discordId);
      if (!removed) {
        return { ok: false, error: 'You are not in the queue.' };
      }
      await this.refreshPanel();
      return { ok: true };
    });
  }

  async refreshPanel(): Promise<void> {
    if (this.panelLock) return; // avoid overlapping edits
    this.panelLock = true;
    try {
      const state = this.ctx.db.repos.panels.get();
      if (!state?.channel_id || !state?.message_id) return;
      const channel = this.ctx.client.channels.cache.get(state.channel_id);
      if (!channel || !(channel instanceof TextChannel)) return;
      const enabledMaps = this.ctx.db.repos.maps.enabled().length;
      const embed = () => queueEmbed(this.entries(), this.ctx.settings, enabledMaps);
      let message: Message;
      try {
        message = await channel.messages.fetch(state.message_id);
      } catch {
        // Panel message deleted: create a fresh one.
        const created = await channel.send({
          embeds: [embed()],
          components: queueActionRows(),
        });
        this.ctx.db.repos.panels.set(channel.id, created.id);
        return;
      }
      await message.edit({
        embeds: [embed()],
        components: queueActionRows(),
      });
    } finally {
      this.panelLock = false;
    }
  }

  /** Called on boot to reveal a panel that was created before a restart. */
  async reconcilePanel(): Promise<void> {
    await this.refreshPanel();
  }

  isInQueue(discordId: string): boolean {
    return this.ctx.db.repos.queue.get(discordId) !== undefined;
  }

  /**
   * Removes players who have been in the queue past `queueInactiveAfter`
   * without a match starting. They are told why via DM (falling back to the
   * queue channel), and the panel + staff channel are refreshed. This runs on
   * a periodic sweep (see index.ts) so it also works while nobody clicks.
   */
  async sweepStale(): Promise<void> {
    const seconds = this.ctx.settings.queueInactiveAfter;
    if (!seconds || seconds <= 0) return;
    await this.mutex.run(async () => {
      const cutoff = Date.now() - seconds * 1000;
      const stale = this.ctx.db.repos.queue.list().filter((e) => parseDbTimestamp(e.joined_at) < cutoff);
      if (stale.length === 0) return;
      for (const entry of stale) {
        this.ctx.db.repos.queue.remove(entry.discord_id);
        await this.notifyLeft(entry, 'You were removed from the scrim queue: no match started within the wait limit.');
      }
      await this.refreshPanel();
    });
  }

  /** Notifies a removed player in DMs, falling back to the queue channel. */
  private async notifyLeft(entry: QueueEntryRow, message: string): Promise<void> {
    const user = await this.ctx.client.users.fetch(entry.discord_id).catch(() => null);
    let channel: DMChannel | TextChannel | null = null;
    if (user) {
      channel = (await user.createDM().catch(() => null)) ?? null;
    }
    if (!channel && this.ctx.settings.queueChannelId) {
      const ch = this.ctx.client.channels.cache.get(this.ctx.settings.queueChannelId);
      if (ch instanceof TextChannel) channel = ch;
    }
    if (!channel) return;
    await channel
      .send({
        content: `⏳ ${message}\nYou can rejoin anytime with the **Join Queue** button.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  private async triggerMatchmaking(): Promise<void> {
    // In-process serialization (mutex) already prevents races, but this
    // transaction also guarantees the claim is atomic.
    const claimed = this.ctx.db.repos.transaction<QueueEntryRow[] | null>(() => {
      const size = this.ctx.db.repos.queue.count();
      if (size < this.ctx.settings.queueSize) return null;
      const entries = this.ctx.db.repos.queue.list().slice(0, this.ctx.settings.queueSize);
      this.ctx.db.repos.queue.removeBySet(entries.map((e) => e.discord_id));
      return entries;
    });
    if (!claimed) return;
    await this.refreshPanel();
    await this.deps.onFull(claimed);
  }
}