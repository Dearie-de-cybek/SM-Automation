// Per-channel publishing rules. Imported by the worker AND by client components in the
// dashboard (live caption counters), so this file must stay free of node imports.

import { CHANNELS, type Channel, type MediaItem } from './domain/types';

export type TextCountMode = 'unit' | 'grapheme';

export interface ChannelRules {
  channel: Channel;
  label: string;
  /** Maximum caption/post length, counted with `countMode`. */
  textMax: number;
  /** Bluesky counts graphemes, everyone else counts UTF-16 units. */
  countMode: TextCountMode;
  hashtagMax: number;
  maxImages: number;
  maxVideos: number;
  /** The channel refuses text-only posts. */
  needsMedia: boolean;
  /** A link in the text is followed/unfurled rather than ignored. */
  supportsLink: boolean;
  imageMimeTypes: readonly string[];
  videoMimeTypes: readonly string[];
  maxImageBytes: number | null;
  maxVideoBytes: number | null;
  /** Channels that require a separate title (YouTube). */
  titleMax: number | null;
  requiresTitle: boolean;
}

const JPEG_ONLY = ['image/jpeg'] as const;
const COMMON_IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
const COMMON_VIDEOS = ['video/mp4', 'video/quicktime'] as const;
const MB = 1024 * 1024;

