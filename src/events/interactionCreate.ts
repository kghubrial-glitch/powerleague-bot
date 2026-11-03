import {
  Interaction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  MessageFlags,
} from 'discord.js';
import { AppContext } from '../context';

/**
 * Central interaction error handler.
 *
 * Any rejected interaction reaches this path. It logs a structured error with
 * the interaction id, user id, command/custom id and (if available) match id,
 * and only surfaces a generic message to the member — never a raw stack trace.
 */
export function safeReplyToError(interaction: Interaction, error: unknown, ctx?: AppContext): void {
  const errMsg = error instanceof Error ? error.message : 'Unexpected error';
  const customId =
    typeof (interaction as { customId?: unknown }).customId === 'string'
      ? (interaction as { customId: string }).customId
      : undefined;
  const commandName =
    typeof (interaction as { commandName?: unknown }).commandName === 'string'
      ? (interaction as { commandName: string }).commandName
      : undefined;

  let matchId: string | null = null;
  if (customId) {
    const part = customId.split(':')[2];
    if (part && part.startsWith('scrim-')) matchId = part;
  }

  console.error(
    JSON.stringify({
      kind: 'interaction_error',
      interactionId: interaction.id,
      userId: interaction.user?.id ?? null,
      customId: customId ?? null,
      commandName: commandName ?? null,
      matchId,
      error: errMsg,
      stack: error instanceof Error ? error.stack : undefined,
    })
  );

  if (ctx) {
    try {
      ctx.db.repos.audits.log({
        action: 'interaction_error',
        target_id: interaction.user?.id ?? null,
        match_id: matchId,
        details: JSON.stringify({
          interaction_id: interaction.id,
          custom_id: customId ?? commandName ?? null,
          error: errMsg,
        }),
      });
    } catch {
      // Database logging must never make error handling worse.
    }
  }

  // Best-effort user-facing message. If the interaction already ended (10062),
  // or the channel/message was deleted, every fallback fails silently.
  try {
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        void interaction.editReply({ content: 'An unexpected error occurred. Please try again.' }).catch(() => {});
      } else {
        void interaction.reply({ content: 'An unexpected error occurred. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  } catch {
    // Nothing actionable.
  }
}

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
        } else if (ci.commandName === 'clear') {
          await ctx.admin.handleTopLevel(ci.commandName, ci);
        } else {
          await ctx.commands.handle(ci.commandName, ci);
        }
        return;
      }
    } catch (error) {
      safeReplyToError(interaction, error, ctx);
    }
  });
}