// Hand one stored Telegram update to the application router.
import type { ParsedJobPayload } from '@sm/core/jobs';
import { claimWebhookEvent, markWebhookFailed, markWebhookProcessed } from '@sm/core/repos/webhooks';
import { handleTelegramUpdate, type TelegramUpdate } from '@sm/core/telegram/router';
import type { WorkerDeps } from '../deps';

export async function telegramUpdate(deps: WorkerDeps, payload: ParsedJobPayload<'telegram.update'>): Promise<void> {
  const event = await claimWebhookEvent(deps.sql, payload.eventId);
  if (!event) return;
  if (event.provider !== 'telegram') {
    await markWebhookFailed(deps.sql, payload.eventId, `telegram.update received ${event.provider} event`);
    return;
  }

  const api = deps.telegram();
  if (!api) {
    const error = new Error('Telegram bot is not configured');
    await markWebhookFailed(deps.sql, payload.eventId, error.message);
    throw error;
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    await markWebhookFailed(deps.sql, payload.eventId, 'Invalid Telegram update payload');
    return;
  }
  const update = event.payload as TelegramUpdate;
  if (!Number.isSafeInteger(update.update_id)) {
    await markWebhookFailed(deps.sql, payload.eventId, 'Telegram update_id is missing');
    return;
  }

  try {
    await handleTelegramUpdate({
      sql: deps.sql,
      api,
      llm: deps.llm(),
      log: deps.log,
      encryptionKey: deps.encryptionKey,
      appUrl: deps.env.APP_URL,
      botUsername: deps.env.TELEGRAM_BOT_USERNAME ?? 'social_automation_bot',
      adminChatId: deps.env.ADMIN_TELEGRAM_CHAT_ID ?? null,
      s3: deps.s3,
      enqueue: (name, data) => deps.enqueue(name, data),
    }, update);
    await markWebhookProcessed(deps.sql, payload.eventId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Telegram update failed';
    await markWebhookFailed(deps.sql, payload.eventId, message);
    throw error;
  }
}
