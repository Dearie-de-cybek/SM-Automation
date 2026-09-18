// Ingest one knowledge source: claim it, fetch/parse by kind, chunk, embed, replace the
// chunk set in one transaction, then mark it ready. Idempotent — re-running re-ingests.

import { createHash } from 'node:crypto';
import type { LlmClient } from '../ai/types';
import { resolvePlanLimits } from '../plans';
import { getClient } from '../repos/clients';
import {
  claimSourceForIngest,
  countKnowledgeUsage,
  markSourceFailed,
  markSourceReady,
  replaceChunks,
  type KnowledgeChunkInput,
  type SourceForIngest,
} from '../repos/knowledge';
import { chunkText } from './chunk';
import { crawlSite } from './crawl';
import { catalogToDocuments, parseCsv } from './csv';
import { htmlToText } from './html';
import { looksLikeScannedPdf, pdfToText } from './pdf';
import { safeFetch } from './ssrf';
import type { IngestDeps, IngestResult } from './types';

/** Pages crawled when the source does not set `settings.maxPages`. */
export const DEFAULT_MAX_CRAWL_PAGES = 25;
/** Hard ceiling per source, so one huge PDF cannot fill the table. */
export const MAX_CHUNKS_PER_SOURCE = 2000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const EMBED_CHUNK_CHARS = 6000;

interface SourceDocument {
  title: string | null;
  url: string | null;
  text: string;
}

// ASCII unit/record separators: they cannot appear in extracted text.
const FIELD_SEPARATOR = String.fromCharCode(0x1f);
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function hashDocuments(documents: SourceDocument[]): string {
  const hash = createHash('sha256');
  for (const document of documents) {
    hash.update(document.url ?? '');
    hash.update(FIELD_SEPARATOR);
    hash.update(document.title ?? '');
    hash.update(FIELD_SEPARATOR);
    hash.update(document.text);
    hash.update(RECORD_SEPARATOR);
  }
  return hash.digest('hex');
}

