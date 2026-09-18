// Bot API client. Only the methods the bot actually uses, typed narrowly.
//
// The bot token sits in the URL path, so every request carries a `label` and the URL
// itself never reaches a log or an error message.

import { ProviderError } from '../providers/errors';
import { createHttpClient, type HttpClient } from '../providers/http';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_MESSAGE_MAX = 4096;
export const TELEGRAM_CAPTION_MAX = 1024;
/** Send-by-URL limits; larger media must be uploaded as multipart. */
export const TELEGRAM_URL_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const TELEGRAM_URL_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
/** getFile downloads: the bot file endpoint serves at most 20 MB. */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type ParseMode = 'HTML' | 'MarkdownV2';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramMessageRef {
  chatId: string | number;
  messageId: number;
}

export interface SendMessageOptions {
  parseMode?: ParseMode;
  replyMarkup?: InlineKeyboardMarkup | null;
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  replyToMessageId?: number;
}

export interface SendPhotoOptions extends SendMessageOptions {
  caption?: string;
}

export interface SentMessage {
  messageId: number;
  chatId: string;
  date: Date;
}

export interface TelegramFileInfo {
  fileId: string;
  filePath: string | null;
  fileSize: number | null;
}

export interface TelegramBotInfo {
  id: string;
  username: string | null;
  firstName: string;
}

export interface TelegramChatInfo {
  id: string;
  type: string;
  title: string | null;
  username: string | null;
}

export interface TelegramChatMember {
  status: string;
  canPostMessages: boolean;
  canEditMessages: boolean;
  canDeleteMessages: boolean;
}

