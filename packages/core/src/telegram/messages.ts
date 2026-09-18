// Message builders (pure): text + inline keyboard for each bot screen.
// Callback data is `p:<action>:<post_id>` for posts and `c:<action>:<reply_id>` for
// comment reviews; both stay under Telegram's 64-byte limit.

import type { Channel } from '../domain/types';
import { TELEGRAM_MESSAGE_MAX, type InlineKeyboardMarkup, type ParseMode } from './api';
import { formatLocalTime, safeZone } from './schedule-time';

export interface TelegramMessageDraft {
  text: string;
  parseMode?: ParseMode;
  replyMarkup?: InlineKeyboardMarkup | null;
  disableWebPagePreview?: boolean;
}

export type PostAction = 'publish' | 'schedule' | 'edit' | 'regen' | 'discard';
export type ReplyAction = 'send' | 'edit' | 'ignore';

export interface PostPreviewInput {
  postId: string;
  brief: string;
  captions: { channel: Channel; caption: string }[];
  mediaUrl: string | null;
  timezone: string;
  publishAt?: Date | null;
}

export interface ReplyReviewInput {
  replyId: string;
  channel: Channel;
  authorName: string | null;
  commentText: string;
  suggestedReply: string;
  reasons: string[];
  confidence: number | null;
  permalink: string | null;
}

export interface PublishOutcomeInput {
  postId: string;
  results: { channel: Channel; status: 'published' | 'failed' | 'cancelled'; permalink: string | null; error: string | null }[];
  timezone: string;
}

const CHANNEL_LABELS: Record<Channel, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  telegram: 'Telegram',
  google_business: 'Google Business',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function clamp(value: string): string {
  return value.length <= TELEGRAM_MESSAGE_MAX ? value : `${value.slice(0, TELEGRAM_MESSAGE_MAX - 1)}…`;
}

function urlButton(label: string, url: string | null): InlineKeyboardMarkup | undefined {
  return url ? { inline_keyboard: [[{ text: label, url }]] } : undefined;
}

export function postCallbackData(action: PostAction, postId: string): string {
  return `p:${action}:${postId}`;
}

export function replyCallbackData(action: ReplyAction, replyId: string): string {
  return `c:${action}:${replyId}`;
}

export interface ParsedCallback {
  scope: 'p' | 'c';
  action: string;
  id: string;
}

export function parseCallbackData(data: string): ParsedCallback | null {
  if (typeof data !== 'string' || data.length > 64) return null;
  const [scope, action, id, extra] = data.split(':');
  if (extra !== undefined || (scope !== 'p' && scope !== 'c') || !UUID_RE.test(id ?? '')) return null;
  const valid = scope === 'p'
    ? (['publish', 'schedule', 'edit', 'regen', 'discard'] as const).includes(action as PostAction)
    : (['send', 'edit', 'ignore'] as const).includes(action as ReplyAction);
  return valid ? { scope, action: action ?? '', id: id ?? '' } : null;
}

export function buildPostPreviewMessage(input: PostPreviewInput): TelegramMessageDraft {
  const captions = input.captions.map(({ channel, caption }) =>
    `${CHANNEL_LABELS[channel].toUpperCase()}\n${compact(caption, 1_250)}`,
  );
  const schedule = input.publishAt
    ? `\n\nScheduled: ${formatLocalTime(input.publishAt, safeZone(input.timezone))}`
    : '';
  const text = clamp([
    `📝 Draft · ${input.captions.map(({ channel }) => CHANNEL_LABELS[channel]).join(' + ') || 'No channel selected'}`,
    compact(input.brief, 220),
    ...captions,
    `Nothing posts until you approve it.${schedule}`,
  ].filter(Boolean).join('\n\n'));
  return {
    text,
    disableWebPagePreview: true,
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '🚀 Publish now', callback_data: postCallbackData('publish', input.postId) },
          { text: '🕒 Schedule', callback_data: postCallbackData('schedule', input.postId) },
        ],
        [
          { text: '✏️ Edit', callback_data: postCallbackData('edit', input.postId) },
          { text: '🔁 Regenerate', callback_data: postCallbackData('regen', input.postId) },
          { text: '🗑 Discard', callback_data: postCallbackData('discard', input.postId) },
        ],
      ],
    },
  };
}

