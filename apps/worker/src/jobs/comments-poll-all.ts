// Fan out comments.poll to every account that is due (respects per-provider poll budgets).
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function commentsPollAll(deps: WorkerDeps, _payload: ParsedJobPayload<'comments.poll-all'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'comments.poll-all' });
}
