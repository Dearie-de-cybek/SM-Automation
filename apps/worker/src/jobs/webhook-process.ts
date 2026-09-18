// Turn one stored webhook delivery into domain rows (comments, status changes).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { Channel } from '@sm/core/domain/types';
import { findAccountByExternalId } from '@sm/core/repos/accounts';
import { upsertComment } from '@sm/core/repos/comments';
import { claimWebhookEvent, markWebhookFailed, markWebhookProcessed } from '@sm/core/repos/webhooks';
import type { WorkerDeps } from '../deps';

interface StoredMetaEvent {
  channel: Channel;
  accountExternalId: string;
  commentExternalId: string | null;
  parentExternalId: string | null;
  postExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  text: string | null;
  permalink: string | null;
  verb: 'add' | 'edit' | 'remove' | 'hide' | 'unhide' | 'unknown';
  createdAt: string | null;
}

function metaEvent(value: unknown): StoredMetaEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if ((input.channel !== 'facebook' && input.channel !== 'instagram') || typeof input.accountExternalId !== 'string') return null;
  const nullable = (field: string): string | null => typeof input[field] === 'string' ? input[field] as string : null;
  const verb = input.verb;
  return {
    channel: input.channel,
    accountExternalId: input.accountExternalId,
    commentExternalId: nullable('commentExternalId'),
    parentExternalId: nullable('parentExternalId'),
    postExternalId: nullable('postExternalId'),
    authorExternalId: nullable('authorExternalId'),
    authorName: nullable('authorName'),
    text: nullable('text'),
    permalink: nullable('permalink'),
    verb: verb === 'add' || verb === 'edit' || verb === 'remove' || verb === 'hide' || verb === 'unhide' ? verb : 'unknown',
    createdAt: nullable('createdAt'),
  };
}

export async function webhookProcess(deps: WorkerDeps, payload: ParsedJobPayload<'webhook.process'>): Promise<void> {
  const stored = await claimWebhookEvent(deps.sql, payload.eventId);
  if (!stored) return;
  try {
    if (stored.provider !== 'meta') {
      await markWebhookProcessed(deps.sql, stored.id);
      return;
    }
    const event = metaEvent(stored.payload);
    if (!event || !event.commentExternalId) {
      await markWebhookProcessed(deps.sql, stored.id);
      return;
    }
    const account = await findAccountByExternalId(deps.sql, event.channel, event.accountExternalId);
    if (!account) {
      deps.log.debug('meta webhook account not connected', {
        channel: event.channel,
        externalId: event.accountExternalId,
      });
      await markWebhookProcessed(deps.sql, stored.id);
      return;
    }

    if (event.verb === 'remove' || event.verb === 'hide' || event.verb === 'unhide') {
      await deps.sql`
        UPDATE comments SET
          is_hidden = ${event.verb !== 'unhide'},
          status = CASE WHEN ${event.verb} = 'remove' THEN 'ignored' ELSE status END,
          updated_at = now()
        WHERE social_account_id = ${account.id}::uuid AND external_id = ${event.commentExternalId}`;
      await markWebhookProcessed(deps.sql, stored.id);
      return;
    }

    // Instagram mention/comment webhooks can omit body fields. Poll immediately to
    // hydrate the complete comment rather than creating an unusable empty row.
    if (!event.text) {
      await deps.enqueue('comments.poll', { accountId: account.id }, { dedupeBucket: `webhook:${stored.id}` });
      await markWebhookProcessed(deps.sql, stored.id);
      return;
    }
    const [target] = event.postExternalId
      ? await deps.sql<{ id: string }[]>`
          SELECT id FROM post_targets WHERE social_account_id = ${account.id}::uuid
            AND external_id = ${event.postExternalId} LIMIT 1`
      : [];
    const remoteCreatedAt = event.createdAt ? new Date(event.createdAt) : null;
    const saved = await upsertComment(deps.sql, {
      clientId: account.clientId,
      socialAccountId: account.id,
      postTargetId: target?.id ?? null,
      externalId: event.commentExternalId,
      postExternalId: event.postExternalId,
      parentExternalId: event.parentExternalId,
      authorExternalId: event.authorExternalId,
      authorName: event.authorName,
      authorHandle: null,
      text: event.text,
      permalink: event.permalink,
      remoteCreatedAt: remoteCreatedAt && !Number.isNaN(remoteCreatedAt.getTime()) ? remoteCreatedAt : null,
      isOwn: event.authorExternalId === account.externalId,
    });
    if (saved.inserted) await deps.enqueue('comment.triage', { commentId: saved.id }, { dedupeBucket: saved.id });
    await markWebhookProcessed(deps.sql, stored.id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Meta webhook processing failed';
    await markWebhookFailed(deps.sql, stored.id, message);
    throw error;
  }
}
