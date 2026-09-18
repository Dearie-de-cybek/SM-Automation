// Media helpers shared by the direct posting adapters. Media arrives as public URLs on
// our own storage; adapters that cannot pass a URL through (Bluesky blobs, Telegram
// multipart, Mastodon uploads) download it here with a hard size cap.

import { mediaKindFor, normalizeMimeType, extensionFor } from '../../media/mime';
import type { MediaItem } from '../../domain/types';
import { ProviderError } from '../errors';
import type { HttpClient } from '../http';

export interface SplitMedia {
  images: MediaItem[];
  videos: MediaItem[];
}

/** Split by MIME kind, dropping anything outside the upload allowlist. */
export function splitMedia(media: readonly MediaItem[]): SplitMedia {
  const images: MediaItem[] = [];
  const videos: MediaItem[] = [];
  for (const item of media) {
    const kind = mediaKindFor(item.mimeType);
    if (kind === 'image') images.push(item);
    else if (kind === 'video') videos.push(item);
  }
  return { images, videos };
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

export function fileNameFor(item: MediaItem, index: number): string {
  const mimeType = normalizeMimeType(item.mimeType);
  const fromKey = item.key?.split('/').pop();
  if (fromKey && /\.[a-z0-9]{2,4}$/i.test(fromKey)) return fromKey;
  return `media-${index + 1}.${extensionFor(mimeType) ?? 'bin'}`;
}

/**
 * Fetch one media item. `maxBytes` is enforced twice: against the recorded size before
 * the request, and against the body afterwards, since the record can be stale.
 */
export async function downloadMedia(
  http: HttpClient,
  item: MediaItem,
  options: { maxBytes: number; index?: number; timeoutMs?: number; tooLargeMessage?: string },
): Promise<DownloadedMedia> {
  const mimeType = normalizeMimeType(item.mimeType);
  const tooLarge = options.tooLargeMessage ?? `Media is larger than ${Math.round(options.maxBytes / (1024 * 1024))} MB.`;
  if (typeof item.sizeBytes === 'number' && item.sizeBytes > options.maxBytes) {
    throw ProviderError.invalid(tooLarge);
  }
  const bytes = await http.bytes(item.url, {
    method: 'GET',
    accept: 'bytes',
    timeoutMs: options.timeoutMs ?? 60_000,
    label: 'media download',
  });
  if (bytes.byteLength > options.maxBytes) throw ProviderError.invalid(tooLarge);
  if (bytes.byteLength === 0) throw ProviderError.invalid('Media file is empty.');
  return { bytes, mimeType, fileName: fileNameFor(item, options.index ?? 0), sizeBytes: bytes.byteLength };
}

/** Node 22 has Blob/FormData globally; adapters build multipart bodies through this. */
export function toBlob(media: DownloadedMedia): Blob {
  // Copy into a fresh ArrayBuffer so a pooled Node buffer view cannot leak extra bytes.
  const copy = new Uint8Array(media.bytes.byteLength);
  copy.set(media.bytes);
  return new Blob([copy], { type: media.mimeType });
}

export function altTextOf(item: MediaItem): string {
  return (item.altText ?? '').trim();
}
