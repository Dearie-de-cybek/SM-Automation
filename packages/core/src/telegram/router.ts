// Telegram update router (port of builder/code/router/*). One entry point, called by
// the telegram.update job after the webhook stored the update in webhook_events.
// Every state change is a conditional UPDATE, so a replayed update is a no-op.

import type { Sql } from '../db/client';
import type { Channel, ChatSessionMode, MediaItem } from '../domain/types';
import type { LlmClient } from '../ai/types';
import { generateCaptions } from '../ai/captions';
import type { JobName, JobPayload } from '../jobs';
import type { Logger } from '../log';
import { objectKeyForMimeType, putObject, type S3Config } from '../media/s3';
import { rulesFor } from '../platform-rules';
import { getBrandProfile } from '../repos/clients';
import { listAccounts } from '../repos/accounts';
import { addVersion, createPostWithTargets } from '../repos/posts';
import { approveReply, discardReply, getReplyWithContext } from '../repos/replies';
import { LOGIN_TOKEN_TTL_SECONDS, loginUrl, mintLoginToken } from '../repos/login-tokens';
import type { TelegramApi } from './api';
import {
  buildHelpMessage,
  buildLoginLinkMessage,
  buildPostPreviewMessage,
  buildScheduleConfirmation,
  parseCallbackData,
  type TelegramMessageDraft,
} from './messages';
import { parseScheduleTime } from './schedule-time';