/** Bot API surface used by the router and the notification jobs. */
export interface TelegramApi {
  sendMessage(chatId: string | number, text: string, options?: SendMessageOptions): Promise<SentMessage>;
  sendPhoto(chatId: string | number, photo: string, options?: SendPhotoOptions): Promise<SentMessage>;
  sendVideo(chatId: string | number, video: string, options?: SendPhotoOptions): Promise<SentMessage>;
  editMessageText(ref: TelegramMessageRef, text: string, options?: SendMessageOptions): Promise<void>;
  editMessageReplyMarkup(ref: TelegramMessageRef, replyMarkup: InlineKeyboardMarkup | null): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string; showAlert?: boolean }): Promise<void>;
  getFile(fileId: string): Promise<TelegramFileInfo>;
  /** Downloads a file through the bot file endpoint (token never leaves the server). */
  downloadFile(filePath: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  setWebhook(url: string, options?: { secretToken?: string; allowedUpdates?: string[] }): Promise<void>;
  deleteWebhook(): Promise<void>;
  getMe(): Promise<TelegramBotInfo>;
  getChat(chatId: string | number): Promise<TelegramChatInfo>;
  getChatMember(chatId: string | number, userId: string | number): Promise<TelegramChatMember>;
  /** Escape hatch for methods this interface does not model (e.g. sendMediaGroup). */
  call<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export interface TelegramApiOptions {
  http?: HttpClient;
  timeoutMs?: number;
  apiBase?: string;
  /** Attempts spent on 429 flood control before giving up. */
  maxRateLimitRetries?: number;
  /** Injectable so tests and callers with their own scheduler never have to really wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface ApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

interface RawMessage {
  message_id?: number;
  date?: number;
  chat?: { id?: number | string };
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_SEC = 60;

/** Telegram reports flood control inside the JSON body, which the shared http client
 * turns into a ProviderError message; recover the seconds from either place. */
function retryAfterFrom(error: ProviderError): number | null {
  if (error.retryAfterSec !== null) return error.retryAfterSec;
  const match = /"retry_after"\s*:\s*(\d+)/.exec(error.message);
  return match ? Number(match[1]) : null;
}

function describes(error: ProviderError, ...needles: string[]): boolean {
  const message = error.message.toLowerCase();
  return needles.some((needle) => message.includes(needle));
}

/** HTTP/transport failure → ProviderError with Telegram's own semantics. */
function classify(method: string, error: unknown, botToken: string): ProviderError {
  if (!(error instanceof ProviderError)) {
    return new ProviderError('unknown', `telegram.${method} failed`);
  }
  const status = error.status;
  if (status === 401) {
    return new ProviderError('auth', `telegram.${method}: bot token rejected`, { status });
  }
  if (status === 403) {
    return new ProviderError('permission', `telegram.${method}: the bot is not allowed in that chat`, {
      status,
    });
  }
  if (status === 429) {
    return new ProviderError('rate_limit', `telegram.${method}: too many requests`, {
      status,
      safeToRetry: true,
      retryAfterSec: retryAfterFrom(error),
    });
  }
  if (status === 400) {
    if (describes(error, 'chat not found', 'user not found', 'message to edit not found')) {
      return new ProviderError('not_found', `telegram.${method}: chat or message not found`, { status });
    }
    if (describes(error, 'not enough rights', 'administrator rights')) {
      return new ProviderError('permission', `telegram.${method}: the bot lacks the required admin right`, {
        status,
      });
    }
    return new ProviderError('invalid', `telegram.${method}: request rejected (${describe(error, botToken)})`, {
      status,
    });
  }

  // Never pass an upstream error through: custom HttpClient implementations can put
  // the token-bearing Telegram URL in their message or cause chain.
  const options = {
    status,
    safeToRetry: error.safeToRetry,
    retryAfterSec: error.retryAfterSec,
    providerCode: error.providerCode,
  };
  if (error.kind === 'auth') return new ProviderError('auth', `telegram.${method}: bot token rejected`, options);
  if (error.kind === 'permission') {
    return new ProviderError('permission', `telegram.${method}: request is not permitted`, options);
  }
  if (error.kind === 'rate_limit') {
    return new ProviderError('rate_limit', `telegram.${method}: too many requests`, options);
  }
  if (error.kind === 'not_found') {
    return new ProviderError('not_found', `telegram.${method}: chat or message not found`, options);
  }
  if (error.kind === 'invalid') {
    return new ProviderError('invalid', `telegram.${method}: request rejected`, options);
  }
  if (error.kind === 'transient') {
    return new ProviderError('transient', `telegram.${method}: Telegram is temporarily unavailable`, options);
  }
  return new ProviderError('unknown', `telegram.${method} failed`, options);
}

/** Telegram's human description, without the URL or the JSON envelope. */
function describe(error: ProviderError, botToken: string): string {
  const match = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(error.message);
  if (!match?.[1]) return 'bad request';
  try {
    return (JSON.parse(`"${match[1]}"`) as string).replaceAll(botToken, '[redacted]');
  } catch {
    return match[1].replaceAll(botToken, '[redacted]');
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toSentMessage(message: RawMessage, chatId: string | number): SentMessage {
  return {
    messageId: message.message_id ?? 0,
    chatId: String(message.chat?.id ?? chatId),
    date: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000),
  };
}

function messageParams(options: SendMessageOptions | undefined): Record<string, unknown> {
  if (!options) return {};
  return {
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    ...(options.disableWebPagePreview ? { link_preview_options: { is_disabled: true } } : {}),
    ...(options.disableNotification ? { disable_notification: true } : {}),
    ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
  };
}

export function createTelegramApi(botToken: string, options: TelegramApiOptions = {}): TelegramApi {
  if (!botToken.trim()) throw new Error('createTelegramApi: a bot token is required');
  const http = options.http ?? createHttpClient({ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const base = (options.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  const requestedRetries = options.maxRateLimitRetries ?? 2;
  const maxRateLimitRetries = Number.isFinite(requestedRetries)
    ? Math.min(5, Math.max(0, Math.floor(requestedRetries)))
    : 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wait = options.sleep ?? defaultSleep;

  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        const envelope = await http.json<ApiEnvelope<T>>(`${base}/bot${botToken}/${method}`, {
          method: 'POST',
          json: params,
          timeoutMs,
          label: `telegram.${method}`,
          accept: 'json',
        });
        if (!envelope.ok) {
          // Telegram's contract is the envelope, not the HTTP status. Some proxies
          // preserve a 200 while forwarding ok:false, so classify error_code here too.
          const status = envelope.error_code ?? 400;
          throw ProviderError.fromHttpStatus(
            status,
            `telegram.${method} failed: ${JSON.stringify({
              description: envelope.description ?? 'request rejected',
              parameters: envelope.parameters ?? {},
            })}`,
            { retryAfterSec: envelope.parameters?.retry_after ?? null },
          );
        }
        return envelope.result as T;
      } catch (error: unknown) {
        const mapped = classify(method, error, botToken);
        // Flood control rejects before the message is sent, so retrying cannot duplicate.
        if (mapped.kind === 'rate_limit' && attempt < maxRateLimitRetries) {
          attempt += 1;
          await wait(Math.min(mapped.retryAfterSec ?? 1, MAX_RETRY_AFTER_SEC) * 1000);
          continue;
        }
        throw mapped;
      }
    }
  }

  return {
    call,

    async sendMessage(chatId, text, sendOptions) {
      const message = await call<RawMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...messageParams(sendOptions),
      });
      return toSentMessage(message, chatId);
    },

    async sendPhoto(chatId, photo, sendOptions) {
      const message = await call<RawMessage>('sendPhoto', {
        chat_id: chatId,
        photo,
        ...(sendOptions?.caption ? { caption: sendOptions.caption } : {}),
        ...messageParams(sendOptions),
      });
      return toSentMessage(message, chatId);
    },

    async sendVideo(chatId, video, sendOptions) {
      const message = await call<RawMessage>('sendVideo', {
        chat_id: chatId,
        video,
        supports_streaming: true,
        ...(sendOptions?.caption ? { caption: sendOptions.caption } : {}),
        ...messageParams(sendOptions),
      });
      return toSentMessage(message, chatId);
    },

    async editMessageText(ref, text, sendOptions) {
      await call<unknown>('editMessageText', {
        chat_id: ref.chatId,
        message_id: ref.messageId,
        text,
        ...messageParams(sendOptions),
      });
    },

    async editMessageReplyMarkup(ref, replyMarkup) {
      await call<unknown>('editMessageReplyMarkup', {
        chat_id: ref.chatId,
        message_id: ref.messageId,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
    },

    async answerCallbackQuery(callbackQueryId, answerOptions) {
      await call<boolean>('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(answerOptions?.text ? { text: answerOptions.text.slice(0, 200) } : {}),
        ...(answerOptions?.showAlert ? { show_alert: true } : {}),
      });
    },

    async getFile(fileId) {
      const file = await call<{ file_id: string; file_path?: string; file_size?: number }>('getFile', {
        file_id: fileId,
      });
      return {
        fileId: file.file_id,
        filePath: file.file_path ?? null,
        fileSize: file.file_size ?? null,
      };
    },

    async downloadFile(filePath, downloadOptions) {
      const maxBytes = downloadOptions?.maxBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES;
      const path = filePath.replace(/^\/+/, '');
      let bytes: Uint8Array;
      try {
        bytes = await http.bytes(`${base}/file/bot${botToken}/${path}`, {
          method: 'GET',
          timeoutMs: 60_000,
          label: 'telegram.downloadFile',
        });
      } catch (error: unknown) {
        throw classify('downloadFile', error, botToken);
      }
      if (bytes.byteLength > maxBytes) {
        throw new ProviderError('invalid', `telegram.downloadFile: file is larger than ${maxBytes} bytes`);
      }
      return bytes;
    },

    async setWebhook(url, webhookOptions) {
      await call<boolean>('setWebhook', {
        url,
        ...(webhookOptions?.secretToken ? { secret_token: webhookOptions.secretToken } : {}),
        ...(webhookOptions?.allowedUpdates ? { allowed_updates: webhookOptions.allowedUpdates } : {}),
      });
    },

    async deleteWebhook() {
      await call<boolean>('deleteWebhook', {});
    },

    async getMe() {
      const me = await call<{ id: number; username?: string; first_name?: string }>('getMe', {});
      return { id: String(me.id), username: me.username ?? null, firstName: me.first_name ?? '' };
    },

    async getChat(chatId) {
      const chat = await call<{ id: number | string; type?: string; title?: string; username?: string }>('getChat', {
        chat_id: chatId,
      });
      return {
        id: String(chat.id),
        type: chat.type ?? 'unknown',
        title: chat.title ?? null,
        username: chat.username ?? null,
      };
    },

    async getChatMember(chatId, userId) {
      const member = await call<{
        status?: string;
        can_post_messages?: boolean;
        can_edit_messages?: boolean;
        can_delete_messages?: boolean;
      }>('getChatMember', { chat_id: chatId, user_id: userId });
      return {
        status: member.status ?? 'unknown',
        canPostMessages: member.can_post_messages === true,
        canEditMessages: member.can_edit_messages === true,
        canDeleteMessages: member.can_delete_messages === true,
      };
    },
  };
}
