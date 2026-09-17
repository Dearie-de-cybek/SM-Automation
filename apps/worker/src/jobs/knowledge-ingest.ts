// Crawl/parse a knowledge source, chunk it, embed it, replace its chunks.
import type { ParsedJobPayload } from '@sm/core/jobs';
import type { WorkerDeps } from '../deps';

export async function knowledgeIngest(deps: WorkerDeps, payload: ParsedJobPayload<'knowledge.ingest'>): Promise<void> {
  deps.log.warn('not implemented', { job: 'knowledge.ingest', sourceId: payload.sourceId });
}
