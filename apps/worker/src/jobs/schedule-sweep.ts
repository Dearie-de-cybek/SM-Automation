// Cron heartbeat: due scheduled targets → queued, re-enqueue stale queued rows, fail
// stuck publishing/sending rows, roll up post status. Makes a lost send() harmless.
import type { PostStatus } from '@sm/core/domain/types';
import type { ParsedJobPayload } from '@sm/core/jobs';
import {
  dueScheduledTargets,
  listPostsInFlight,
  publishingTargetsToCheck,
  rollUpPostStatus,
  staleQueuedTargets,
  stuckPublishingTargets,
} from '@sm/core/repos/posts';
import { stuckSendingReplies } from '@sm/core/repos/replies';
import type { WorkerDeps } from '../deps';

type ScheduleRuntime = Pick<WorkerDeps, 'log' | 'enqueue'>;

interface TargetId {
  id: string;
}

interface TenantTarget extends TargetId {
  clientId: string;
}

interface InterruptedTarget extends TenantTarget {
  postId: string;
}

export interface ScheduleSweepOperations {
  dueTargets(): Promise<TenantTarget[]>;
  staleQueuedTargets(): Promise<TargetId[]>;
  stuckPublishingTargets(): Promise<InterruptedTarget[]>;
  publishingTargetsToCheck(): Promise<{ id: string; externalId: string }[]>;
  stuckSendingReplies(): Promise<TenantTarget[]>;
  postsInFlight(): Promise<{ id: string; clientId: string }[]>;
  rollUp(postId: string): Promise<PostStatus | null>;
  now(): Date;
}

function defaultOperations(deps: WorkerDeps): ScheduleSweepOperations {
  return {
    dueTargets: () => dueScheduledTargets(deps.sql),
    staleQueuedTargets: () => staleQueuedTargets(deps.sql),
    stuckPublishingTargets: () => stuckPublishingTargets(deps.sql),
    publishingTargetsToCheck: () => publishingTargetsToCheck(deps.sql),
    stuckSendingReplies: () => stuckSendingReplies(deps.sql),
    postsInFlight: () => listPostsInFlight(deps.sql),
    rollUp: (postId) => rollUpPostStatus(deps.sql, postId),
    now: () => new Date(),
  };
}

export async function runScheduleSweep(
  deps: ScheduleRuntime,
  _payload: ParsedJobPayload<'schedule.sweep'>,
  operations: ScheduleSweepOperations,
): Promise<void> {
  const bucket = Math.floor(operations.now().getTime() / 60_000);
  const due = await operations.dueTargets();
  for (const target of due) {
    await deps.enqueue('publish.target', { targetId: target.id }, { dedupeBucket: `sweep:${bucket}:due:${target.id}` });
  }

  const stale = await operations.staleQueuedTargets();
  for (const target of stale) {
    await deps.enqueue('publish.target', { targetId: target.id }, { dedupeBucket: `sweep:${bucket}:stale:${target.id}` });
  }

  const pending = await operations.publishingTargetsToCheck();
  for (const target of pending) {
    await deps.enqueue('publish.check', { targetId: target.id }, { dedupeBucket: `sweep:${bucket}:check:${target.id}` });
  }

  const interrupted = await operations.stuckPublishingTargets();
  const inFlight = await operations.postsInFlight();
  const postClients = new Map(inFlight.map((post) => [post.id, post.clientId]));
  for (const target of interrupted) postClients.set(target.postId, target.clientId);

  for (const [postId, clientId] of postClients) {
    const status = await operations.rollUp(postId);
    if (status !== 'published' && status !== 'partially_published' && status !== 'failed') continue;
    await deps.enqueue(
      'notify.telegram',
      { clientId, kind: status === 'published' ? 'post_published' : 'post_failed', refId: postId },
      { dedupeBucket: `post-terminal:${postId}:${status}` },
    );
  }

  const interruptedReplies = await operations.stuckSendingReplies();
  if (interruptedReplies.length > 0) {
    deps.log.warn('stuck reply sends marked failed', { count: interruptedReplies.length });
  }
  deps.log.info('schedule sweep complete', {
    due: due.length,
    stale: stale.length,
    pendingChecks: pending.length,
    interruptedTargets: interrupted.length,
    interruptedReplies: interruptedReplies.length,
  });
}

export async function scheduleSweep(deps: WorkerDeps, _payload: ParsedJobPayload<'schedule.sweep'>): Promise<void> {
  await runScheduleSweep(deps, _payload, defaultOperations(deps));
}
