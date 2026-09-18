// Split page text into overlapping chunks on paragraph boundaries.

import type { ChunkOptions, TextChunk } from './types';

export const DEFAULT_CHUNK_CHARS = 900;
export const DEFAULT_OVERLAP_CHARS = 120;
/** Below this a chunk carries no retrievable signal and only costs an embedding call. */
const MIN_CHUNK_CHARS = 40;

const HEADING_RE = /^#{1,6}\s+\S/;

interface Block {
  text: string;
  heading: string | null;
}

/** Paragraphs, each tagged with the most recent markdown heading above it. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  for (const raw of text.split(/\n{2,}/)) {
    const paragraph = raw.trim();
    if (paragraph === '') continue;
    const lines = paragraph.split('\n');
    let buffer: string[] = [];
    const flush = (): void => {
      const joined = buffer.join('\n').trim();
      buffer = [];
      if (joined !== '') blocks.push({ text: joined, heading });
    };
    for (const line of lines) {
      if (HEADING_RE.test(line.trim())) {
        flush();
        heading = line.trim().replace(/^#{1,6}\s+/, '');
        blocks.push({ text: line.trim(), heading });
        continue;
      }
      buffer.push(line);
    }
    flush();
  }
  return blocks;
}

/** Split a block that is longer than the budget on sentence, then word boundaries. */
function splitLong(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    let cut = maxChars;
    if (sentence > maxChars * 0.5) cut = sentence + 1;
    else if (newline > maxChars * 0.5) cut = newline;
    else if (space > maxChars * 0.5) cut = space;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/** Tail of `text` at a word boundary, used as the lead-in of the next chunk. */
function tail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return text;
  const slice = text.slice(text.length - overlapChars);
  const boundary = slice.search(/[\s]/);
  return boundary === -1 ? slice : slice.slice(boundary + 1);
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 2)));
  const title = options.title ?? null;
  const url = options.url ?? null;
  let position = options.startPosition ?? 0;

  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (normalized === '') return [];

  const chunks: TextChunk[] = [];
  let current = '';
  let currentHeading: string | null = null;

  const push = (): void => {
    const body = current.trim();
    current = '';
    if (body === '') return;
    // The heading is repeated inside the chunk so FTS and embeddings both see it.
    const content = currentHeading && !body.startsWith('#') ? `${currentHeading}\n${body}` : body;
    chunks.push({ content, title, url, position });
    position += 1;
  };

  for (const block of toBlocks(normalized)) {
    for (const piece of block.text.length > maxChars ? splitLong(block.text, maxChars) : [block.text]) {
      if (current === '') {
        currentHeading = block.heading;
        current = piece;
        continue;
      }
      if (current.length + piece.length + 2 <= maxChars) {
        current = `${current}\n\n${piece}`;
        continue;
      }
      const carry = tail(current, overlapChars);
      push();
      currentHeading = block.heading;
      current = carry === '' || carry === piece ? piece : `${carry}\n\n${piece}`;
      if (current.length > maxChars) current = piece;
    }
  }
  push();

  // A trailing scrap belongs to the previous chunk rather than to its own row.
  const merged: TextChunk[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (chunk.content.length < MIN_CHUNK_CHARS && previous && previous.content.length + chunk.content.length <= maxChars * 1.2) {
      previous.content = `${previous.content}\n\n${chunk.content}`;
      continue;
    }
    merged.push({ ...chunk, position: merged.length + (options.startPosition ?? 0) });
  }
  return merged;
}
