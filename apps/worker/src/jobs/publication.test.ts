import assert from 'node:assert/strict';
import test from 'node:test';

import type { ErrorKind, PostStatus, PostTargetStatus, ProviderId } from '@sm/core/domain/types';
import { createLogger } from '@sm/core/log';
import { ProviderError } from '@sm/core/providers/errors';
import type { PublishInput, PublishResult } from '@sm/core/providers/types';
import type { ClaimedTarget, TargetSummary } from '@sm/core/repos/posts';
import type { EnqueueOptions } from '@sm/core/queue';
import type { WorkerDeps } from '../deps';
import { classifyError, type ClassifiedError } from '../lib/errors';
import {
  runPublishCheck,
  type PublishCheckOperations,
  type PublishingHandle,
} from './publish-check';
import {
  runPublishTarget,
  type PublishTargetOperations,
} from './publish-target';
import {
  runScheduleSweep,
  type ScheduleSweepOperations,
} from './schedule-sweep';

const IDS = {
  target: '00000000-0000-4000-8000-000000000001',
  post: '00000000-0000-4000-8000-000000000002',
  client: '00000000-0000-4000-8000-000000000003',
  account: '00000000-0000-4000-8000-000000000004',
  connection: '00000000-0000-4000-8000-000000000005',
};

interface EnqueuedJob {
  name: string;
  payload: unknown;
  options: EnqueueOptions | undefined;
}

function runtime(): { deps: Pick<WorkerDeps, 'log' | 'enqueue'>; jobs: EnqueuedJob[] } {
  const jobs: EnqueuedJob[] = [];
  const enqueue: WorkerDeps['enqueue'] = async (name, payload, options) => {
    jobs.push({ name, payload, options });
    return true;
  };
  return {
    deps: {
      log: createLogger({ level: 'error', write: () => undefined }),
      enqueue,
    },
    jobs,
  };
}

function target(overrides: Partial<ClaimedTarget> = {}): ClaimedTarget {
  return {
    id: IDS.target,
    postId: IDS.post,
    clientId: IDS.client,
    socialAccountId: IDS.account,
    channel: 'linkedin',
    caption: 'A useful update',
    status: 'publishing',
    publishAt: new Date('2026-09-18T10:00:00.000Z'),
    externalId: null,
    permalink: null,
    error: null,
    errorKind: null,
    attempts: 1,
    nextAttemptAt: null,
    publishedAt: null,
    brief: 'September launch',
    source: 'web',
    media: [],
    linkUrl: 'https://example.test/launch',
    idempotencyKey: `${IDS.target}:1`,
    ...overrides,
  };
}

function checkTarget(overrides: Partial<TargetSummary> = {}): TargetSummary {
  return {
    ...target(),
    externalId: 'buffer-post-1',
    ...overrides,
  };
}

function handle(
  providerId: ProviderId,
  publish: (input: PublishInput) => Promise<PublishResult>,
  classify: (error: unknown) => Promise<ClassifiedError> = async (error) => classifyError(error),
): PublishingHandle {
  return {
    clientId: IDS.client,
    accountId: IDS.account,
    connectionId: IDS.connection,
    channel: 'linkedin',
    providerId,
    publish,
    poll: async () => ({ status: 'pending', permalink: null, error: null }),
    classify,
  };
}

interface TargetState {
  publishing: string[];
  published: string[];
  failures: { kind: ErrorKind; safeToRetry: boolean; retryAfterSec: number | null }[];
  rollups: string[];
}

function targetOps(input: {
  claimed?: ClaimedTarget | null;
  provider?: PublishingHandle | null;
  failedStatus?: PostTargetStatus;
  rolledStatus?: PostStatus | null;
} = {}): { ops: PublishTargetOperations; state: TargetState } {
  const state: TargetState = { publishing: [], published: [], failures: [], rollups: [] };
  const ops: PublishTargetOperations = {
    claim: async () => (input.claimed === undefined ? target() : input.claimed),
    loadHandle: async () => (input.provider === undefined ? handle('meta', async () => ({ externalId: 'remote-1', permalink: null })) : input.provider),
    markPublishing: async (_id, externalId) => { state.publishing.push(externalId); return true; },
    markPublished: async (_id, result) => { state.published.push(result.externalId); return true; },
    markFailed: async (_id, failure) => {
      state.failures.push({ kind: failure.kind, safeToRetry: failure.safeToRetry, retryAfterSec: failure.retryAfterSec ?? null });
      return input.failedStatus ?? 'failed';
    },
    rollUp: async (postId) => {
      state.rollups.push(postId);
      return input.rolledStatus ?? 'published';
    },
  };
  return { ops, state };
}

