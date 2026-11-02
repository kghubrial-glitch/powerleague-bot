import { Interaction, ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction, ModalSubmitInteraction } from 'discord.js';
import { AppContext } from '../context';

export function registerInteractionEvents(ctx: AppContext): void {
  ctx.client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isButton()) {
        await ctx.interactions.handleButton(interaction as ButtonInteraction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        await ctx.interactions.handleSelectMenu(interaction as StringSelectMenuInteraction);
        return;
      }
      if (interaction.isModalSubmit()) {
        await ctx.interactions.handleModal(interaction as ModalSubmitInteraction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        const ci = interaction as ChatInputCommandInteraction;
        if (ci.commandName === 'scrim') {
          await ctx.admin.handle(ci);
        } else {
          await ctx.commands.handle(ci.commandName, ci);
        }
        return;
      }
    } catch (error) {
      console.error('Error handling interaction:', error);
      const errMsg = error instanceof Error ? error.message : 'Internal error';
      try {
        if ((interaction as { isRepliable?: () => boolean }).isRepliable?.() ?? false) {
          const repliable = interaction as { replied: boolean; deferred: boolean; reply: (o: { content: string; ephemeral: boolean }) => Promise<unknown> };
          if (!repliable.replied && !repliable.deferred) {
            await repliable.reply({ content: `⚠️ ${errMsg}`, ephemeral: true });
          }
        }
      } catch {
        // ignore
      }
    }
  });
}