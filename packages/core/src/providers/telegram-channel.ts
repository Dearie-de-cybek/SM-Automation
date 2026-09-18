// Telegram channel adapter: the client's bot posts into a channel it administers.
// Send-by-URL is capped at 5 MB for photos and 20 MB for video; larger media must be
// downloaded and uploaded as multipart.
//
// The bot token sits in the request path, so every call passes an explicit `label` and
// the URL never reaches a log line or an error message.

import { TELEGRAM_CAPTION_MAX } from '../platform-rules';
import type { Channel, MediaItem } from '../domain/types';
import { ProviderError } from './errors';
import { errorField, errorNumber, sealPublishRetry, statusOf } from './_posting/error-body';
import { downloadMedia, splitMedia, toBlob, type DownloadedMedia } from './_posting/media';
import type {
  Capabilities,
  ProviderContext,
  PublishInput,
  PublishResult,
  SocialProvider,
  ValidatedAccount,
} from './types';
import type { HttpClient } from './http';

export const TELEGRAM_CHANNELS: Channel[] = ['telegram'];

export interface TelegramChannelCredentials {
  botToken: string;
  /** @channelusername or a numeric -100… chat id. */
  chatId: string;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_MESSAGE_MAX = 4096;
/** Limits for media Telegram fetches from a URL itself. */
const URL_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const URL_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
/** Limits for media we upload as multipart. */
const UPLOAD_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const MAX_ALBUM_ITEMS = 10;

const CAPABILITIES: Capabilities = {
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: MAX_ALBUM_ITEMS,
  // Channel comments live in a linked discussion group, which we do not manage yet.
  readComments: false,
  replyComments: false,
  hideComments: false,
  webhooks: false,
};

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat?: TelegramChat;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface TelegramChatMember {
  status: string;
  can_post_messages?: boolean;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function botToken(ctx: ProviderContext): string {
  const token = ctx.credentials['botToken'];
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ProviderError('auth', 'Telegram connection has no bot token. Reconnect it in Settings.');
  }
  return token.trim();
}

function chatIdOf(ctx: ProviderContext): string {
  const fromAccount = ctx.account.externalId?.trim();
  if (fromAccount) return fromAccount;
  const fromCredentials = ctx.credentials['chatId'];
  if (typeof fromCredentials === 'string' && fromCredentials.trim() !== '') return fromCredentials.trim();
  throw ProviderError.invalid('Telegram channel is not configured: no chat id.');
}

function mapTelegramError(error: unknown, action: string): ProviderError {
  const mapped = ProviderError.from(error);
  const description = errorField(error, 'description') ?? '';
  const status = statusOf(error) ?? errorNumber(error, 'error_code');
  const text = `Telegram ${action}${description ? `: ${description}` : ''}`;

  if (status === 429) {
    const retryAfter = errorNumber(error, 'retry_after');
    // Flood control rejects the message before it is sent.
    return new ProviderError('rate_limit', text, { status, safeToRetry: true, retryAfterSec: retryAfter ?? 30 });
  }
  if (status === 401) {
    return new ProviderError('auth', `${text} — the bot token is invalid or was revoked.`, { status });
  }
  if (status === 403) {
    return new ProviderError('permission', `${text} — add the bot to the channel as an admin with "Post Messages".`, { status });
  }
  if (status === 413) return new ProviderError('invalid', `${text} — the file is too large for Telegram.`, { status });
  if (status === 400) {
    if (/chat not found/i.test(description)) return new ProviderError('not_found', text, { status });
    if (/not enough rights|need administrator/i.test(description)) {
      return new ProviderError('permission', `${text} — give the bot the "Post Messages" right.`, { status });
    }
    return new ProviderError('invalid', text, { status });
  }
  return new ProviderError(mapped.kind, text, {
    status,
    safeToRetry: mapped.safeToRetry,
    retryAfterSec: mapped.retryAfterSec,
    providerCode: mapped.providerCode,
    cause: mapped,
  });
}

interface BotResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callBot<T>(
  http: HttpClient,
  token: string,
  method: string,
  payload: Record<string, unknown> | FormData,
  timeoutMs = 60_000,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const response = await http.json<BotResponse<T>>(url, {
    method: 'POST',
    ...(payload instanceof FormData ? { multipart: payload } : { json: payload }),
    timeoutMs,
    label: `Telegram ${method}`,
  });
  if (!response.ok || response.result === undefined) {
    throw ProviderError.invalid(`Telegram ${method}: ${response.description ?? 'request was not accepted'}`);
  }
  return response.result;
}

// ---------------------------------------------------------------------------
// Media planning
// ---------------------------------------------------------------------------

interface Attachment {
  item: MediaItem;
  kind: 'photo' | 'video';
  /** Telegram cannot fetch this one itself: we must upload the bytes. */
  upload: boolean;
}

function planAttachments(input: PublishInput): Attachment[] {
  const { images, videos } = splitMedia(input.media);
  const ordered = [...images, ...videos].slice(0, MAX_ALBUM_ITEMS);
  return ordered.map((item) => {
    const kind: 'photo' | 'video' = item.mimeType.startsWith('video/') ? 'video' : 'photo';
    const urlCap = kind === 'photo' ? URL_PHOTO_MAX_BYTES : URL_VIDEO_MAX_BYTES;
    const uploadCap = kind === 'photo' ? UPLOAD_PHOTO_MAX_BYTES : UPLOAD_VIDEO_MAX_BYTES;
    const size = typeof item.sizeBytes === 'number' ? item.sizeBytes : null;
    if (size !== null && size > uploadCap) {
      throw ProviderError.invalid(
        `Telegram bots cannot send ${kind === 'photo' ? 'photos' : 'videos'} larger than ${Math.round(uploadCap / (1024 * 1024))} MB.`,
      );
    }
    return { item, kind, upload: size !== null && size > urlCap };
  });
}

async function fetchAttachment(http: HttpClient, attachment: Attachment, index: number): Promise<DownloadedMedia> {
  const maxBytes = attachment.kind === 'photo' ? UPLOAD_PHOTO_MAX_BYTES : UPLOAD_VIDEO_MAX_BYTES;
  return downloadMedia(http, attachment.item, {
    maxBytes,
    index,
    timeoutMs: 180_000,
    tooLargeMessage: `Telegram bots cannot send ${attachment.kind === 'photo' ? 'photos' : 'videos'} larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`,
  });
}

/** Telegram could not fetch the URL itself — resend with the bytes attached. */
function isUrlFetchFailure(error: ProviderError): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('failed to get http url content') ||
    message.includes('wrong file identifier') ||
    message.includes('wrong type of the web page content') ||
    message.includes('wrong remote file identifier') ||
    message.includes('http url specified')
  );
}

