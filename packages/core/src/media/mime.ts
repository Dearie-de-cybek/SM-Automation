// Upload allowlist. Anything not on this list never reaches object storage.

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const DOCUMENT_MIME_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/pdf'] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];
export type MediaKind = 'image' | 'video';

const MB = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * MB;
export const MAX_VIDEO_BYTES = 200 * MB;
/** Knowledge uploads are parsed server-side, so they stay small. */
export const MAX_DOCUMENT_BYTES = 5 * MB;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
};

/** Strip parameters and casing: "IMAGE/JPEG; charset=x" → "image/jpeg". */
export function normalizeMimeType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(normalizeMimeType(value));
}

export function isVideoMimeType(value: string): value is VideoMimeType {
  return (VIDEO_MIME_TYPES as readonly string[]).includes(normalizeMimeType(value));
}

export function isDocumentMimeType(value: string): value is DocumentMimeType {
  return (DOCUMENT_MIME_TYPES as readonly string[]).includes(normalizeMimeType(value));
}

export function isAllowedMediaType(value: string): boolean {
  return isImageMimeType(value) || isVideoMimeType(value);
}

export function mediaKindFor(value: string): MediaKind | null {
  if (isImageMimeType(value)) return 'image';
  if (isVideoMimeType(value)) return 'video';
  return null;
}

export function maxBytesFor(value: string): number | null {
  if (isImageMimeType(value)) return MAX_IMAGE_BYTES;
  if (isVideoMimeType(value)) return MAX_VIDEO_BYTES;
  if (isDocumentMimeType(value)) return MAX_DOCUMENT_BYTES;
  return null;
}

export function extensionFor(value: string): string | null {
  return EXTENSIONS[normalizeMimeType(value)] ?? null;
}

export type UploadCheck =
  | { ok: true; mimeType: string; kind: MediaKind; extension: string; maxBytes: number }
  | { ok: false; error: string };

/** Validate an upload request before handing out a presigned URL. */
export function checkUpload(input: { mimeType: string; sizeBytes: number }): UploadCheck {
  const mimeType = normalizeMimeType(input.mimeType);
  const kind = mediaKindFor(mimeType);
  if (!kind) {
    return { ok: false, error: `Unsupported file type ${mimeType || '(none)'}. Allowed: JPEG, PNG, WebP, GIF, MP4, MOV.` };
  }
  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, error: 'Missing file size.' };
  }
  if (input.sizeBytes > maxBytes) {
    return { ok: false, error: `File is larger than ${Math.round(maxBytes / MB)} MB.` };
  }
  const extension = extensionFor(mimeType) ?? 'bin';
  return { ok: true, mimeType, kind, extension, maxBytes };
}
