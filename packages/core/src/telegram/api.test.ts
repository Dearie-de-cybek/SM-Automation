import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderError } from '../providers/errors';
import type { HttpClient, HttpRequest, HttpResponse } from '../providers/http';
import { createTelegramApi } from './api';

type JsonHandler = (url: string, init: HttpRequest) => unknown | Promise<unknown>;

function fakeHttp(jsonHandler: JsonHandler, bytesHandler?: JsonHandler): HttpClient {
  return {
    async request<T>(): Promise<HttpResponse<T>> {
      throw new Error('unexpected request() call');
    },
    async json<T>(url: string, init: HttpRequest = {}): Promise<T> {
      return (await jsonHandler(url, init)) as T;
    },
    async text(): Promise<string> {
      throw new Error('unexpected text() call');
    },
    async bytes(url: string, init: HttpRequest = {}): Promise<Uint8Array> {
      if (!bytesHandler) throw new Error('unexpected bytes() call');
      return (await bytesHandler(url, init)) as Uint8Array;
    },
  };
}

test('sendMessage maps Telegram fields and never exposes its token in request metadata', async () => {
  const token = '123456:top-secret';
  let seenUrl = '';
  let seenInit: HttpRequest | undefined;
  const api = createTelegramApi(token, {
    http: fakeHttp((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, result: { message_id: 42, date: 1_800_000_000, chat: { id: -10 } } };
    }),
  });

  const sent = await api.sendMessage(-10, 'Hello', { disableWebPagePreview: true, replyToMessageId: 7 });

  assert.equal(sent.messageId, 42);
  assert.equal(sent.chatId, '-10');
  assert.equal(seenUrl, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(seenInit?.label, 'telegram.sendMessage');
  assert.deepEqual(seenInit?.json, {
    chat_id: -10,
    text: 'Hello',
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: 7 },
  });
});

test('429 envelopes retry through injected sleep and honor retry_after', async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = createTelegramApi('123:secret', {
    http: fakeHttp(() => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 7 },
        };
      }
      return { ok: true, result: { message_id: 9, date: 1, chat: { id: 1 } } };
    }),
    maxRateLimitRetries: 2,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal((await api.sendMessage(1, 'retry')).messageId, 9);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [7_000, 7_000]);
});

test('rate-limit retry count is bounded and the final error stays classified', async () => {
  let calls = 0;
  const api = createTelegramApi('123:secret', {
    http: fakeHttp(() => {
      calls += 1;
      throw ProviderError.fromHttpStatus(429, 'telegram.sendMessage failed', { retryAfterSec: 0 });
    }),
    maxRateLimitRetries: 99,
    sleep: async () => undefined,
  });

  await assert.rejects(api.sendMessage(1, 'retry'), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'rate_limit');
    assert.equal(error.safeToRetry, true);
    return true;
  });
  assert.equal(calls, 6, 'five local retries plus the original request');
});

test('token-bearing upstream URLs are absent from surfaced errors and cause chains', async () => {
  const token = '987:never-log-this';
  const api = createTelegramApi(token, {
    http: fakeHttp(() => {
      throw new ProviderError(
        'transient',
        `POST https://api.telegram.org/bot${token}/sendMessage failed`,
        { status: 503, cause: new Error(token) },
      );
    }),
    maxRateLimitRetries: 0,
  });

  await assert.rejects(api.sendMessage(1, 'hello'), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'transient');
    assert.equal(error.message.includes(token), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('Telegram 400 descriptions map to stable error kinds', async () => {
  const api = createTelegramApi('123:secret', {
    http: fakeHttp(() => {
      throw ProviderError.fromHttpStatus(
        400,
        'telegram.getChat failed with HTTP 400: {"description":"Bad Request: chat not found"}',
      );
    }),
  });

  await assert.rejects(api.getChat('missing'), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'not_found');
    assert.equal(error.message, 'telegram.getChat: chat or message not found');
    return true;
  });
});

test('downloadFile enforces caller byte limits', async () => {
  const api = createTelegramApi('123:secret', {
    http: fakeHttp(
      () => {
        throw new Error('unexpected json call');
      },
      () => new Uint8Array(5),
    ),
  });

  await assert.rejects(api.downloadFile('/photos/file.jpg', { maxBytes: 4 }), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'invalid');
    return true;
  });
});
