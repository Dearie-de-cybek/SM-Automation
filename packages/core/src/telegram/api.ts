// Bot API client. Only the methods the bot actually uses, typed narrowly.

import type { HttpClient } from '../providers/http';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_MESSAGE_MAX = 4096;
export const TELEGRAM_CAPTION_MAX = 1024;
/** Send-by-URL limits; larger media must be uploaded as multipart. */
export const TELEGRAM_URL_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const TELEGRAM_URL_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

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

/** Bot API surface used by the router and the notification jobs. */
export interface TelegramApi {
  sendMessage(chatId: string | number, text: string, options?: SendMessageOptions): Promise<SentMessage>;
  sendPhoto(chatId: string | number, photo: string, options?: SendPhotoOptions): Promise<SentMessage>;
  editMessageText(ref: TelegramMessageRef, text: string, options?: SendMessageOptions): Promise<void>;
  editMessageReplyMarkup(ref: TelegramMessageRef, replyMarkup: InlineKeyboardMarkup | null): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string; showAlert?: boolean }): Promise<void>;
  getFile(fileId: string): Promise<TelegramFileInfo>;
  /** Downloads a file through the bot file endpoint (token never leaves the server). */
  downloadFile(filePath: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  setWebhook(url: string, options?: { secretToken?: string; allowedUpdates?: string[] }): Promise<void>;
  deleteWebhook(): Promise<void>;
}

export interface TelegramApiOptions {
  http?: HttpClient;
  timeoutMs?: number;
  apiBase?: string;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function createTelegramApi(_botToken: string, _options?: TelegramApiOptions): TelegramApi {
  return {
    sendMessage: () => ni('telegram.sendMessage'),
    sendPhoto: () => ni('telegram.sendPhoto'),
    editMessageText: () => ni('telegram.editMessageText'),
    editMessageReplyMarkup: () => ni('telegram.editMessageReplyMarkup'),
    answerCallbackQuery: () => ni('telegram.answerCallbackQuery'),
    getFile: () => ni('telegram.getFile'),
    downloadFile: () => ni('telegram.downloadFile'),
    setWebhook: () => ni('telegram.setWebhook'),
    deleteWebhook: () => ni('telegram.deleteWebhook'),
  };
}
