// Crawl/parse a knowledge source, chunk it, embed it, replace its chunks.
import type { ParsedJobPayload } from '@sm/core/jobs';
import { ingestSource } from '@sm/core/knowledge/ingest';
import type { WorkerDeps } from '../deps';

export async function knowledgeIngest(deps: WorkerDeps, payload: ParsedJobPayload<'knowledge.ingest'>): Promise<void> {
  const result = await ingestSource({ sql: deps.sql, llm: deps.llm(), log: deps.log }, payload.sourceId);
  if (!result.clientId || result.skipped) return;
  await deps.enqueue('notify.telegram', {
    clientId: result.clientId,
    kind: 'knowledge_ready',
    refId: result.sourceId,
  }, { dedupeBucket: `knowledge:${result.sourceId}:${result.pages}:${result.chunks}` });
}