async function sendSingle(
  ctx: ProviderContext,
  token: string,
  chatId: string,
  attachment: Attachment,
  caption: string,
  forceUpload: boolean,
): Promise<TelegramMessage> {
  const method = attachment.kind === 'photo' ? 'sendPhoto' : 'sendVideo';
  const field = attachment.kind === 'photo' ? 'photo' : 'video';
  if (attachment.upload || forceUpload) {
    const file = await fetchAttachment(ctx.http, attachment, 0);
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append(field, toBlob(file), file.fileName);
    if (caption) form.append('caption', caption);
    if (attachment.kind === 'video') form.append('supports_streaming', 'true');
    return callBot<TelegramMessage>(ctx.http, token, method, form, 300_000);
  }
  return callBot<TelegramMessage>(ctx.http, token, method, {
    chat_id: chatId,
    [field]: attachment.item.url,
    ...(caption ? { caption } : {}),
    ...(attachment.kind === 'video' ? { supports_streaming: true } : {}),
  });
}

async function sendAlbum(
  ctx: ProviderContext,
  token: string,
  chatId: string,
  attachments: Attachment[],
  caption: string,
  forceUpload: boolean,
): Promise<TelegramMessage[]> {
  const uploads = new Map<number, DownloadedMedia>();
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.upload || forceUpload) uploads.set(index, await fetchAttachment(ctx.http, attachment, index));
  }

  const media = attachments.map((attachment, index) => ({
    type: attachment.kind,
    media: uploads.has(index) ? `attach://file${index}` : attachment.item.url,
    // Clients show the first item's caption as the album caption.
    ...(index === 0 && caption ? { caption } : {}),
  }));

  if (uploads.size === 0) {
    return callBot<TelegramMessage[]>(ctx.http, token, 'sendMediaGroup', { chat_id: chatId, media });
  }
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('media', JSON.stringify(media));
  for (const [index, file] of uploads) form.append(`file${index}`, toBlob(file), file.fileName);
  return callBot<TelegramMessage[]>(ctx.http, token, 'sendMediaGroup', form, 300_000);
}

function channelUsername(ctx: ProviderContext): string | null {
  const fromMeta = ctx.account.meta['username'];
  if (typeof fromMeta === 'string' && fromMeta.trim() !== '') return fromMeta.trim().replace(/^@/, '');
  const handle = ctx.account.handle?.trim() ?? '';
  if (handle.startsWith('@')) return handle.slice(1);
  return null;
}

function permalinkFor(chatId: string, username: string | null, messageId: number): string | null {
  // message_id is 0 when Telegram queued the message instead of sending it.
  if (!messageId) return null;
  if (username) return `https://t.me/${username}/${messageId}`;
  const internal = chatId.replace(/^-100/, '');
  return /^\d+$/.test(internal) ? `https://t.me/c/${internal}/${messageId}` : null;
}