test('publish target is a no-op after another worker claimed it', async () => {
  const { deps, jobs } = runtime();
  const { ops, state } = targetOps({ claimed: null });

  await runPublishTarget(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state, { publishing: [], published: [], failures: [], rollups: [] });
  assert.deepEqual(jobs, []);
});

test('Buffer pending result stays publishing and schedules a settlement check', async () => {
  const { deps, jobs } = runtime();
  const provider = handle('buffer', async (input) => {
    assert.equal(input.idempotencyKey, `${IDS.target}:1`);
    return { externalId: 'buffer-post-1', permalink: null, raw: { status: 'sending' } };
  });
  const { ops, state } = targetOps({ provider });

  await runPublishTarget(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state.publishing, ['buffer-post-1']);
  assert.deepEqual(state.published, []);
  assert.equal(jobs[0]?.name, 'publish.check');
  assert.ok(jobs[0]?.options?.startAfter instanceof Date);
});

test('successful publish finalizes target and emits one terminal post notification', async () => {
  const { deps, jobs } = runtime();
  const provider = handle('meta', async () => ({ externalId: 'meta-post-1', permalink: 'https://social.test/post' }));
  const { ops, state } = targetOps({ provider, rolledStatus: 'published' });

  await runPublishTarget(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state.published, ['meta-post-1']);
  assert.deepEqual(state.rollups, [IDS.post]);
  assert.deepEqual(jobs.map((job) => job.name), ['notify.telegram']);
  assert.deepEqual(jobs[0]?.payload, { clientId: IDS.client, kind: 'post_published', refId: IDS.post });
});

test('late provider success cannot overwrite or notify after target already became terminal', async () => {
  const { deps, jobs } = runtime();
  const provider = handle('meta', async () => ({ externalId: 'late-post', permalink: null }));
  const { ops, state } = targetOps({ provider, rolledStatus: 'failed' });
  ops.markPublished = async () => false;

  await runPublishTarget(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state.rollups, []);
  assert.deepEqual(jobs, []);
});

test('provably safe publish failure is requeued with bounded backoff', async () => {
  const { deps, jobs } = runtime();
  const provider = handle(
    'meta',
    async () => { throw new ProviderError('rate_limit', 'slow down', { safeToRetry: true, retryAfterSec: 17 }); },
    async () => ({ message: 'slow down', kind: 'rate_limit', safeToRetry: true, retryAfterSec: 17 }),
  );
  const { ops, state } = targetOps({ provider, failedStatus: 'queued' });

  await runPublishTarget(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state.failures, [{ kind: 'rate_limit', safeToRetry: true, retryAfterSec: 17 }]);
  assert.deepEqual(state.rollups, []);
  assert.equal(jobs[0]?.name, 'publish.target');
  assert.ok(jobs[0]?.options?.startAfter instanceof Date);
  assert.equal(jobs.some((job) => job.name === 'notify.telegram'), false);
});

test('account from another tenant fails closed before provider call', async () => {
  const { deps, jobs } = runtime();
  let publishCalls = 0;
  const provider = {
    ...handle('meta', async () => {
      publishCalls += 1;
      return { externalId: 'should-not-exist', permalink: null };
    }),
    clientId: '00000000-0000-4000-8000-000000000099',
  };
  const { ops, state } = targetOps({ provider, rolledStatus: 'failed' });

  await runPublishTarget(deps, { targetId: IDS.target }, ops);

  assert.equal(publishCalls, 0);
  assert.equal(state.failures[0]?.kind, 'invalid');
  assert.deepEqual(jobs.map((job) => job.name), ['notify.telegram']);
});

interface CheckState {
  published: string[];
  failures: string[];
  rollups: string[];
}

