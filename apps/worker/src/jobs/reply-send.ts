// Send one approved reply through its provider (at most once; claim before the call).
import type { ParsedJobPayload } from '@sm/core/jobs';
import { markReplyFailed, markReplySent, claimReplyForSend } from '@sm/core/repos/replies';
import {
  YOUTUBE_DAILY_QUOTA,
  YOUTUBE_OPERATION_COST,
  YOUTUBE_QUOTA_METRIC,
} from '@sm/core/providers/youtube';
import { consumeSystemCounter } from '@sm/core/usage';
import type { WorkerDeps } from '../deps';
import { classifyAndReport, loadProviderHandle, type ProviderHandle } from '../lib/provider-context';

export async function replySend(deps: WorkerDeps, payload: ParsedJobPayload<'reply.send'>): Promise<void> {
  const reply = await claimReplyForSend(deps.sql, payload.replyId);
  if (!reply) return;
  let handle: ProviderHandle | null = null;
  try {
    handle = await loadProviderHandle(deps, reply.account.id);
    if (!handle) throw new Error('Social account no longer exists');
    if (!handle.capabilities.replyComments || !handle.provider.reply) {
      throw new Error(`${handle.provider.id} does not support comment replies for ${reply.account.channel}`);
    }
    if (handle.provider.id === 'youtube') {
      const reserved = await consumeSystemCounter(
        deps.sql,
        YOUTUBE_QUOTA_METRIC,
        YOUTUBE_OPERATION_COST.reply,
        YOUTUBE_DAILY_QUOTA,
      );
      if (!reserved) throw new Error('YouTube daily quota is exhausted');
    }
    const result = await handle.provider.reply(handle.ctx, {
      commentExternalId: reply.comment.externalId,
      postExternalId: reply.comment.postExternalId,
      parentExternalId: reply.comment.parentExternalId,
    }, reply.text);
    await markReplySent(deps.sql, reply.id, { externalId: result.externalId });
    await deps.enqueue('notify.telegram', { clientId: reply.clientId, kind: 'reply_sent', refId: reply.id }, {
      dedupeBucket: reply.id,
    });
  } catch (error: unknown) {
    const classified = await classifyAndReport(deps, handle, error, 'Could not send reply.');
    const status = await markReplyFailed(deps.sql, reply.id, {
      error: classified.message,
      kind: classified.kind,
      safeToRetry: classified.safeToRetry,
    });
    deps.log.error('reply send failed', { replyId: reply.id, status, kind: classified.kind, error: classified.message });
    if (classified.safeToRetry && status === 'approved') throw error;
  }
}
