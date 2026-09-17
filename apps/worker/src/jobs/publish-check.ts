// Follow-up poll for providers that accept a post asynchronously (Buffer):
// pending → keep waiting, sent → published, error → failed.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function publishCheck(deps: WorkerDeps, payload: ParsedJobPayload<'publish.check'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'publish.check', targetId: payload.targetId });
}