/** Raw Bot API update. Handlers narrow the parts they use. */
export interface TelegramUpdate {
  update_id: number;
  message?: Record<string, unknown>;
  edited_message?: Record<string, unknown>;
  channel_post?: Record<string, unknown>;
  callback_query?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TelegramRouterDeps {
  sql: Sql;
  api: TelegramApi;
  /** Null when Gemini is not configured: caption generation is refused with a message. */
  llm: LlmClient | null;
  log: Logger;
  encryptionKey: string;
  appUrl: string;
  botUsername: string;
  adminChatId: string | null;
  s3: S3Config | null;
  enqueue: <N extends JobName>(name: N, payload: JobPayload<N>) => Promise<boolean>;
}

type JsonRecord = Record<string, unknown>;

interface NormalizedUpdate {
  kind: 'callback' | 'command' | 'photo' | 'text' | 'unsupported';
  chatId: string;
  fromId: string | null;
  messageId: number | null;
  callbackId: string | null;
  callbackData: string;
  text: string;
  photoFileId: string | null;
}

interface SessionContext {
  mode: ChatSessionMode;
  postId: string | null;
  replyId: string | null;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function id(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function normalize(update: TelegramUpdate): NormalizedUpdate | null {
  const callback = record(update.callback_query);
  if (callback) {
    const message = record(callback.message);
    const chat = record(message?.chat);
    const from = record(callback.from);
    const chatId = id(chat?.id) ?? id(from?.id);
    if (!chatId) return null;
    return {
      kind: 'callback',
      chatId,
      fromId: id(from?.id),
      messageId: integer(message?.message_id),
      callbackId: text(callback.id) || null,
      callbackData: text(callback.data),
      text: '',
      photoFileId: null,
    };
  }

  const message = record(update.message);
  const chat = record(message?.chat);
  const chatId = id(chat?.id);
  if (!message || !chatId) return null;
  const from = record(message.from);
  const photos = Array.isArray(message.photo) ? message.photo.map(record).filter((item): item is JsonRecord => item !== null) : [];
  const photoFileId = photos.length ? text(photos.at(-1)?.file_id) || null : null;
  const body = (text(message.text) || text(message.caption)).trim();
  return {
    kind: photoFileId ? 'photo' : body.startsWith('/') ? 'command' : body ? 'text' : 'unsupported',
    chatId,
    fromId: id(from?.id),
    messageId: integer(message.message_id),
    callbackId: null,
    callbackData: '',
    text: body,
    photoFileId,
  };
}

async function sendDraft(api: TelegramApi, chatId: string, draft: TelegramMessageDraft): Promise<void> {
  await api.sendMessage(chatId, draft.text, {
    parseMode: draft.parseMode,
    replyMarkup: draft.replyMarkup,
    disableWebPagePreview: draft.disableWebPagePreview,
  });
}

async function clearButtons(api: TelegramApi, update: NormalizedUpdate): Promise<void> {
  if (!update.messageId) return;
  await api.editMessageReplyMarkup({ chatId: update.chatId, messageId: update.messageId }, null).catch(() => undefined);
}

async function sessionFor(sql: Sql, chatId: string): Promise<SessionContext | null> {
  const [row] = await sql<{ mode: ChatSessionMode; post_id: string | null; reply_id: string | null }[]>`
    SELECT mode, post_id, reply_id FROM chat_sessions WHERE chat_id = ${chatId}::bigint`;
  return row ? { mode: row.mode, postId: row.post_id, replyId: row.reply_id } : null;
}

async function setSession(
  sql: Sql,
  chatId: string,
  mode: ChatSessionMode,
  input: { postId?: string | null; replyId?: string | null },
): Promise<void> {
  await sql`
    INSERT INTO chat_sessions (chat_id, mode, post_id, reply_id)
    VALUES (${chatId}::bigint, ${mode}, ${input.postId ?? null}, ${input.replyId ?? null})
    ON CONFLICT (chat_id) DO UPDATE SET mode = EXCLUDED.mode, post_id = EXCLUDED.post_id,
      reply_id = EXCLUDED.reply_id, updated_at = now()`;
}

async function audit(
  sql: Sql,
  input: { clientId: string; postId?: string | null; chatId: string; action: string; detail?: Record<string, unknown> },
): Promise<void> {
  await sql`
    INSERT INTO audit_log (client_id, post_id, actor_chat_id, action, detail)
    VALUES (${input.clientId}::uuid, ${input.postId ?? null}, ${input.chatId}::bigint, ${input.action},
            ${JSON.stringify(input.detail ?? {})}::jsonb)`;
}

async function loadPostPreview(sql: Sql, clientId: string, postId: string) {
  const [row] = await sql<{
    id: string;
    brief: string;
    source_media_url: string | null;
    publish_at: Date | null;
    captions: Partial<Record<Channel, string>> | null;
  }[]>`
    SELECT p.id, p.brief, p.source_media_url, p.publish_at, v.captions
    FROM posts p JOIN post_versions v ON v.post_id = p.id AND v.version = p.current_version
    WHERE p.id = ${postId}::uuid AND p.client_id = ${clientId}::uuid`;
  return row ?? null;
}

async function sendPostPreview(deps: TelegramRouterDeps, chatId: string, clientId: string, postId: string, timezone: string): Promise<void> {
  const post = await loadPostPreview(deps.sql, clientId, postId);
  if (!post) return;
  const captions = Object.entries(post.captions ?? {})
    .filter((entry): entry is [Channel, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
    .map(([channel, caption]) => ({ channel, caption }));
  await sendDraft(deps.api, chatId, buildPostPreviewMessage({
    postId,
    brief: post.brief,
    captions,
    mediaUrl: post.source_media_url,
    timezone,
    publishAt: post.publish_at,
  }));
}

async function generatePost(
  deps: TelegramRouterDeps,
  input: { clientId: string; brief: string; photoFileId: string | null; chatId: string; feedback?: string | null; postId?: string },
): Promise<string> {
  if (!deps.llm) throw new Error('AI generation is not configured');
  const brand = await getBrandProfile(deps.sql, input.clientId);
  if (!brand) throw new Error('Business profile not found');

  let media: MediaItem[] = [];
  if (input.photoFileId) {
    if (!deps.s3) throw new Error('Media storage is not configured');
    const file = await deps.api.getFile(input.photoFileId);
    if (!file.filePath) throw new Error('Telegram did not return a downloadable photo');
    const bytes = await deps.api.downloadFile(file.filePath);
    const key = objectKeyForMimeType(input.clientId, 'image/jpeg');
    const url = await putObject(deps.s3, key, bytes, 'image/jpeg');
    media = [{ url, key, mimeType: 'image/jpeg', sizeBytes: bytes.byteLength }];
  }

  if (input.postId) {
    const postId = input.postId;
    const [existing] = await deps.sql<{
      brief: string;
      media: MediaItem[] | null;
      captions: Partial<Record<Channel, string>> | null;
    }[]>`
      SELECT p.brief, p.media, v.captions
      FROM posts p JOIN post_versions v ON v.post_id = p.id AND v.version = p.current_version
      WHERE p.id = ${postId}::uuid AND p.client_id = ${input.clientId}::uuid`;
    if (!existing) throw new Error('Draft not found');
    const targets = await deps.sql<{ channel: Channel }[]>`
      SELECT DISTINCT channel FROM post_targets WHERE post_id = ${postId}::uuid`;
    const channels = targets.map(({ channel }) => channel);
    const result = await generateCaptions(deps.llm, {
      brand,
      knowledge: [],
      brief: existing.brief,
      channels,
      feedback: input.feedback ?? null,
      previous: existing.captions ?? null,
      imageUrls: (existing.media ?? []).map(({ url }) => url),
      hasMedia: (existing.media ?? []).length > 0,
    });
    await addVersion(deps.sql, postId, { captions: result.captions, feedback: input.feedback ?? null });
    await deps.sql.begin(async (tx) => {
      await tx`UPDATE posts SET status = 'pending_approval', error = NULL, updated_at = now() WHERE id = ${postId}::uuid`;
      for (const [channel, caption] of Object.entries(result.captions)) {
        if (typeof caption !== 'string') continue;
        await tx`
          UPDATE post_targets SET caption = ${caption}, status = 'draft', error = NULL, error_kind = NULL,
            next_attempt_at = NULL, updated_at = now()
          WHERE post_id = ${postId}::uuid AND channel = ${channel}`;
      }
    });
    return postId;
  }

  const accounts = await listAccounts(deps.sql, input.clientId, { statuses: ['active'] });
  const eligible = accounts.filter(({ channel }) => media.length > 0 || !rulesFor(channel).needsMedia);
  if (!eligible.length) throw new Error(accounts.length ? 'Connected channels require media for this post' : 'Connect a social account first');
  const channels = [...new Set(eligible.map(({ channel }) => channel))];
  const result = await generateCaptions(deps.llm, {
    brand,
    knowledge: [],
    brief: input.brief,
    channels,
    imageUrls: media.map(({ url }) => url),
    hasMedia: media.length > 0,
  });
  const created = await createPostWithTargets(deps.sql, {
    clientId: input.clientId,
    brief: input.brief,
    source: 'telegram',
    media,
    sourceMediaUrl: media[0]?.url ?? null,
    status: 'pending_approval',
    captions: result.captions,
    targets: eligible.map((account) => ({
      socialAccountId: account.id,
      channel: account.channel,
      caption: result.captions[account.channel] ?? '',
      status: 'draft',
    })),
  });
  await audit(deps.sql, { clientId: input.clientId, postId: created.postId, chatId: input.chatId, action: 'draft_created' });
  return created.postId;
}

async function handlePostCallback(
  deps: TelegramRouterDeps,
  update: NormalizedUpdate,
  clientId: string,
  timezone: string,
  action: string,
  postId: string,
): Promise<void> {
  if (action === 'schedule' || action === 'edit') {
    const allowed = action === 'schedule' ? ['pending_approval', 'scheduled'] : ['pending_approval'];
    const [post] = await deps.sql<{ id: string }[]>`
      SELECT id FROM posts WHERE id = ${postId}::uuid AND client_id = ${clientId}::uuid
        AND status = ANY(${allowed}::text[])`;
    if (!post) throw new Error('That draft action is no longer available');
    await setSession(deps.sql, update.chatId, action === 'schedule' ? 'awaiting_schedule' : 'awaiting_edit', { postId });
    await deps.api.sendMessage(update.chatId, action === 'schedule'
      ? `🕒 Send a time: 18:30, tomorrow 9am, 2026-12-24 18:00, or +2h.\nTimezone: ${timezone}\n/cancel to stop.`
      : '✏️ Tell me what to change. Example: “shorter, mention free delivery, fewer emojis”.\n/cancel to stop.');
    return;
  }

  if (action === 'discard') {
    const rows = await deps.sql<{ id: string }[]>`
      UPDATE posts SET status = 'rejected', publish_at = NULL, updated_at = now()
      WHERE id = ${postId}::uuid AND client_id = ${clientId}::uuid AND status IN ('pending_approval', 'scheduled')
      RETURNING id`;
    if (!rows.length) throw new Error('That draft action is no longer available');
    await deps.sql`UPDATE post_targets SET status = 'cancelled', updated_at = now() WHERE post_id = ${postId}::uuid
      AND status IN ('draft', 'scheduled', 'queued', 'failed')`;
    await audit(deps.sql, { clientId, postId, chatId: update.chatId, action: 'rejected' });
    await clearButtons(deps.api, update);
    await deps.api.sendMessage(update.chatId, '🗑 Draft discarded.');
    return;
  }

  if (action === 'regen') {
    const rows = await deps.sql<{ id: string }[]>`
      UPDATE posts SET status = 'generating', updated_at = now()
      WHERE id = ${postId}::uuid AND client_id = ${clientId}::uuid AND status = 'pending_approval'
      RETURNING id`;
    if (!rows.length) throw new Error('That draft action is no longer available');
    await deps.api.sendMessage(update.chatId, '🔁 Writing a fresh version…');
    try {
      await generatePost(deps, {
        clientId,
        postId,
        chatId: update.chatId,
        brief: '',
        photoFileId: null,
        feedback: 'Write a fresh alternative with a different hook and angle. Do not reuse the previous wording.',
      });
      await sendPostPreview(deps, update.chatId, clientId, postId, timezone);
    } catch (error: unknown) {
      await deps.sql`UPDATE posts SET status = 'draft_failed', error = ${error instanceof Error ? error.message : 'generation failed'}
        WHERE id = ${postId}::uuid AND status = 'generating'`;
      throw error;
    }
    return;
  }

  if (action === 'publish') {
    const targets: { id: string }[] = await deps.sql.begin(async (tx): Promise<{ id: string }[]> => {
      const posts = await tx<{ id: string }[]>`
        UPDATE posts SET status = 'publishing', approved_at = COALESCE(approved_at, now()), publish_at = NULL,
          error = NULL, updated_at = now()
        WHERE id = ${postId}::uuid AND client_id = ${clientId}::uuid AND status IN ('pending_approval', 'scheduled')
        RETURNING id`;
      if (!posts.length) return [];
      const claimed = await tx<{ id: string }[]>`
        UPDATE post_targets SET status = 'queued', publish_at = NULL, error = NULL, error_kind = NULL,
          next_attempt_at = NULL, updated_at = now()
        WHERE post_id = ${postId}::uuid AND status IN ('draft', 'scheduled', 'failed', 'cancelled')
        RETURNING id`;
      if (!claimed.length) throw new Error('Draft has no publishable targets');
      return claimed;
    });
    if (!targets.length) throw new Error('That draft action is no longer available');
    await audit(deps.sql, { clientId, postId, chatId: update.chatId, action: 'approved_publish_now' });
    await clearButtons(deps.api, update);
    await Promise.all(targets.map(({ id: targetId }) => deps.enqueue('publish.target', { targetId })));
    await deps.api.sendMessage(update.chatId, '🚀 Publishing now…');
    return;
  }

  throw new Error('Unknown draft action');
}

async function handleReplyCallback(
  deps: TelegramRouterDeps,
  update: NormalizedUpdate,
  clientId: string,
  action: string,
  replyId: string,
): Promise<void> {
  const context = await getReplyWithContext(deps.sql, replyId);
  if (!context || context.clientId !== clientId) throw new Error('That reply action is no longer available');
  if (action === 'edit') {
    await setSession(deps.sql, update.chatId, 'awaiting_reply_edit', { replyId });
    await deps.api.sendMessage(update.chatId, '✏️ Send the reply you want to use.\n/cancel to stop.');
    return;
  }
  if (action === 'ignore') {
    if (!await discardReply(deps.sql, clientId, replyId)) throw new Error('That reply action is no longer available');
    await clearButtons(deps.api, update);
    await deps.api.sendMessage(update.chatId, 'Ignored. No reply was sent.');
    return;
  }
  if (action === 'send') {
    if (!await approveReply(deps.sql, { replyId, clientId, approvedBy: `telegram:${update.fromId ?? update.chatId}` })) {
      throw new Error('That reply action is no longer available');
    }
    await clearButtons(deps.api, update);
    await deps.enqueue('reply.send', { replyId });
    await deps.api.sendMessage(update.chatId, '✅ Reply approved and queued.');
    return;
  }
  throw new Error('Unknown reply action');
}

export async function handleTelegramUpdate(deps: TelegramRouterDeps, rawUpdate: TelegramUpdate): Promise<void> {
  const update = normalize(rawUpdate);
  if (!update) return;
  const [context] = await deps.sql<{
    client_id: string | null;
    client_name: string | null;
    timezone: string | null;
  }[]>`
    SELECT c.id AS client_id, c.name AS client_name, c.timezone
    FROM (SELECT 1) seed
    LEFT JOIN clients c ON c.telegram_chat_id = ${update.chatId}::bigint AND c.active`;
  let clientId = context?.client_id ?? null;
  let clientName = context?.client_name ?? null;
  let timezone = context?.timezone ?? 'UTC';
  const isAdmin = deps.adminChatId !== null && update.chatId === deps.adminChatId;

  const commandMatch = update.kind === 'command' ? /^(\/[^\s@]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(update.text) : null;
  const command = commandMatch?.[1]?.toLowerCase() ?? null;
  const argument = commandMatch?.[2]?.trim() ?? '';

  if (command === '/start' && argument.startsWith('link_')) {
    const linkCode = argument.slice(5);
    const [linked] = await deps.sql<{ id: string; name: string; timezone: string }[]>`
      UPDATE clients SET telegram_chat_id = ${update.chatId}::bigint, telegram_link_code = NULL, updated_at = now()
      WHERE telegram_link_code = ${linkCode} AND active
        AND NOT EXISTS (SELECT 1 FROM clients WHERE telegram_chat_id = ${update.chatId}::bigint)
      RETURNING id, name, timezone`;
    if (!linked) {
      await deps.api.sendMessage(update.chatId, 'That link is invalid, already used, or this chat is connected already.');
      return;
    }
    clientId = linked.id;
    clientName = linked.name;
    timezone = linked.timezone;
    const token = await mintLoginToken(deps.sql, { clientId, chatId: update.chatId });
    await deps.api.sendMessage(update.chatId, `✅ Connected to ${clientName}.`);
    await sendDraft(deps.api, update.chatId, buildLoginLinkMessage({
      url: loginUrl(deps.appUrl, token.token),
      expiresInMinutes: Math.round(LOGIN_TOKEN_TTL_SECONDS / 60),
    }));
    return;
  }

  if (command === '/dashboard' || command === '/login' || (command === '/start' && argument === 'login')) {
    if (!clientId && !isAdmin) {
      await deps.api.sendMessage(update.chatId, `This chat is not connected. Create an account: ${new URL('/signup', deps.appUrl)}`);
      return;
    }
    const token = await mintLoginToken(deps.sql, { clientId, chatId: update.chatId, isAdmin });
    await sendDraft(deps.api, update.chatId, buildLoginLinkMessage({
      url: loginUrl(deps.appUrl, token.token),
      expiresInMinutes: Math.round(LOGIN_TOKEN_TTL_SECONDS / 60),
    }));
    return;
  }

  if (!clientId) {
    await deps.api.sendMessage(update.chatId, `This chat is not connected. Create an account: ${new URL('/signup', deps.appUrl)}`);
    return;
  }

  if (update.kind === 'callback') {
    if (update.callbackId) await deps.api.answerCallbackQuery(update.callbackId).catch(() => undefined);
    const parsed = parseCallbackData(update.callbackData);
    try {
      if (!parsed) throw new Error('That button is invalid or expired');
      if (parsed.scope === 'p') await handlePostCallback(deps, update, clientId, timezone, parsed.action, parsed.id);
      else await handleReplyCallback(deps, update, clientId, parsed.action, parsed.id);
    } catch (error: unknown) {
      deps.log.warn('telegram callback refused', { clientId, error });
      await deps.api.sendMessage(update.chatId, error instanceof Error ? error.message : 'That action is no longer available');
    }
    return;
  }

  if (command === '/cancel') {
    await deps.sql`DELETE FROM chat_sessions WHERE chat_id = ${update.chatId}::bigint`;
    await deps.api.sendMessage(update.chatId, 'Okay, cancelled. Your last draft buttons still work.');
    return;
  }

  const session = await sessionFor(deps.sql, update.chatId);
  if (update.kind === 'text' && session?.mode === 'awaiting_schedule' && session.postId) {
    const parsed = parseScheduleTime(update.text, timezone);
    if (!parsed.ok) {
      await deps.api.sendMessage(update.chatId, `I could not use that time: ${parsed.reason}. Try 18:30, tomorrow 9am, or +2h.`);
      return;
    }
    const rows = await deps.sql.begin(async (tx) => {
      await tx`DELETE FROM chat_sessions WHERE chat_id = ${update.chatId}::bigint`;
      const posts = await tx<{ id: string }[]>`
        UPDATE posts SET status = 'scheduled', publish_at = ${parsed.publishAt}, approved_at = now(), updated_at = now()
        WHERE id = ${session.postId}::uuid AND client_id = ${clientId}::uuid AND status IN ('pending_approval', 'scheduled')
        RETURNING id`;
      if (!posts.length) return [];
      const scheduled = await tx<{ id: string }[]>`
        UPDATE post_targets SET status = 'scheduled', publish_at = ${parsed.publishAt}, updated_at = now()
        WHERE post_id = ${session.postId}::uuid AND status IN ('draft', 'scheduled') RETURNING id`;
      if (!scheduled.length) throw new Error('Draft has no schedulable targets');
      return scheduled;
    });
    if (!rows.length) {
      await deps.api.sendMessage(update.chatId, 'That draft is no longer available.');
      return;
    }
    await audit(deps.sql, {
      clientId,
      postId: session.postId,
      chatId: update.chatId,
      action: 'approved_scheduled',
      detail: { publishAt: parsed.publishAt.toISOString() },
    });
    await sendDraft(deps.api, update.chatId, buildScheduleConfirmation({
      postId: session.postId,
      publishAt: parsed.publishAt,
      timezone,
    }));
    return;
  }

  if (update.kind === 'text' && session?.mode === 'awaiting_edit' && session.postId) {
    await deps.sql`DELETE FROM chat_sessions WHERE chat_id = ${update.chatId}::bigint`;
    await deps.api.sendMessage(update.chatId, '✏️ Revising the draft…');
    try {
      await generatePost(deps, {
        clientId,
        postId: session.postId,
        chatId: update.chatId,
        brief: '',
        photoFileId: null,
        feedback: update.text,
      });
      await sendPostPreview(deps, update.chatId, clientId, session.postId, timezone);
    } catch (error: unknown) {
      await deps.api.sendMessage(update.chatId, `Could not revise that draft: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return;
  }

  if (update.kind === 'text' && session?.mode === 'awaiting_reply_edit' && session.replyId) {
    await deps.sql`DELETE FROM chat_sessions WHERE chat_id = ${update.chatId}::bigint`;
    const approved = await approveReply(deps.sql, {
      replyId: session.replyId,
      clientId,
      approvedBy: `telegram:${update.fromId ?? update.chatId}`,
      text: update.text,
    });
    if (!approved) {
      await deps.api.sendMessage(update.chatId, 'That reply is no longer available.');
      return;
    }
    await deps.enqueue('reply.send', { replyId: session.replyId });
    await deps.api.sendMessage(update.chatId, '✅ Edited reply approved and queued.');
    return;
  }

  const brief = command === '/new' || command === '/post' ? argument : update.text;
  if ((update.kind === 'photo' || update.kind === 'text' || ((command === '/new' || command === '/post') && brief)) && brief) {
    await deps.api.sendMessage(update.chatId, '✍️ Drafting your post…');
    try {
      const postId = await generatePost(deps, {
        clientId,
        brief,
        photoFileId: update.photoFileId,
        chatId: update.chatId,
      });
      await sendPostPreview(deps, update.chatId, clientId, postId, timezone);
    } catch (error: unknown) {
      deps.log.error('telegram draft failed', { clientId, error });
      await deps.api.sendMessage(update.chatId, `Could not create that draft: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return;
  }

  const hasAccounts = (await listAccounts(deps.sql, clientId, { statuses: ['active'] })).length > 0;
  await sendDraft(deps.api, update.chatId, buildHelpMessage({ botUsername: deps.botUsername, hasAccounts }));
}