// ---------------------------------------------------------------------------
// Provider methods
// ---------------------------------------------------------------------------

async function validateChannel(ctx: ProviderContext): Promise<ValidatedAccount> {
  const token = botToken(ctx);
  const chatId = chatIdOf(ctx);
  try {
    const me = await callBot<TelegramUser>(ctx.http, token, 'getMe', {});
    const chat = await callBot<TelegramChat>(ctx.http, token, 'getChat', { chat_id: chatId });
    if (chat.type !== 'channel') {
      throw ProviderError.invalid(`"${chatId}" is a ${chat.type}, not a channel. Connect a channel the bot administers.`);
    }
    const member = await callBot<TelegramChatMember>(ctx.http, token, 'getChatMember', { chat_id: chat.id, user_id: me.id });
    if (member.status !== 'administrator' || member.can_post_messages !== true) {
      throw new ProviderError(
        'permission',
        'The bot must be an administrator of this channel with the "Post Messages" right. Add it in Telegram, then try again.',
      );
    }
    const username = chat.username ?? null;
    return {
      externalId: String(chat.id),
      handle: username ? `@${username}` : String(chat.id),
      displayName: chat.title ?? username ?? String(chat.id),
      avatarUrl: null,
    };
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw mapTelegramError(error, 'channel check');
  }
}

async function publishToChannel(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
  const token = botToken(ctx);
  const chatId = chatIdOf(ctx);
  const username = channelUsername(ctx);
  const text = (input.text ?? '').trim();
  const attachments = planAttachments(input);

  if (attachments.length === 0) {
    if (!text) throw ProviderError.invalid('Nothing to publish: the post has no text and no media.');
    if (text.length > TELEGRAM_MESSAGE_MAX) {
      throw ProviderError.invalid(`Telegram messages are limited to ${TELEGRAM_MESSAGE_MAX} characters.`);
    }
    try {
      const message = await callBot<TelegramMessage>(ctx.http, token, 'sendMessage', { chat_id: chatId, text });
      return {
        externalId: String(message.message_id),
        permalink: permalinkFor(chatId, username, message.message_id),
        raw: { messageIds: [message.message_id] },
      };
    } catch (error: unknown) {
      throw sealPublishRetry(mapTelegramError(error, 'sendMessage'), 'interrupted — check the channel before retrying');
    }
  }

  // A caption over 1024 characters is impossible: send the media, then the full text as
  // a reply so nothing is silently truncated.
  const captionFits = text.length <= TELEGRAM_CAPTION_MAX;
  const caption = captionFits ? text : '';
  const followUp = captionFits ? '' : text;
  if (followUp.length > TELEGRAM_MESSAGE_MAX) {
    throw ProviderError.invalid(`Telegram messages are limited to ${TELEGRAM_MESSAGE_MAX} characters.`);
  }

  const send = async (forceUpload: boolean): Promise<TelegramMessage[]> => {
    const first = attachments[0];
    if (attachments.length === 1 && first) {
      return [await sendSingle(ctx, token, chatId, first, caption, forceUpload)];
    }
    return sendAlbum(ctx, token, chatId, attachments, caption, forceUpload);
  };

  let messages: TelegramMessage[];
  try {
    messages = await send(false);
  } catch (error: unknown) {
    const mapped = mapTelegramError(error, 'send media');
    // Telegram rejected our URL before sending anything, so uploading the bytes once is
    // safe and usually fixes it (private host, slow origin, wrong content type).
    if (mapped.kind === 'invalid' && isUrlFetchFailure(mapped)) {
      try {
        messages = await send(true);
      } catch (retryError: unknown) {
        throw sealPublishRetry(mapTelegramError(retryError, 'send media'), 'interrupted — check the channel before retrying');
      }
    } else {
      throw sealPublishRetry(mapped, 'interrupted — check the channel before retrying');
    }
  }

  const first = messages[0];
  if (!first) throw new ProviderError('unknown', 'Telegram accepted the post but returned no message.');

  if (followUp) {
    try {
      await callBot<TelegramMessage>(ctx.http, token, 'sendMessage', {
        chat_id: chatId,
        text: followUp,
        reply_parameters: { message_id: first.message_id },
      });
    } catch {
      // The media is already published; a missing text follow-up must not fail the target.
    }
  }

  return {
    externalId: String(first.message_id),
    permalink: permalinkFor(chatId, username ?? first.chat?.username ?? null, first.message_id),
    raw: { messageIds: messages.map((message) => message.message_id) },
  };
}

export function createTelegramChannelProvider(): SocialProvider {
  return {
    id: 'telegram',
    channels: TELEGRAM_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(ctx: ProviderContext): Promise<ValidatedAccount> {
      return validateChannel(ctx);
    },
    publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      return publishToChannel(ctx, input);
    },
  };
}
