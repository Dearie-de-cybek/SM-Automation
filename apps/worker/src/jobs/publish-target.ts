// Claim the target, publish through its provider, record the result.
// The claim happens BEFORE the provider call, so a replayed job is a no-op.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function publishTarget(deps: WorkerDeps, payload: ParsedJobPayload<'publish.target'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'publish.target', targetId: payload.targetId });
}
