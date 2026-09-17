// Pull new comments for one account and upsert them; new rows trigger comment.triage.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function commentsPoll(deps: WorkerDeps, payload: ParsedJobPayload<'comments.poll'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'comments.poll', accountId: payload.accountId });
}
