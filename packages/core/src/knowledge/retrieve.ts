// Retrieval without new infrastructure: Postgres FTS candidates ∪ cosine similarity in
// JS over the client's embedded chunks, fused with reciprocal-rank fusion.
// `llm` may be null (no embeddings configured): FTS alone still works.

import type { Sql } from '../db/client';
import type { LlmClient } from '../ai/types';
import { listChunksForRetrieval, type KnowledgeCandidate } from '../repos/knowledge';
import type { RetrievedChunk } from './types';

export const DEFAULT_RETRIEVAL_K = 6;
/** Upper bound on chunks scored in JS for one query. */
export const MAX_VECTOR_CANDIDATES = 5000;
export const RRF_K = 60;
/** FTS candidates considered before fusion. */
export const FTS_CANDIDATES = 40;
/** Characters kept per snippet handed to a prompt. */
const MAX_SNIPPET_CHARS = 1500;

/** Both vectors are L2-normalized, so cosine similarity is their dot product. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function toChunk(candidate: KnowledgeCandidate, score: number): RetrievedChunk {
  const content =
    candidate.content.length > MAX_SNIPPET_CHARS ? `${candidate.content.slice(0, MAX_SNIPPET_CHARS)}…` : candidate.content;
  return {
    id: candidate.id,
    sourceId: candidate.sourceId,
    title: candidate.title,
    url: candidate.url,
    content,
    position: candidate.position,
    score,
  };
}

export async function retrieveKnowledge(
  sql: Sql,
  llm: LlmClient | null,
  clientId: string,
  query: string,
  k: number = DEFAULT_RETRIEVAL_K,
): Promise<RetrievedChunk[]> {
  const trimmed = query.trim();
  if (trimmed === '' || k <= 0) return [];

  const { fts, vectors } = await listChunksForRetrieval(sql, clientId, {
    query: trimmed,
    ftsLimit: FTS_CANDIDATES,
    vectorLimit: MAX_VECTOR_CANDIDATES,
    includeEmbeddings: llm !== null,
  });

  let vectorRanked: KnowledgeCandidate[] = [];
  if (llm && vectors.length > 0) {
    try {
      const [queryVector] = await llm.embed([trimmed], 'RETRIEVAL_QUERY');
      if (queryVector && queryVector.length > 0) {
        vectorRanked = vectors
          // A chunk embedded with a different model has a different width: skip it
          // rather than compare vectors from incompatible spaces.
          .filter((candidate) => (candidate.embedding?.length ?? 0) === queryVector.length)
          .map((candidate) => ({ candidate, score: cosineSimilarity(queryVector, candidate.embedding ?? []) }))
          .sort((left, right) => right.score - left.score)
          .slice(0, FTS_CANDIDATES)
          .map((entry) => entry.candidate);
      }
    } catch {
      // Embedding the query failed: FTS results alone are still useful.
      vectorRanked = [];
    }
  }

  // Reciprocal-rank fusion: rank position, not raw score, so the two very different
  // scales (ts_rank vs cosine) can be combined without calibration.
  const fused = new Map<number, { candidate: KnowledgeCandidate; score: number }>();
  const add = (candidates: KnowledgeCandidate[]): void => {
    for (const [index, candidate] of candidates.entries()) {
      const existing = fused.get(candidate.id);
      const contribution = 1 / (RRF_K + index + 1);
      if (existing) existing.score += contribution;
      else fused.set(candidate.id, { candidate, score: contribution });
    }
  };
  add(fts);
  add(vectorRanked);

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.candidate.id - right.candidate.id)
    .slice(0, k)
    .map((entry) => toChunk(entry.candidate, entry.score));
}