export const CHANNEL_RULES: Record<Channel, ChannelRules> = {
  facebook: {
    channel: 'facebook',
    label: 'Facebook Page',
    textMax: 63206,
    countMode: 'unit',
    hashtagMax: 30,
    maxImages: 10,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: COMMON_IMAGES,
    videoMimeTypes: COMMON_VIDEOS,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 200 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  instagram: {
    channel: 'instagram',
    label: 'Instagram',
    textMax: 2200,
    countMode: 'unit',
    hashtagMax: 30,
    maxImages: 10,
    maxVideos: 1,
    // The Content Publishing API has no text-only post type.
    needsMedia: true,
    supportsLink: false,
    // Graph API only accepts JPEG for image containers.
    imageMimeTypes: JPEG_ONLY,
    videoMimeTypes: ['video/mp4'],
    maxImageBytes: 8 * MB,
    maxVideoBytes: 100 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  threads: {
    channel: 'threads',
    label: 'Threads',
    textMax: 500,
    countMode: 'unit',
    hashtagMax: 1,
    maxImages: 10,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: ['image/jpeg', 'image/png'],
    videoMimeTypes: ['video/mp4'],
    maxImageBytes: 8 * MB,
    maxVideoBytes: 100 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  x: {
    channel: 'x',
    label: 'X',
    textMax: 280,
    countMode: 'unit',
    hashtagMax: 10,
    maxImages: 4,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: COMMON_IMAGES,
    videoMimeTypes: ['video/mp4'],
    maxImageBytes: 5 * MB,
    maxVideoBytes: 512 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  linkedin: {
    channel: 'linkedin',
    label: 'LinkedIn',
    textMax: 3000,
    countMode: 'unit',
    hashtagMax: 10,
    maxImages: 9,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    videoMimeTypes: ['video/mp4'],
    maxImageBytes: 8 * MB,
    maxVideoBytes: 200 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  tiktok: {
    channel: 'tiktok',
    label: 'TikTok',
    textMax: 2200,
    countMode: 'unit',
    hashtagMax: 20,
    maxImages: 35,
    maxVideos: 1,
    needsMedia: true,
    supportsLink: false,
    imageMimeTypes: ['image/jpeg', 'image/webp'],
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    maxImageBytes: 20 * MB,
    maxVideoBytes: 500 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  youtube: {
    channel: 'youtube',
    label: 'YouTube',
    textMax: 5000,
    countMode: 'unit',
    hashtagMax: 15,
    maxImages: 0,
    maxVideos: 1,
    needsMedia: true,
    supportsLink: true,
    imageMimeTypes: [],
    videoMimeTypes: ['video/mp4', 'video/quicktime'],
    maxImageBytes: null,
    maxVideoBytes: 2048 * MB,
    titleMax: 100,
    requiresTitle: true,
  },
  pinterest: {
    channel: 'pinterest',
    label: 'Pinterest',
    textMax: 500,
    countMode: 'unit',
    hashtagMax: 20,
    maxImages: 1,
    maxVideos: 1,
    needsMedia: true,
    supportsLink: true,
    imageMimeTypes: ['image/jpeg', 'image/png'],
    videoMimeTypes: ['video/mp4'],
    maxImageBytes: 20 * MB,
    maxVideoBytes: 200 * MB,
    titleMax: 100,
    requiresTitle: false,
  },
  bluesky: {
    channel: 'bluesky',
    label: 'Bluesky',
    // 300 graphemes, not characters: emoji and combining marks count as one.
    textMax: 300,
    countMode: 'grapheme',
    hashtagMax: 8,
    maxImages: 4,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    videoMimeTypes: ['video/mp4'],
    maxImageBytes: 2 * MB,
    maxVideoBytes: 50 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  mastodon: {
    channel: 'mastodon',
    label: 'Mastodon',
    textMax: 500,
    countMode: 'unit',
    hashtagMax: 10,
    maxImages: 4,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: COMMON_IMAGES,
    videoMimeTypes: COMMON_VIDEOS,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 40 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  telegram: {
    channel: 'telegram',
    label: 'Telegram channel',
    // 4096 for a text message; a media caption is capped at 1024 (see captionMaxFor).
    textMax: 4096,
    countMode: 'unit',
    hashtagMax: 20,
    maxImages: 10,
    maxVideos: 1,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: COMMON_IMAGES,
    videoMimeTypes: COMMON_VIDEOS,
    maxImageBytes: 10 * MB,
    maxVideoBytes: 50 * MB,
    titleMax: null,
    requiresTitle: false,
  },
  google_business: {
    channel: 'google_business',
    label: 'Google Business Profile',
    textMax: 1500,
    countMode: 'unit',
    hashtagMax: 0,
    maxImages: 1,
    maxVideos: 0,
    needsMedia: false,
    supportsLink: true,
    imageMimeTypes: ['image/jpeg', 'image/png'],
    videoMimeTypes: [],
    maxImageBytes: 5 * MB,
    maxVideoBytes: null,
    titleMax: 58,
    requiresTitle: false,
  },
};

export const TELEGRAM_CAPTION_MAX = 1024;

export function rulesFor(channel: Channel): ChannelRules {
  return CHANNEL_RULES[channel];
}

/** Effective text limit once media is attached (Telegram captions are shorter). */
export function textLimitFor(channel: Channel, hasMedia: boolean): number {
  const rules = CHANNEL_RULES[channel];
  if (channel === 'telegram' && hasMedia) return TELEGRAM_CAPTION_MAX;
  return rules.textMax;
}

let segmenter: Intl.Segmenter | null | undefined;

function graphemeCount(text: string): number {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!segmenter) return [...text].length;
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/** Length of `text` as the channel counts it. */
export function countText(channel: Channel, text: string): number {
  return CHANNEL_RULES[channel].countMode === 'grapheme' ? graphemeCount(text) : text.length;
}

export function countHashtags(text: string): number {
  return (text.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code:
    | 'text_too_long'
    | 'text_empty'
    | 'too_many_hashtags'
    | 'media_required'
    | 'too_many_images'
    | 'too_many_videos'
    | 'unsupported_image_type'
    | 'unsupported_video_type'
    | 'media_too_large'
    | 'mixed_media'
    | 'link_unsupported'
    | 'title_required'
    | 'title_too_long';
  severity: IssueSeverity;
  message: string;
}

export interface ValidatePostInput {
  text: string;
  media: readonly MediaItem[];
  linkUrl?: string | null;
  title?: string | null;
}

/** Pure, synchronous pre-flight check. Errors block publishing; warnings are advisory. */
export function validatePost(channel: Channel, input: ValidatePostInput): ValidationIssue[] {
  const rules = CHANNEL_RULES[channel];
  const issues: ValidationIssue[] = [];
  const media = input.media ?? [];
  const images = media.filter((item) => item.mimeType.startsWith('image/'));
  const videos = media.filter((item) => item.mimeType.startsWith('video/'));
  const limit = textLimitFor(channel, media.length > 0);
  const length = countText(channel, input.text);

  if (length > limit) {
    issues.push({
      code: 'text_too_long',
      severity: 'error',
      message: `${rules.label}: ${length} of ${limit} characters — trim ${length - limit}.`,
    });
  }
  if (input.text.trim() === '' && !rules.needsMedia && media.length === 0) {
    issues.push({ code: 'text_empty', severity: 'error', message: `${rules.label}: the post is empty.` });
  }
  const hashtags = countHashtags(input.text);
  if (hashtags > rules.hashtagMax) {
    issues.push({
      code: 'too_many_hashtags',
      severity: rules.hashtagMax === 0 ? 'warning' : 'error',
      message: `${rules.label}: ${hashtags} hashtags, maximum ${rules.hashtagMax}.`,
    });
  }
  if (rules.needsMedia && media.length === 0) {
    issues.push({ code: 'media_required', severity: 'error', message: `${rules.label} needs an image or video.` });
  }
  if (images.length > rules.maxImages) {
    issues.push({
      code: 'too_many_images',
      severity: 'error',
      message: `${rules.label}: ${images.length} images, maximum ${rules.maxImages}.`,
    });
  }
  if (videos.length > rules.maxVideos) {
    issues.push({
      code: 'too_many_videos',
      severity: 'error',
      message: `${rules.label}: ${videos.length} videos, maximum ${rules.maxVideos}.`,
    });
  }
  if (images.length > 0 && videos.length > 0) {
    issues.push({ code: 'mixed_media', severity: 'error', message: `${rules.label} cannot mix images and video in one post.` });
  }
  for (const item of images) {
    if (!rules.imageMimeTypes.includes(item.mimeType)) {
      issues.push({
        code: 'unsupported_image_type',
        severity: 'error',
        message: `${rules.label} does not accept ${item.mimeType}${
          rules.imageMimeTypes.length > 0 ? ` (allowed: ${rules.imageMimeTypes.join(', ')})` : ''
        }.`,
      });
    }
    if (rules.maxImageBytes !== null && typeof item.sizeBytes === 'number' && item.sizeBytes > rules.maxImageBytes) {
      issues.push({
        code: 'media_too_large',
        severity: 'error',
        message: `${rules.label}: image is larger than ${Math.round(rules.maxImageBytes / MB)} MB.`,
      });
    }
  }
  for (const item of videos) {
    if (!rules.videoMimeTypes.includes(item.mimeType)) {
      issues.push({
        code: 'unsupported_video_type',
        severity: 'error',
        message: `${rules.label} does not accept ${item.mimeType}.`,
      });
    }
    if (rules.maxVideoBytes !== null && typeof item.sizeBytes === 'number' && item.sizeBytes > rules.maxVideoBytes) {
      issues.push({
        code: 'media_too_large',
        severity: 'error',
        message: `${rules.label}: video is larger than ${Math.round(rules.maxVideoBytes / MB)} MB.`,
      });
    }
  }
  if (input.linkUrl && !rules.supportsLink) {
    issues.push({
      code: 'link_unsupported',
      severity: 'warning',
      message: `${rules.label} does not make links clickable.`,
    });
  }
  const title = input.title ?? '';
  if (rules.requiresTitle && title.trim() === '') {
    issues.push({ code: 'title_required', severity: 'error', message: `${rules.label} needs a title.` });
  }
  if (rules.titleMax !== null && title.length > rules.titleMax) {
    issues.push({
      code: 'title_too_long',
      severity: 'error',
      message: `${rules.label}: title is ${title.length} of ${rules.titleMax} characters.`,
    });
  }
  return issues;
}

export function hasBlockingIssues(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function splitUnits(text: string, mode: TextCountMode): string[] {
  if (mode !== 'grapheme') return [...text];
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!segmenter) return [...text];
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

/** Hard-trim at a word boundary (last resort after the AI repair round). */
export function trimToLimit(text: string, limit: number, mode: TextCountMode = 'unit'): string {
  const count = (value: string) => (mode === 'grapheme' ? graphemeCount(value) : value.length);
  if (count(text) <= limit) return text;

  const ellipsis = '…';
  const budget = Math.max(1, limit - count(ellipsis));
  // Never split a surrogate pair or a combining sequence: cut on whole units.
  const parts = splitUnits(text, mode);
  let cut = '';
  let used = 0;
  for (const part of parts) {
    const cost = mode === 'grapheme' ? 1 : part.length;
    if (used + cost > budget) break;
    cut += part;
    used += cost;
  }
  const lastSpace = cut.lastIndexOf(' ');
  // Only back up to a word boundary when that does not throw most of the text away.
  if (lastSpace > 0 && lastSpace >= cut.length * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?-]+$/u, '')}${ellipsis}`;
}

/** Trim a caption to what the channel accepts for the given media set. */
export function trimForChannel(channel: Channel, text: string, hasMedia: boolean): string {
  const rules = CHANNEL_RULES[channel];
  return trimToLimit(text, textLimitFor(channel, hasMedia), rules.countMode);
}

export const ALL_CHANNEL_RULES: readonly ChannelRules[] = CHANNELS.map((channel) => CHANNEL_RULES[channel]);
