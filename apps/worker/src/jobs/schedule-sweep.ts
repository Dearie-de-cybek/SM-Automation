// Cron heartbeat: due scheduled targets → queued, re-enqueue stale queued rows, fail
// stuck publishing/sending rows, roll up post status. Makes a lost send() harmless.
import type { PostStatus } from '@sm/core/domain/types';
import type { ParsedJobPayload } from '@sm/core/jobs';
import { pendingCommentsForTriage, stuckTriagingComments } from '@sm/core/repos/comments';
import {
  dueScheduledTargets,
  listPostsInFlight,
  publishingTargetsToCheck,
  rollUpPostStatus,
  staleQueuedTargets,
  stuckPublishingTargets,
} from '@sm/core/repos/posts';
import { stuckSendingReplies } from '@sm/core/repos/replies';
import { pendingWebhookEvents } from '@sm/core/repos/webhooks';
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
  pendingComments?(): Promise<TargetId[]>;
  resetStuckComments?(): Promise<TargetId[]>;
  pendingWebhooks?(): Promise<{ id: string; provider: string }[]>;
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
    pendingComments: () => pendingCommentsForTriage(deps.sql),
    resetStuckComments: () => stuckTriagingComments(deps.sql),
    pendingWebhooks: () => pendingWebhookEvents(deps.sql),
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

  const resetComments = await operations.resetStuckComments?.() ?? [];
  const pendingComments = [...resetComments, ...(await operations.pendingComments?.() ?? [])];
  for (const comment of new Map(pendingComments.map((item) => [item.id, item])).values()) {
    await deps.enqueue('comment.triage', { commentId: comment.id }, { dedupeBucket: `sweep:${bucket}:comment:${comment.id}` });
  }

  const webhooks = await operations.pendingWebhooks?.() ?? [];
  for (const event of webhooks) {
    const name = event.provider === 'telegram' ? 'telegram.update' : 'webhook.process';
    await deps.enqueue(name, { eventId: event.id }, { dedupeBucket: `sweep:${bucket}:webhook:${event.id}` });
  }
  deps.log.info('schedule sweep complete', {
    due: due.length,
    stale: stale.length,
    pendingChecks: pending.length,
    interruptedTargets: interrupted.length,
    interruptedReplies: interruptedReplies.length,
    commentsRecovered: pendingComments.length,
    webhooksRecovered: webhooks.length,
  });
}

export async function scheduleSweep(deps: WorkerDeps, _payload: ParsedJobPayload<'schedule.sweep'>): Promise<void> {
  await runScheduleSweep(deps, _payload, defaultOperations(deps));
}
