// Message builders (pure): text + inline keyboard for each bot screen.
// Callback data is `p:<action>:<post_id>` for posts and `c:<action>:<reply_id>` for
// comment reviews; both stay under Telegram's 64-byte limit.

import type { Channel } from '../domain/types';
import type { InlineKeyboardMarkup, ParseMode } from './api';

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

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

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

export function parseCallbackData(_data: string): ParsedCallback | null {
  return ni('telegram.parseCallbackData');
}

export function buildPostPreviewMessage(_input: PostPreviewInput): TelegramMessageDraft {
  return ni('telegram.buildPostPreviewMessage');
}

export function buildScheduleConfirmation(_input: { postId: string; publishAt: Date; timezone: string }): TelegramMessageDraft {
  return ni('telegram.buildScheduleConfirmation');
}

export function buildPublishOutcomeMessage(_input: PublishOutcomeInput): TelegramMessageDraft {
  return ni('telegram.buildPublishOutcomeMessage');
}

export function buildReplyReviewMessage(_input: ReplyReviewInput): TelegramMessageDraft {
  return ni('telegram.buildReplyReviewMessage');
}

export function buildHelpMessage(_input: { botUsername: string; hasAccounts: boolean }): TelegramMessageDraft {
  return ni('telegram.buildHelpMessage');
}

export function buildLoginLinkMessage(_input: { url: string; expiresInMinutes: number }): TelegramMessageDraft {
  return ni('telegram.buildLoginLinkMessage');
}

export function buildConnectionAlertMessage(_input: {
  provider: string;
  label: string | null;
  reason: string;
  settingsUrl: string;
}): TelegramMessageDraft {
  return ni('telegram.buildConnectionAlertMessage');
}
