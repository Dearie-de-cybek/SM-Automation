// Ingest one knowledge source: claim it, fetch/parse by kind, chunk, embed, replace the
// chunk set in one transaction, then mark it ready. Idempotent — re-running re-ingests.

import type { IngestDeps, IngestResult } from './types';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function ingestSource(_deps: IngestDeps, _sourceId: string): Promise<IngestResult> {
  return ni('knowledge.ingestSource');
}
