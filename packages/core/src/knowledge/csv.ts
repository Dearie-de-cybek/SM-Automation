// CSV product catalogues: parse, then turn each row into a small document so the
// retriever can cite an individual product.

import type { CatalogDocument } from './types';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** RFC 4180 parsing: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(_input: string): string[][] {
  return ni('knowledge.parseCsv');
}

/** First row is treated as the header; each later row becomes one document. */
export function catalogToDocuments(_rows: string[][], _options?: { title?: string | null; url?: string | null }): CatalogDocument[] {
  return ni('knowledge.catalogToDocuments');
}
