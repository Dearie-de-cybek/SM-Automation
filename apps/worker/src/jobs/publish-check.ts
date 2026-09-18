// Follow-up poll for providers that accept a post asynchronously (Buffer):
// pending → keep waiting, sent → published, error → failed.
import type { PostStatus, PostTargetStatus } from '@sm/core/domain/types';
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { BufferPostStatus } from '@sm/core/providers/buffer';
import { ProviderError } from '@sm/core/providers/errors';
import {
  getPublishingTargetForCheck,
  markTargetFailed,
  markTargetPublished,
  rollUpPostStatus,
  type MarkTargetFailedInput,
  type TargetSummary,
} from '@sm/core/repos/posts';
import type { WorkerDeps } from '../deps';
import { classifyError } from '../lib/errors';
import { loadPublishingHandle, type PublishingHandle } from '../lib/publishing';
import { startAfterDate } from '../lib/retry';

export type { PublishingHandle } from '../lib/publishing';

type PublishCheckRuntime = Pick<WorkerDeps, 'log' | 'enqueue'>;

export interface PublishCheckOperations {
  getTarget(targetId: string): Promise<TargetSummary | null>;
  loadHandle(accountId: string): Promise<PublishingHandle | null>;
  getStatus(handle: PublishingHandle, externalId: string): Promise<BufferPostStatus>;
  markPublished(targetId: string, result: { externalId: string; permalink: string | null }): Promise<boolean>;
  markFailed(targetId: string, input: MarkTargetFailedInput): Promise<PostTargetStatus | null>;
  rollUp(postId: string): Promise<PostStatus | null>;
}

function defaultOperations(deps: WorkerDeps): PublishCheckOperations {
  return {
    getTarget: (targetId) => getPublishingTargetForCheck(deps.sql, targetId),
    loadHandle: (accountId) => loadPublishingHandle(deps, accountId),
    getStatus: (handle, externalId) => handle.poll(externalId),
    markPublished: (targetId, result) => markTargetPublished(deps.sql, targetId, result),
    markFailed: (targetId, input) => markTargetFailed(deps.sql, targetId, input),
    rollUp: (postId) => rollUpPostStatus(deps.sql, postId),
  };
}

function assertBufferTarget(target: TargetSummary, handle: PublishingHandle | null): asserts handle is PublishingHandle {
  if (!handle) throw ProviderError.invalid('The Buffer account for this post no longer exists.');
  if (
    handle.providerId !== 'buffer' ||
    handle.clientId !== target.clientId ||
    handle.accountId !== target.socialAccountId ||
    handle.channel !== target.channel
  ) {
    throw ProviderError.invalid('The Buffer account does not match this pending post.');
  }
}

async function enqueueCheck(deps: PublishCheckRuntime, targetId: string, delaySeconds: number): Promise<void> {
  const minute = Math.floor((Date.now() + delaySeconds * 1000) / 60_000);
  await deps.enqueue(
    'publish.check',
    { targetId },
    { startAfter: startAfterDate(delaySeconds), dedupeBucket: `publish-check:${targetId}:${minute}` },
  );
}

async function notifyTerminal(
  deps: PublishCheckRuntime,
  target: TargetSummary,
  status: PostStatus | null,
  outcome: 'published' | 'failed',
): Promise<void> {
  if (status !== 'published' && status !== 'partially_published' && status !== 'failed') return;
  await deps.enqueue(
    'notify.telegram',
    { clientId: target.clientId, kind: outcome === 'published' ? 'post_published' : 'post_failed', refId: target.postId },
    { dedupeBucket: `post-terminal:${target.postId}:${status}` },
  );
}

export async function runPublishCheck(
  deps: PublishCheckRuntime,
  payload: ParsedJobPayload<'publish.check'>,
  operations: PublishCheckOperations,
): Promise<void> {
  const target = await operations.getTarget(payload.targetId);
  if (!target || !target.externalId) {
    deps.log.debug('publish check target already settled or missing', { targetId: payload.targetId });
    return;
  }

  let handle: PublishingHandle | null = null;
  try {
    handle = await operations.loadHandle(target.socialAccountId);
    assertBufferTarget(target, handle);
    const result = await operations.getStatus(handle, target.externalId);
    if (result.status === 'pending') {
      await enqueueCheck(deps, target.id, 60);
      return;
    }
    if (result.status === 'sent') {
      const recorded = await operations.markPublished(target.id, { externalId: target.externalId, permalink: result.permalink });
      if (!recorded) return;
      const postStatus = await operations.rollUp(target.postId);
      await notifyTerminal(deps, target, postStatus, 'published');
      return;
    }

    const recorded = await operations.markFailed(target.id, {
      error: result.error ?? 'Buffer could not publish this post.',
      kind: 'invalid',
      safeToRetry: false,
    });
    if (recorded === null) return;
    const postStatus = await operations.rollUp(target.postId);
    await notifyTerminal(deps, target, postStatus, 'failed');
  } catch (error: unknown) {
    const classified = handle
      ? await handle.classify(error)
      : classifyError(error, 'The Buffer post status could not be checked.');
    deps.log.warn('publish check failed', {
      targetId: target.id,
      kind: classified.kind,
      safeToRetry: classified.safeToRetry,
    });
    if (classified.safeToRetry) {
      await enqueueCheck(deps, target.id, classified.retryAfterSec ?? 60);
      return;
    }
    const recorded = await operations.markFailed(target.id, {
      error: classified.message,
      kind: classified.kind,
      safeToRetry: false,
    });
    if (recorded === null) return;
    const postStatus = await operations.rollUp(target.postId);
    await notifyTerminal(deps, target, postStatus, 'failed');
  }
}

export async function publishCheck(deps: WorkerDeps, payload: ParsedJobPayload<'publish.check'>): Promise<void> {
  await runPublishCheck(deps, payload, defaultOperations(deps));
}
