// Knowledge sources and chunks. Retrieval candidates are returned raw (FTS rank and,
// optionally, embeddings) so knowledge/retrieve.ts can fuse them in JS.

import { jsonParam, type AnySql } from '../crypto';
import type { TransactionSql } from '../db/client';
import type { KnowledgeSourceKind, KnowledgeSourceStatus } from '../domain/types';

export interface CreateSourceInput {
  clientId: string;
  kind: KnowledgeSourceKind;
  title: string;
  url?: string | null;
  rawText?: string | null;
  fileName?: string | null;
  settings?: Record<string, unknown>;
}

export interface SourceSummary {
  id: string;
  clientId: string;
  kind: KnowledgeSourceKind;
  title: string;
  url: string | null;
  fileName: string | null;
  status: KnowledgeSourceStatus;
  error: string | null;
  settings: Record<string, unknown>;
  pagesCount: number;
  chunksCount: number;
  lastIngestedAt: Date | null;
  createdAt: Date;
}

export interface SourceForIngest extends SourceSummary {
  rawText: string | null;
  contentHash: string | null;
}

export interface KnowledgeChunkInput {
  content: string;
  title: string | null;
  url: string | null;
  position: number;
  embedding: number[] | null;
  embeddingModel?: string | null;
}

export interface KnowledgeCandidate {
  id: number;
  sourceId: string;
  title: string | null;
  url: string | null;
  content: string;
  position: number;
  /** FTS rank, or null for vector candidates. */
  rank: number | null;
  embedding: number[] | null;
}

export interface RetrievalCandidates {
  fts: KnowledgeCandidate[];
  vectors: KnowledgeCandidate[];
}

interface SourceRowShape {
  id: string;
  client_id: string;
  kind: KnowledgeSourceKind;
  title: string;
  url: string | null;
  file_name: string | null;
  status: KnowledgeSourceStatus;
  error: string | null;
  settings: Record<string, unknown> | null;
  pages_count: number;
  chunks_count: number;
  last_ingested_at: Date | null;
  created_at: Date;
}

const SOURCE_COLUMNS = `id, client_id, kind, title, url, file_name, status, error, settings, pages_count,
  chunks_count, last_ingested_at, created_at`;

function toSource(row: SourceRowShape): SourceSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    fileName: row.file_name,
    status: row.status,
    error: row.error,
    settings: row.settings ?? {},
    pagesCount: row.pages_count,
    chunksCount: row.chunks_count,
    lastIngestedAt: row.last_ingested_at,
    createdAt: row.created_at,
  };
}

export async function createSource(sql: AnySql, input: CreateSourceInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO knowledge_sources (client_id, kind, title, url, raw_text, file_name, settings)
    VALUES (${input.clientId}::uuid, ${input.kind}, ${input.title}, ${input.url ?? null}, ${input.rawText ?? null},
            ${input.fileName ?? null}, ${jsonParam(sql, input.settings ?? {})})
    RETURNING id`;
  if (!row) throw new Error('createSource: insert returned no row');
  return row.id;
}

export async function listSources(sql: AnySql, clientId: string): Promise<SourceSummary[]> {
  const rows = await sql<SourceRowShape[]>`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)} FROM knowledge_sources
    WHERE client_id = ${clientId}::uuid ORDER BY created_at DESC`;
  return rows.map(toSource);
}

export async function getSource(sql: AnySql, clientId: string, sourceId: string): Promise<SourceSummary | null> {
  const [row] = await sql<SourceRowShape[]>`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)} FROM knowledge_sources
    WHERE id = ${sourceId}::uuid AND client_id = ${clientId}::uuid`;
  return row ? toSource(row) : null;
}

export async function deleteSource(sql: AnySql, clientId: string, sourceId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM knowledge_sources WHERE id = ${sourceId}::uuid AND client_id = ${clientId}::uuid RETURNING id`;
  return rows.length > 0;
}

/** pending/failed/ready → ingesting. Null when another worker holds it. */
export async function claimSourceForIngest(sql: AnySql, sourceId: string): Promise<SourceForIngest | null> {
  const [row] = await sql<(SourceRowShape & { raw_text: string | null; content_hash: string | null })[]>`
    UPDATE knowledge_sources SET status = 'ingesting', error = NULL, updated_at = now()
    WHERE id = ${sourceId}::uuid AND status IN ('pending', 'failed', 'ready')
    RETURNING ${sql.unsafe(SOURCE_COLUMNS)}, raw_text, content_hash`;
  if (!row) return null;
  return { ...toSource(row), rawText: row.raw_text, contentHash: row.content_hash };
}

