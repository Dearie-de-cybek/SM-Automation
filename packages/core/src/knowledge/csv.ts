// CSV product catalogues: parse, then turn each row into a small document so the
// retriever can cite an individual product.

import type { CatalogDocument } from './types';

/** RFC 4180 parsing: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  // Strip a UTF-8 BOM: Excel writes one and it would poison the first header name.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const endField = (): void => {
    row.push(field);
    field = '';
    started = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      endRow();
      continue;
    }
    if (char === '\n') {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }
  if (started || field !== '' || row.length > 0) endRow();

  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

const NAME_HINTS = ['name', 'title', 'product', 'item', 'service', 'label'];
const PRICE_HINTS = ['price', 'cost', 'amount', 'rate', 'fee'];
const DESCRIPTION_HINTS = ['description', 'details', 'summary', 'about', 'notes', 'body'];
const URL_HINTS = ['url', 'link', 'permalink', 'page', 'href'];

function findColumn(headers: string[], hints: string[]): number {
  const lower = headers.map((header) => header.trim().toLowerCase());
  for (const hint of hints) {
    const exact = lower.indexOf(hint);
    if (exact !== -1) return exact;
  }
  for (const hint of hints) {
    const partial = lower.findIndex((header) => header.includes(hint));
    if (partial !== -1) return partial;
  }
  return -1;
}

/** First row is treated as the header; each later row becomes one document. */
export function catalogToDocuments(
  rows: string[][],
  options: { title?: string | null; url?: string | null } = {},
): CatalogDocument[] {
  const [headerRow, ...dataRows] = rows;
  if (!headerRow || dataRows.length === 0) return [];

  const headers = headerRow.map((header, index) => {
    const cleaned = header.trim();
    return cleaned === '' ? `column ${index + 1}` : cleaned;
  });
  const nameColumn = findColumn(headers, NAME_HINTS);
  const priceColumn = findColumn(headers, PRICE_HINTS);
  const descriptionColumn = findColumn(headers, DESCRIPTION_HINTS);
  const urlColumn = findColumn(headers, URL_HINTS);
  const fallbackTitle = options.title?.trim() ?? '';

  const documents: CatalogDocument[] = [];
  for (const [rowIndex, row] of dataRows.entries()) {
    if (row.every((value) => value.trim() === '')) continue;

    const cell = (index: number): string => (index === -1 ? '' : (row[index] ?? '').trim());
    const name = cell(nameColumn);
    const price = cell(priceColumn);
    const description = cell(descriptionColumn);
    const rawUrl = cell(urlColumn);

    const heading = name !== '' ? name : fallbackTitle !== '' ? `${fallbackTitle} — row ${rowIndex + 1}` : `Row ${rowIndex + 1}`;

    const lines: string[] = [`## ${heading}`];
    if (price !== '') lines.push(`Price: ${price}`);
    if (description !== '') lines.push(description);
    // Remaining columns keep their header so a retrieved row stays self-describing.
    for (const [columnIndex, header] of headers.entries()) {
      if (
        columnIndex === nameColumn ||
        columnIndex === priceColumn ||
        columnIndex === descriptionColumn ||
        columnIndex === urlColumn
      ) {
        continue;
      }
      const value = cell(columnIndex);
      if (value === '') continue;
      lines.push(`${header}: ${value}`);
    }

    let url: string | null = null;
    if (rawUrl !== '') {
      try {
        const parsed = new URL(rawUrl, options.url ?? undefined);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
      } catch {
        // Not a usable link: the raw value still appears in the text above.
      }
    }

    documents.push({ title: heading, url: url ?? options.url ?? null, text: lines.join('\n') });
  }
  return documents;
}
