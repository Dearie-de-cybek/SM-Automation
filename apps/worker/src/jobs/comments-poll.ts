// Pull new comments for one account and upsert them; new rows trigger comment.triage.
import type { ParsedJobPayload } from '@sm/core/jobs';
import { upsertComment } from '@sm/core/repos/comments';
import { updateCommentsCursor } from '@sm/core/repos/accounts';
import {
  YOUTUBE_DAILY_QUOTA,
  YOUTUBE_OPERATION_COST,
  YOUTUBE_POLL_BUDGET_RATIO,
  YOUTUBE_QUOTA_METRIC,
} from '@sm/core/providers/youtube';
import { consumeSystemCounter } from '@sm/core/usage';
import type { WorkerDeps } from '../deps';
import { classifyAndReport, loadProviderHandle, type ProviderHandle } from '../lib/provider-context';

export async function commentsPoll(deps: WorkerDeps, payload: ParsedJobPayload<'comments.poll'>): Promise<void> {
  let handle: ProviderHandle | null = null;
  try {
    handle = await loadProviderHandle(deps, payload.accountId);
    if (!handle) return;
    if (!handle.capabilities.readComments || !handle.provider.fetchComments) {
      await updateCommentsCursor(deps.sql, payload.accountId, handle.account.account.commentsCursor);
      return;
    }

    if (handle.provider.id === 'youtube') {
      const budget = Math.floor(YOUTUBE_DAILY_QUOTA * YOUTUBE_POLL_BUDGET_RATIO);
      const reserved = await consumeSystemCounter(
        deps.sql,
        YOUTUBE_QUOTA_METRIC,
        YOUTUBE_OPERATION_COST.fetchComments,
        budget,
      );
      if (!reserved) {
        deps.log.warn('youtube comment polling skipped: quota guard', { accountId: payload.accountId });
        return;
      }
    }

    const account = handle.account.account;
    const result = await handle.provider.fetchComments(handle.ctx, {
      cursor: account.commentsCursor,
      since: account.commentsSyncedAt,
      limit: 200,
    });

    for (const remote of result.comments) {
      const [target] = remote.postExternalId
        ? await deps.sql<{ id: string }[]>`
            SELECT id FROM post_targets
            WHERE social_account_id = ${account.id}::uuid AND external_id = ${remote.postExternalId}
            LIMIT 1`
        : [];
      const saved = await upsertComment(deps.sql, {
        clientId: account.clientId,
        socialAccountId: account.id,
        postTargetId: target?.id ?? null,
        externalId: remote.externalId,
        postExternalId: remote.postExternalId,
        parentExternalId: remote.parentExternalId,
        authorExternalId: remote.authorExternalId,
        authorName: remote.authorName,
        authorHandle: remote.authorHandle,
        text: remote.text,
        permalink: remote.permalink,
        remoteCreatedAt: remote.createdAt,
        isOwn: remote.isOwn,
      });
      if (saved.inserted) await deps.enqueue('comment.triage', { commentId: saved.id }, { dedupeBucket: saved.id });
    }
    await updateCommentsCursor(deps.sql, account.id, result.cursor, new Date());
  } catch (error: unknown) {
    const classified = await classifyAndReport(deps, handle, error, 'Could not fetch comments.');
    deps.log.error('comments poll failed', { accountId: payload.accountId, kind: classified.kind, error: classified.message });
    if (classified.safeToRetry) throw error;
  }
}