export function buildScheduleConfirmation(input: { postId: string; publishAt: Date; timezone: string }): TelegramMessageDraft {
  return {
    text: `✅ Scheduled for ${formatLocalTime(input.publishAt, safeZone(input.timezone))}.`,
    replyMarkup: {
      inline_keyboard: [[
        { text: '🚀 Publish now', callback_data: postCallbackData('publish', input.postId) },
        { text: '🗑 Cancel post', callback_data: postCallbackData('discard', input.postId) },
      ]],
    },
  };
}

export function buildPublishOutcomeMessage(input: PublishOutcomeInput): TelegramMessageDraft {
  const icon = { published: '✅', failed: '❌', cancelled: '⏹' } as const;
  const lines = input.results.map((result) => {
    const detail = result.permalink ?? result.error;
    return `${icon[result.status]} ${CHANNEL_LABELS[result.channel]}${detail ? ` — ${compact(detail, 300)}` : ''}`;
  });
  const succeeded = input.results.filter(({ status }) => status === 'published').length;
  return {
    text: clamp([succeeded === input.results.length ? '🎉 Post published' : 'Publishing finished', '', ...lines].join('\n')),
    disableWebPagePreview: false,
  };
}

export function buildReplyReviewMessage(input: ReplyReviewInput): TelegramMessageDraft {
  const confidence = input.confidence === null ? 'not scored' : `${Math.round(input.confidence * 100)}% confidence`;
  const reasons = input.reasons.length ? `\nReview reason: ${input.reasons.map((item) => compact(item, 80)).join(', ')}` : '';
  return {
    text: clamp([
      `💬 Reply review · ${CHANNEL_LABELS[input.channel]}`,
      `${input.authorName ? `${compact(input.authorName, 80)}: ` : ''}${compact(input.commentText, 700)}`,
      `Suggested reply (${confidence}):\n${compact(input.suggestedReply, 1_400)}${reasons}`,
      input.permalink,
    ].filter((line): line is string => Boolean(line)).join('\n\n')),
    disableWebPagePreview: true,
    replyMarkup: {
      inline_keyboard: [[
        { text: '✅ Send', callback_data: replyCallbackData('send', input.replyId) },
        { text: '✏️ Edit', callback_data: replyCallbackData('edit', input.replyId) },
        { text: 'Ignore', callback_data: replyCallbackData('ignore', input.replyId) },
      ]],
    },
  };
}

export function buildHelpMessage(input: { botUsername: string; hasAccounts: boolean }): TelegramMessageDraft {
  const start = input.hasAccounts
    ? 'Send a brief or a photo with its caption. I will draft channel-specific copy for approval.'
    : 'Connect at least one social account in your dashboard, then send a brief or photo.';
  return {
    text: [
      `👋 @${input.botUsername.replace(/^@/, '')} is your social publishing assistant.`,
      start,
      'Commands:\n/new <brief> — create a post\n/dashboard — secure one-time login\n/cancel — stop the current edit or schedule',
      'Nothing posts until you approve it. AI replies stay behind your automation rules.',
    ].join('\n\n'),
  };
}

export function buildLoginLinkMessage(input: { url: string; expiresInMinutes: number }): TelegramMessageDraft {
  return {
    text: `🔐 Secure dashboard link. One use; expires in ${input.expiresInMinutes} minutes.`,
    replyMarkup: urlButton('📊 Open dashboard', input.url),
    disableWebPagePreview: true,
  };
}

export function buildConnectionAlertMessage(input: {
  provider: string;
  label: string | null;
  reason: string;
  settingsUrl: string;
}): TelegramMessageDraft {
  return {
    text: clamp([
      `⚠️ ${input.label || input.provider} needs attention`,
      compact(input.reason, 700),
      'Reconnect it before the next scheduled post.',
    ].join('\n\n')),
    replyMarkup: urlButton('Fix connection', input.settingsUrl),
    disableWebPagePreview: true,
  };
}
