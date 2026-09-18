// Outbound bot notification (publish result, reply review, connection alert).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { Channel } from '@sm/core/domain/types';
import {
  buildConnectionAlertMessage,
  buildPublishOutcomeMessage,
  buildReplyReviewMessage,
  type TelegramMessageDraft,
} from '@sm/core/telegram/messages';
import { buildContentReadyMessage, buildKnowledgeReadyMessage, buildReplySentMessage } from '../lib/notify';
import type { WorkerDeps } from '../deps';

async function draftFor(
  deps: WorkerDeps,
  payload: ParsedJobPayload<'notify.telegram'>,
): Promise<TelegramMessageDraft | null> {
  const refId = payload.refId;
  if (!refId) return null;

  if (payload.kind === 'post_published' || payload.kind === 'post_failed') {
    const targets = await deps.sql<{
      channel: Channel;
      status: 'published' | 'failed' | 'cancelled' | 'draft' | 'scheduled' | 'queued' | 'publishing';
      permalink: string | null;
      error: string | null;
    }[]>`
      SELECT channel, status, permalink, error FROM post_targets
      WHERE post_id = ${refId}::uuid AND client_id = ${payload.clientId}::uuid ORDER BY channel`;
    const terminal = targets.filter((target): target is typeof target & { status: 'published' | 'failed' | 'cancelled' } =>
      target.status === 'published' || target.status === 'failed' || target.status === 'cancelled');
    return terminal.length ? buildPublishOutcomeMessage({ postId: refId, results: terminal, timezone: 'UTC' }) : null;
  }

  if (payload.kind === 'reply_review') {
    const [row] = await deps.sql<{
      id: string;
      channel: Channel;
      author_name: string | null;
      comment_text: string;
      reply_text: string;
      confidence: number | null;
      permalink: string | null;
      classification: Record<string, unknown> | null;
    }[]>`
      SELECT r.id, c.channel, c.author_name, c.text AS comment_text, r.text AS reply_text,
        r.confidence, c.permalink, c.classification
      FROM comment_replies r JOIN comments c ON c.id = r.comment_id
      WHERE r.id = ${refId}::uuid AND r.client_id = ${payload.clientId}::uuid AND r.status = 'draft'`;
    if (!row) return null;
    const flags = row.classification?.riskFlags;
    const reasons = Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === 'string') : [];
    return buildReplyReviewMessage({
      replyId: row.id,
      channel: row.channel,
      authorName: row.author_name,
      commentText: row.comment_text,
      suggestedReply: row.reply_text,
      reasons,
      confidence: row.confidence,
      permalink: row.permalink,
    });
  }

  if (payload.kind === 'reply_sent') {
    const [row] = await deps.sql<{ channel: Channel; author_name: string | null; reply_text: string; permalink: string | null }[]>`
      SELECT c.channel, c.author_name, r.text AS reply_text, c.permalink
      FROM comment_replies r JOIN comments c ON c.id = r.comment_id
      WHERE r.id = ${refId}::uuid AND r.client_id = ${payload.clientId}::uuid AND r.status = 'sent'`;
    return row ? buildReplySentMessage({
      channel: row.channel,
      authorName: row.author_name,
      replyText: row.reply_text,
      permalink: row.permalink,
    }) : null;
  }

  if (payload.kind === 'connection_needs_reauth') {
    const [row] = await deps.sql<{ provider: string; label: string | null; last_error: string | null }[]>`
      SELECT provider, label, last_error FROM provider_connections
      WHERE id = ${refId}::uuid AND client_id = ${payload.clientId}::uuid`;
    return row ? buildConnectionAlertMessage({
      provider: row.provider,
      label: row.label,
      reason: row.last_error ?? 'Authorization expired.',
      settingsUrl: new URL('/settings', deps.env.APP_URL).toString(),
    }) : null;
  }

  if (payload.kind === 'knowledge_ready') {
    const [row] = await deps.sql<{ title: string; pages_count: number; chunks_count: number }[]>`
      SELECT title, pages_count, chunks_count FROM knowledge_sources
      WHERE id = ${refId}::uuid AND client_id = ${payload.clientId}::uuid AND status = 'ready'`;
    return row ? buildKnowledgeReadyMessage({
      title: row.title,
      pages: row.pages_count,
      chunks: row.chunks_count,
      knowledgeUrl: new URL('/knowledge', deps.env.APP_URL).toString(),
    }) : null;
  }

  if (payload.kind === 'content_ready') {
    const [row] = await deps.sql<{ goal: string; created_post_ids: string[] }[]>`
      SELECT goal, created_post_ids FROM content_requests
      WHERE id = ${refId}::uuid AND client_id = ${payload.clientId}::uuid AND status = 'done'`;
    return row ? buildContentReadyMessage({
      goal: row.goal,
      postCount: row.created_post_ids.length,
      postsUrl: new URL('/posts', deps.env.APP_URL).toString(),
    }) : null;
  }

  return null;
}

export async function notifyTelegram(deps: WorkerDeps, payload: ParsedJobPayload<'notify.telegram'>): Promise<void> {
  const api = deps.telegram();
  if (!api) return;
  const [client] = await deps.sql<{ telegram_chat_id: string | null }[]>`
    SELECT telegram_chat_id::text AS telegram_chat_id FROM clients
    WHERE id = ${payload.clientId}::uuid AND active`;
  if (!client?.telegram_chat_id) return;
  const draft = await draftFor(deps, payload);
  if (!draft) return;
  await api.sendMessage(client.telegram_chat_id, draft.text, {
    parseMode: draft.parseMode,
    replyMarkup: draft.replyMarkup,
    disableWebPagePreview: draft.disableWebPagePreview,
  });
}
