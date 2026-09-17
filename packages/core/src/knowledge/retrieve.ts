// Retrieval without new infrastructure: Postgres FTS candidates ∪ cosine similarity in
// JS over the client's embedded chunks, fused with reciprocal-rank fusion.
// `llm` may be null (no embeddings configured): FTS alone still works.

import type { Sql } from '../db/client';
import type { LlmClient } from '../ai/types';
import type { RetrievedChunk } from './types';

export const DEFAULT_RETRIEVAL_K = 6;
/** Upper bound on chunks scored in JS for one query. */
export const MAX_VECTOR_CANDIDATES = 5000;
export const RRF_K = 60;

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function retrieveKnowledge(
  _sql: Sql,
  _llm: LlmClient | null,
  _clientId: string,
  _query: string,
  _k: number = DEFAULT_RETRIEVAL_K,
): Promise<RetrievedChunk[]> {
  return ni('knowledge.retrieveKnowledge');
}
