// Claim the target, publish through its provider, record the result. The conditional
// claim happens before the external call, so a replayed job is a no-op.
import { ProviderError } from '@sm/core/providers/errors';
import type { ParsedJobPayload } from '@sm/core/jobs';
import {
  claimTargetForPublish,
  markTargetFailed,
  markTargetPublished,
  markTargetPublishing,
  rollUpPostStatus,
  type ClaimedTarget,
  type MarkTargetFailedInput,
} from '@sm/core/repos/posts';
import type { PostStatus, PostTargetStatus } from '@sm/core/domain/types';
import type { WorkerDeps } from '../deps';
import { backoffSeconds, MAX_PUBLISH_ATTEMPTS, startAfterDate } from '../lib/retry';
import { classifyError } from '../lib/errors';
import {
  bufferPublishIsPending,
  loadPublishingHandle,
  type PublishingHandle,
} from '../lib/publishing';

type PublishRuntime = Pick<WorkerDeps, 'log' | 'enqueue'>;

export interface PublishTargetOperations {
  claim(targetId: string): Promise<ClaimedTarget | null>;
  loadHandle(accountId: string): Promise<PublishingHandle | null>;
  markPublishing(targetId: string, externalId: string): Promise<boolean>;
  markPublished(targetId: string, result: { externalId: string; permalink: string | null }): Promise<boolean>;
  markFailed(targetId: string, input: MarkTargetFailedInput): Promise<PostTargetStatus | null>;
  rollUp(postId: string): Promise<PostStatus | null>;
}

function defaultOperations(deps: WorkerDeps): PublishTargetOperations {
  return {
    claim: (targetId) => claimTargetForPublish(deps.sql, targetId),
    loadHandle: (accountId) => loadPublishingHandle(deps, accountId),
    markPublishing: (targetId, externalId) => markTargetPublishing(deps.sql, targetId, externalId),
    markPublished: (targetId, result) => markTargetPublished(deps.sql, targetId, result),
    markFailed: (targetId, input) => markTargetFailed(deps.sql, targetId, input),
    rollUp: (postId) => rollUpPostStatus(deps.sql, postId),
  };
}

function assertMatchingAccount(target: ClaimedTarget, handle: PublishingHandle | null): asserts handle is PublishingHandle {
  if (!handle) throw ProviderError.invalid('The publishing account no longer exists. Connect another account and retry.');
  if (
    handle.clientId !== target.clientId ||
    handle.accountId !== target.socialAccountId ||
    handle.channel !== target.channel
  ) {
    throw ProviderError.invalid('The publishing account does not match this post target.');
  }
}

async function notifyTerminal(
  deps: PublishRuntime,
  target: ClaimedTarget,
  postStatus: PostStatus | null,
  outcome: 'published' | 'failed',
): Promise<void> {
  if (postStatus !== 'published' && postStatus !== 'partially_published' && postStatus !== 'failed') return;
  await deps.enqueue(
    'notify.telegram',
    {
      clientId: target.clientId,
      kind: outcome === 'published' ? 'post_published' : 'post_failed',
      refId: target.postId,
    },
    { dedupeBucket: `post-terminal:${target.postId}:${postStatus}` },
  );
}

async function recordFailure(
  deps: PublishRuntime,
  target: ClaimedTarget,
  failure: MarkTargetFailedInput,
  operations: PublishTargetOperations,
): Promise<void> {
  const delaySeconds = backoffSeconds(target.attempts, failure.retryAfterSec ?? null);
  const status = await operations.markFailed(target.id, {
    ...failure,
    retryAfterSec: delaySeconds,
    maxAttempts: MAX_PUBLISH_ATTEMPTS,
  });
  if (status === null) {
    deps.log.warn('publish failure ignored after target status changed', { targetId: target.id });
    return;
  }
  if (status === 'queued') {
    await deps.enqueue(
      'publish.target',
      { targetId: target.id },
      {
        startAfter: startAfterDate(delaySeconds),
        dedupeBucket: `publish-retry:${target.id}:${target.attempts}`,
      },
    );
    return;
  }
  const postStatus = await operations.rollUp(target.postId);
  await notifyTerminal(deps, target, postStatus, 'failed');
}

export async function runPublishTarget(
  deps: PublishRuntime,
  payload: ParsedJobPayload<'publish.target'>,
  operations: PublishTargetOperations,
): Promise<void> {
  const target = await operations.claim(payload.targetId);
  if (!target) {
    deps.log.debug('publish target already claimed or no longer eligible', { targetId: payload.targetId });
    return;
  }

  let handle: PublishingHandle | null = null;
  try {
    handle = await operations.loadHandle(target.socialAccountId);
    assertMatchingAccount(target, handle);
    const result = await handle.publish({
      text: target.caption,
      media: target.media,
      linkUrl: target.linkUrl,
      title: target.brief,
      idempotencyKey: target.idempotencyKey,
    });

    if (bufferPublishIsPending(handle.providerId, result)) {
      const recorded = await operations.markPublishing(target.id, result.externalId);
      if (!recorded) {
        deps.log.error('provider accepted post after target status changed', { targetId: target.id, provider: handle.providerId });
        return;
      }
      await deps.enqueue(
        'publish.check',
        { targetId: target.id },
        { startAfter: startAfterDate(60), dedupeBucket: `publish-check:${target.id}:${target.attempts}` },
      );
      return;
    }

    const recorded = await operations.markPublished(target.id, result);
    if (!recorded) {
      deps.log.error('provider published after target status changed', { targetId: target.id, provider: handle.providerId });
      return;
    }
    const postStatus = await operations.rollUp(target.postId);
    await notifyTerminal(deps, target, postStatus, 'published');
  } catch (error: unknown) {
    const classified = handle
      ? await handle.classify(error)
      : classifyError(error, 'The publishing account could not be loaded.');
    deps.log.warn('publish target failed', {
      targetId: target.id,
      provider: handle?.providerId ?? null,
      kind: classified.kind,
      safeToRetry: classified.safeToRetry,
    });
    await recordFailure(
      deps,
      target,
      {
        error: classified.message,
        kind: classified.kind,
        safeToRetry: classified.safeToRetry,
        retryAfterSec: classified.retryAfterSec,
      },
      operations,
    );
  }
}

export async function publishTarget(deps: WorkerDeps, payload: ParsedJobPayload<'publish.target'>): Promise<void> {
  await runPublishTarget(deps, payload, defaultOperations(deps));
}