/** Swap the whole chunk set for a source inside the caller's transaction. */
export async function replaceChunks(tx: TransactionSql, sourceId: string, chunks: KnowledgeChunkInput[]): Promise<number> {
  const [source] = await tx<{ client_id: string }[]>`
    SELECT client_id FROM knowledge_sources WHERE id = ${sourceId}::uuid FOR UPDATE`;
  if (!source) throw new Error(`replaceChunks: source ${sourceId} not found`);

  await tx`DELETE FROM knowledge_chunks WHERE source_id = ${sourceId}::uuid`;
  let inserted = 0;
  for (const chunk of chunks) {
    await tx`
      INSERT INTO knowledge_chunks (source_id, client_id, content, url, title, position, embedding, embedding_model)
      VALUES (${sourceId}::uuid, ${source.client_id}::uuid, ${chunk.content}, ${chunk.url}, ${chunk.title},
              ${chunk.position}, ${chunk.embedding === null ? null : chunk.embedding}::real[],
              ${chunk.embeddingModel ?? null})`;
    inserted += 1;
  }
  return inserted;
}

export async function markSourceReady(
  sql: AnySql,
  sourceId: string,
  stats: { pages: number; chunks: number; contentHash?: string | null },
): Promise<void> {
  await sql`
    UPDATE knowledge_sources SET status = 'ready', error = NULL, pages_count = ${stats.pages},
                                 chunks_count = ${stats.chunks}, content_hash = ${stats.contentHash ?? null},
                                 last_ingested_at = now(), updated_at = now()
    WHERE id = ${sourceId}::uuid`;
}

export async function markSourceFailed(sql: AnySql, sourceId: string, error: string): Promise<void> {
  await sql`
    UPDATE knowledge_sources SET status = 'failed', error = ${error.slice(0, 2000)}, updated_at = now()
    WHERE id = ${sourceId}::uuid`;
}

export async function countKnowledgeUsage(sql: AnySql, clientId: string): Promise<{ sources: number; pages: number }> {
  const [row] = await sql<{ sources: number; pages: number }[]>`
    SELECT count(*)::int AS sources, COALESCE(sum(pages_count), 0)::int AS pages
    FROM knowledge_sources WHERE client_id = ${clientId}::uuid AND status <> 'failed'`;
  return { sources: row?.sources ?? 0, pages: row?.pages ?? 0 };
}

export interface ListChunksOptions {
  query: string | null;
  ftsLimit?: number;
  vectorLimit?: number;
  /** Load embeddings for JS cosine scoring (skip when the query is FTS-only). */
  includeEmbeddings?: boolean;
}

/**
 * Candidate chunks for retrieval: FTS matches ranked by ts_rank, plus (optionally) the
 * client's embedded chunks for cosine scoring. Fusion happens in knowledge/retrieve.ts.
 */
export async function listChunksForRetrieval(
  sql: AnySql,
  clientId: string,
  options: ListChunksOptions,
): Promise<RetrievalCandidates> {
  const ftsLimit = options.ftsLimit ?? 50;
  const vectorLimit = options.vectorLimit ?? 5000;

  const fts = options.query
    ? await sql<KnowledgeCandidate[]>`
        SELECT id::int AS id, source_id AS "sourceId", title, url, content, position,
               ts_rank(tsv, websearch_to_tsquery('simple', ${options.query}))::float8 AS rank,
               NULL::real[] AS embedding
        FROM knowledge_chunks
        WHERE client_id = ${clientId}::uuid AND tsv @@ websearch_to_tsquery('simple', ${options.query})
        ORDER BY rank DESC
        LIMIT ${ftsLimit}`
    : [];

  const vectors = options.includeEmbeddings
    ? await sql<KnowledgeCandidate[]>`
        SELECT id::int AS id, source_id AS "sourceId", title, url, content, position,
               NULL::float8 AS rank, embedding
        FROM knowledge_chunks
        WHERE client_id = ${clientId}::uuid AND embedding IS NOT NULL
        ORDER BY id
        LIMIT ${vectorLimit}`
    : [];

  return { fts, vectors };
}