function checkOps(input: {
  target?: TargetSummary | null;
  provider?: PublishingHandle | null;
  status?: { status: 'pending' | 'sent' | 'error'; permalink: string | null; error: string | null };
  rolledStatus?: PostStatus | null;
} = {}): { ops: PublishCheckOperations; state: CheckState } {
  const state: CheckState = { published: [], failures: [], rollups: [] };
  const ops: PublishCheckOperations = {
    getTarget: async () => (input.target === undefined ? checkTarget() : input.target),
    loadHandle: async () => (input.provider === undefined ? handle('buffer', async () => ({ externalId: 'unused', permalink: null })) : input.provider),
    getStatus: async () => input.status ?? { status: 'pending', permalink: null, error: null },
    markPublished: async (_id, result) => { state.published.push(result.externalId); return true; },
    markFailed: async (_id, failure) => { state.failures.push(failure.error); return 'failed'; },
    rollUp: async (postId) => { state.rollups.push(postId); return input.rolledStatus ?? 'published'; },
  };
  return { ops, state };
}

test('Buffer check keeps pending posts alive without changing terminal state', async () => {
  const { deps, jobs } = runtime();
  const { ops, state } = checkOps();

  await runPublishCheck(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state, { published: [], failures: [], rollups: [] });
  assert.deepEqual(jobs.map((job) => job.name), ['publish.check']);
});

test('Buffer check finalizes sent posts and rolls up their parent', async () => {
  const { deps, jobs } = runtime();
  const { ops, state } = checkOps({
    status: { status: 'sent', permalink: 'https://social.test/post', error: null },
    rolledStatus: 'published',
  });

  await runPublishCheck(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state.published, ['buffer-post-1']);
  assert.deepEqual(state.rollups, [IDS.post]);
  assert.deepEqual(jobs.map((job) => job.name), ['notify.telegram']);
});

test('Buffer check records a terminal provider error instead of republishing', async () => {
  const { deps, jobs } = runtime();
  const { ops, state } = checkOps({
    status: { status: 'error', permalink: null, error: 'Buffer rejected it' },
    rolledStatus: 'failed',
  });

  await runPublishCheck(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state.failures, ['Buffer rejected it']);
  assert.deepEqual(state.rollups, [IDS.post]);
  assert.deepEqual(jobs.map((job) => job.name), ['notify.telegram']);
});

test('retryable Buffer status read schedules another read without republishing', async () => {
  const { deps, jobs } = runtime();
  const provider = handle(
    'buffer',
    async () => ({ externalId: 'unused', permalink: null }),
    async () => ({ message: 'temporarily unavailable', kind: 'transient', safeToRetry: true, retryAfterSec: 12 }),
  );
  const { ops, state } = checkOps({ provider });
  ops.getStatus = async () => { throw ProviderError.network('temporarily unavailable'); };

  await runPublishCheck(deps, { targetId: IDS.target }, ops);

  assert.deepEqual(state, { published: [], failures: [], rollups: [] });
  assert.deepEqual(jobs.map((job) => job.name), ['publish.check']);
  assert.ok(jobs[0]?.options?.startAfter instanceof Date);
});

test('schedule sweep fans out durable work and reports interrupted targets once', async () => {
  const { deps, jobs } = runtime();
  const rolled: string[] = [];
  const ops: ScheduleSweepOperations = {
    dueTargets: async () => [{ id: 'due-1', clientId: IDS.client }],
    staleQueuedTargets: async () => [{ id: 'stale-1' }],
    stuckPublishingTargets: async () => [{ id: 'stuck-1', postId: IDS.post, clientId: IDS.client }],
    publishingTargetsToCheck: async () => [{ id: 'check-1', externalId: 'buffer-1' }],
    stuckSendingReplies: async () => [{ id: 'reply-1', clientId: IDS.client }],
    postsInFlight: async () => [{ id: IDS.post, clientId: IDS.client }],
    rollUp: async (postId) => { rolled.push(postId); return 'failed'; },
    now: () => new Date('2026-09-18T12:34:56.000Z'),
  };

  await runScheduleSweep(deps, {}, ops);

  assert.deepEqual(rolled, [IDS.post]);
  assert.deepEqual(
    jobs.map((job) => job.name),
    ['publish.target', 'publish.target', 'publish.check', 'notify.telegram'],
  );
  assert.equal(new Set(jobs.map((job) => job.options?.dedupeBucket)).size, jobs.length);
});
