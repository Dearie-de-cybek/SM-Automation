// Generate post ideas from the client's own knowledge and land them as draft posts.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function contentGenerate(deps: WorkerDeps, payload: ParsedJobPayload<'content.generate'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'content.generate', clientId: payload.clientId, requestId: payload.requestId });
}
