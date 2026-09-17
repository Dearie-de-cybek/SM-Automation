// Knowledge ingestion + retrieval contracts. Everything here runs in the worker:
// user-supplied URLs and PDFs are hostile input.

import type { Sql } from '../db/client';
import type { KnowledgeSnippet, LlmClient } from '../ai/types';
import type { Logger } from '../log';

export interface CrawledPage {
  url: string;
  title: string | null;
  text: string;
  links: string[];
  fetchedAt: Date;
}

export interface PageExtract {
  title: string | null;
  text: string;
  links: string[];
}

export interface TextChunk {
  content: string;
  title: string | null;
  url: string | null;
  position: number;
}

export interface CatalogDocument {
  title: string;
  url: string | null;
  text: string;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Hard cap on the response body; the stream is aborted past it. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  /** Final URL after redirects (each hop re-checked against the SSRF rules). */
  url: string;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
  text(): string;
}

export class SsrfError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'SsrfError';
    this.reason = reason;
  }
}

export interface CrawlOptions {
  maxPages: number;
  maxBytesPerPage?: number;
  timeoutMs?: number;
  /** Follow links on the start host only (default true). */
  sameHostOnly?: boolean;
  userAgent?: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  title?: string | null;
  url?: string | null;
  startPosition?: number;
}

export interface IngestDeps {
  sql: Sql;
  /** Null when GEMINI_API_KEY is missing: ingestion then stores FTS-only chunks. */
  llm: LlmClient | null;
  log: Logger;
}

export interface IngestResult {
  sourceId: string;
  clientId: string;
  pages: number;
  chunks: number;
  skipped: boolean;
}

export interface RetrievedChunk extends KnowledgeSnippet {
  id: number;
  sourceId: string;
  score: number;
  position: number;
}
