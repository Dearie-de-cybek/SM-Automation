// Split page text into overlapping chunks on paragraph boundaries.

import type { ChunkOptions, TextChunk } from './types';

export const DEFAULT_CHUNK_CHARS = 1200;
export const DEFAULT_OVERLAP_CHARS = 150;

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function chunkText(_text: string, _options?: ChunkOptions): TextChunk[] {
  return ni('knowledge.chunkText');
}
