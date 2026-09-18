// Outbound bot messages. The core builders (telegram/messages.ts) own the screens the
// bot already has; the three drafts below cover notification kinds that have no builder
// there yet. They are deliberately plain text: the strings they interpolate (a source
// title, a generation goal) come from users, and plain text has no markup to escape.

import { TELEGRAM_MESSAGE_MAX } from '@sm/core/telegram/api';
import type { TelegramMessageDraft } from '@sm/core/telegram/messages';

export interface KnowledgeReadyInput {
  title: string;
  pages: number;
  chunks: number;
  knowledgeUrl: string;
}

export interface ContentReadyInput {
  goal: string;
  postCount: number;
  postsUrl: string;
}

export interface ReplySentInput {
  channel: string;
  authorName: string | null;
  replyText: string;
  permalink: string | null;
}

function clamp(text: string, max = TELEGRAM_MESSAGE_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function quote(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function buildKnowledgeReadyMessage(input: KnowledgeReadyInput): TelegramMessageDraft {
  const lines = [
    '📚 Knowledge updated',
    '',
    quote(input.title, 120),
    `${input.pages} ${input.pages === 1 ? 'page' : 'pages'} · ${input.chunks} ${input.chunks === 1 ? 'passage' : 'passages'} indexed.`,
    '',
    'Replies and AI content can use it now.',
    input.knowledgeUrl,
  ];
  return { text: clamp(lines.join('\n')), disableWebPagePreview: true };
}

export function buildContentReadyMessage(input: ContentReadyInput): TelegramMessageDraft {
  const lines = [
    `✨ ${input.postCount} new post ${input.postCount === 1 ? 'idea' : 'ideas'} ready for review`,
    '',
    input.goal.trim() === '' ? null : `Goal: ${quote(input.goal, 160)}`,
    'They are waiting as drafts — approve or edit before anything goes out.',
    input.postsUrl,
  ].filter((line): line is string => line !== null);
  return { text: clamp(lines.join('\n')), disableWebPagePreview: true };
}

export function buildReplySentMessage(input: ReplySentInput): TelegramMessageDraft {
  const lines = [
    `✅ Reply sent on ${input.channel}`,
    input.authorName ? `To: ${quote(input.authorName, 80)}` : null,
    '',
    quote(input.replyText, 500),
    input.permalink,
  ].filter((line): line is string => line !== null);
  return { text: clamp(lines.join('\n')), disableWebPagePreview: true };
}
