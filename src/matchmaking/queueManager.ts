import { TextChannel, Message } from 'discord.js';
import { AppContext } from '../context';
import { queueEmbed, queueActionRows } from '../format';
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
          error: `You are still in active match ${active.match_id.replace('scrim-', '#')}. You cannot queue while in a match.`,
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