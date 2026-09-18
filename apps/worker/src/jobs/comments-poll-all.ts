// Fan out comments.poll to every account that is due (respects per-provider poll budgets).
import type { ParsedJobPayload } from '@sm/core/jobs';
import { minuteBucket } from '@sm/core/jobs';
import { listAccountsForCommentPolling } from '@sm/core/repos/accounts';
import type { WorkerDeps } from '../deps';

export async function commentsPollAll(deps: WorkerDeps, _payload: ParsedJobPayload<'comments.poll-all'>): Promise<void> {
  const accounts = await listAccountsForCommentPolling(deps.sql, { limit: 200 });
  const bucket = minuteBucket(new Date(), 5);
  await Promise.all(accounts.map((account) =>
    deps.enqueue('comments.poll', { accountId: account.id }, { dedupeBucket: `${account.id}:${bucket}` })));
}