/** Embedding input format expected by gemini-embedding-2 (title kept out of the body). */
function embeddingInput(chunk: KnowledgeChunkInput): string {
  const body = chunk.content.length > EMBED_CHUNK_CHARS ? chunk.content.slice(0, EMBED_CHUNK_CHARS) : chunk.content;
  return `title: ${chunk.title ?? 'none'} | text: ${body}`;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Turn a fetched file into documents, dispatching on the served content type. */
async function documentsFromUrl(url: string, title: string | null): Promise<{ documents: SourceDocument[]; pages: number }> {
  const response = await safeFetch(url, { maxBytes: MAX_FETCH_BYTES, timeoutMs: 30_000 });
  if (response.status !== 200) throw new Error(`${url} answered HTTP ${response.status}`);
  const contentType = (response.contentType ?? '').toLowerCase();

  if (contentType.includes('pdf') || /\.pdf($|\?)/i.test(url)) {
    const { pages, text } = await pdfToText(response.bytes);
    if (looksLikeScannedPdf(pages, text)) {
      throw new Error('This PDF has no extractable text (it looks like a scan). Paste the text instead.');
    }
    return { documents: [{ title, url: response.url, text }], pages };
  }
  if (contentType.includes('csv') || /\.csv($|\?)/i.test(url)) {
    const documents = catalogToDocuments(parseCsv(response.text()), { title, url: response.url });
    return { documents, pages: 1 };
  }
  if (contentType.includes('html') || contentType.includes('xml')) {
    const extract = htmlToText(response.text(), response.url);
    return { documents: [{ title: extract.title ?? title, url: response.url, text: extract.text }], pages: 1 };
  }
  return { documents: [{ title, url: response.url, text: decodeText(response.bytes) }], pages: 1 };
}

async function collectDocuments(
  source: SourceForIngest,
  maxPages: number,
): Promise<{ documents: SourceDocument[]; pages: number }> {
  const rawText = source.rawText?.trim() ?? '';
  const title = source.title.trim() === '' ? null : source.title;

  if (source.kind === 'website') {
    if (!source.url) throw new Error('This website source has no URL.');
    const pages = await crawlSite(source.url, { maxPages });
    if (pages.length === 0) throw new Error(`Nothing could be read from ${source.url}.`);
    return {
      documents: pages.map((page) => ({ title: page.title ?? title, url: page.url, text: page.text })),
      pages: pages.length,
    };
  }

  if (source.kind === 'catalog') {
    if (rawText !== '') {
      const documents = catalogToDocuments(parseCsv(rawText), { title, url: source.url ?? null });
      if (documents.length === 0) throw new Error('The catalogue has a header row but no data rows.');
      return { documents, pages: 1 };
    }
    if (source.url) return documentsFromUrl(source.url, title);
    throw new Error('This catalogue has neither uploaded content nor a URL.');
  }

  if (rawText !== '') return { documents: [{ title, url: source.url ?? null, text: rawText }], pages: 1 };
  if (source.url) return documentsFromUrl(source.url, title);
  throw new Error('This source has no content yet.');
}

export async function ingestSource(deps: IngestDeps, sourceId: string): Promise<IngestResult> {
  const { sql, llm, log } = deps;

  const source = await claimSourceForIngest(sql, sourceId);
  if (!source) {
    // Another worker holds the claim (or the source is gone): this run is a no-op.
    const [row] = await sql<{ client_id: string }[]>`
      SELECT client_id FROM knowledge_sources WHERE id = ${sourceId}::uuid`;
    return { sourceId, clientId: row?.client_id ?? '', pages: 0, chunks: 0, skipped: true };
  }

  const clientId = source.clientId;
  try {
    const client = await getClient(sql, clientId);
    if (!client) throw new Error('The client for this knowledge source no longer exists.');
    const limits = resolvePlanLimits(client.plan, client.planOverrides);
    if (limits.knowledgePages <= 0) {
      throw new Error('Knowledge ingestion is not included in this plan.');
    }

    const usage = await countKnowledgeUsage(sql, clientId);
    // The source's own pages are about to be replaced, so they do not count against it.
    const otherPages = Math.max(0, usage.pages - source.pagesCount);
    const pageBudget = limits.knowledgePages - otherPages;
    if (pageBudget <= 0) {
      throw new Error(`The plan's ${limits.knowledgePages}-page knowledge limit is already used up.`);
    }

    const requested = Number(source.settings.maxPages);
    const settingsMax = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_CRAWL_PAGES;
    const maxPages = Math.max(1, Math.min(settingsMax, pageBudget));

    const { documents, pages } = await collectDocuments(source, maxPages);
    const usable = documents.filter((document) => document.text.trim() !== '');
    if (usable.length === 0) throw new Error('No readable text was found in this source.');

    const contentHash = hashDocuments(usable);
    if (contentHash === source.contentHash && source.chunksCount > 0) {
      // Nothing changed since the last run: keep the chunks (and their embeddings).
      await markSourceReady(sql, sourceId, { pages: source.pagesCount, chunks: source.chunksCount, contentHash });
      log.info('knowledge source unchanged', { sourceId, clientId, chunks: source.chunksCount });
      return { sourceId, clientId, pages: source.pagesCount, chunks: source.chunksCount, skipped: true };
    }

    const chunks: KnowledgeChunkInput[] = [];
    for (const document of usable) {
      for (const chunk of chunkText(document.text, { title: document.title, url: document.url, startPosition: chunks.length })) {
        if (chunks.length >= MAX_CHUNKS_PER_SOURCE) break;
        chunks.push({
          content: chunk.content,
          title: chunk.title,
          url: chunk.url,
          position: chunks.length,
          embedding: null,
          embeddingModel: null,
        });
      }
      if (chunks.length >= MAX_CHUNKS_PER_SOURCE) break;
    }
    if (chunks.length === 0) throw new Error('No readable text was found in this source.');

    if (llm) {
      try {
        const vectors = await llm.embed(chunks.map(embeddingInput), 'RETRIEVAL_DOCUMENT');
        const model = embeddingModelOf(llm);
        for (const [index, vector] of vectors.entries()) {
          const chunk = chunks[index];
          if (!chunk) continue;
          chunk.embedding = vector;
          chunk.embeddingModel = model;
        }
      } catch (error: unknown) {
        // FTS still works without vectors: store the chunks and retry embeddings later.
        log.warn('knowledge embeddings failed, storing text-only chunks', { sourceId, clientId, error });
      }
    }

    await sql.begin(async (tx) => {
      await replaceChunks(tx, sourceId, chunks);
    });
    await markSourceReady(sql, sourceId, { pages, chunks: chunks.length, contentHash });
    log.info('knowledge source ingested', { sourceId, clientId, pages, chunks: chunks.length });

    return { sourceId, clientId, pages, chunks: chunks.length, skipped: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await markSourceFailed(sql, sourceId, message);
    throw error;
  }
}

/**
 * `knowledge_chunks.embedding_model` decides whether a stored vector can be compared
 * with a fresh query vector. The LlmClient contract has no accessor for it, so the
 * Gemini client exposes it as an extra property and this reads it defensively.
 */
function embeddingModelOf(llm: LlmClient): string | null {
  const value = (llm as { embeddingModel?: unknown }).embeddingModel;
  return typeof value === 'string' && value !== '' ? value : null;
}
