// Media URLs → inline image parts. Media lives on our own S3/R2 bucket, but the URL
// still comes out of the database, so it goes through the SSRF guard like any other.

import { safeFetch } from '../knowledge/ssrf';
import type { LlmImage } from './types';

/** Inline image types Gemini accepts. */
export const INLINE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'] as const;
/** The whole request must stay under 20 MB, base64 included. */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 4;

export interface FetchInlineImagesOptions {
  maxImages?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function fetchInlineImages(
  urls: readonly string[],
  options: FetchInlineImagesOptions = {},
): Promise<LlmImage[]> {
  const maxImages = options.maxImages ?? MAX_INLINE_IMAGES;
  const maxBytes = options.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  const images: LlmImage[] = [];

  for (const url of urls.slice(0, maxImages)) {
    try {
      const response = await safeFetch(url, {
        maxBytes,
        timeoutMs: options.timeoutMs ?? 15_000,
        accept: INLINE_IMAGE_MIME_TYPES.join(','),
      });
      if (response.status !== 200 || response.bytes.byteLength === 0) continue;
      const mimeType = (response.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!(INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) continue;
      images.push({ mimeType, dataBase64: Buffer.from(response.bytes).toString('base64') });
    } catch {
      // An image the model cannot see is not a reason to fail the generation.
    }
  }
  return images;
}
