import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from '@sm/core/log';
import { ProviderError } from '@sm/core/providers/errors';
import type { HttpClient, HttpRequest, HttpResponse } from '@sm/core/providers/http';
import type { SocialProvider } from '@sm/core/providers/types';
import type { WorkerDeps } from '../deps';
import { loadProviderHandle, supportsChannel } from './provider-context';

interface SqlState {
  begins: number;
  connectionUpdates: number;
}

function accountRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000011',
    client_id: '00000000-0000-4000-8000-000000000012',
    connection_id: '00000000-0000-4000-8000-000000000013',
    provider: 'buffer',
    channel: 'linkedin',
    external_id: 'channel-1',
    handle: 'shop',
    display_name: 'Shop',
    avatar_url: null,
    status: 'active',
    capabilities: null,
    meta: {},
    comments_cursor: null,
    comments_synced_at: null,
    webhook_subscribed: false,
    connection_status: 'active',
    connection_meta: {},
    token_expires_at: new Date('2025-01-01T00:00:00.000Z'),
    connection_credentials: { accessToken: 'old-access', refreshToken: 'single-use' },
    account_credentials: null,
    ...overrides,
  };
}

function fakeSql(row: Record<string, unknown> | null): { sql: WorkerDeps['sql']; state: SqlState } {
  const state: SqlState = { begins: 0, connectionUpdates: 0 };
  const connection = {
    id: '00000000-0000-4000-8000-000000000013',
    client_id: '00000000-0000-4000-8000-000000000012',
    provider: 'buffer',
    label: null,
    status: 'active',
    last_error: null,
    token_expires_at: new Date('2025-01-01T00:00:00.000Z'),
    meta: {},
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    updated_at: new Date('2025-01-01T00:00:00.000Z'),
    credentials: { accessToken: 'old-access', refreshToken: 'single-use' },
  };

  interface RuntimeSql {
    (strings: TemplateStringsArray, ...values: unknown[]): unknown[];
    begin: (callback: (tx: WorkerDeps['sql']) => Promise<unknown>) => Promise<unknown>;
    unsafe: (value: string) => unknown;
    json: (value: unknown) => unknown;
  }
  const runtime = Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]): unknown[] => {
      const query = strings.join('?');
      if (query.includes('FROM social_accounts a')) return row ? [row] : [];
      if (query.includes('FROM provider_connections') && query.includes('FOR UPDATE')) return [connection];
      if (query.includes('UPDATE provider_connections SET')) state.connectionUpdates += 1;
      return [];
    },
    {
      unsafe: (value: string): unknown => value,
      json: (value: unknown): unknown => value,
      begin: async (callback: (tx: WorkerDeps['sql']) => Promise<unknown>): Promise<unknown> => {
        state.begins += 1;
        return callback(runtime as unknown as WorkerDeps['sql']);
      },
    },
  ) satisfies RuntimeSql;
  return { sql: runtime as unknown as WorkerDeps['sql'], state };
}

function fakeHttp(tokenResponse: Record<string, unknown>, onRequest?: (init: HttpRequest) => void): HttpClient {
  return {
    async request<T>(): Promise<HttpResponse<T>> {
      throw new Error('unexpected request() call');
    },
    async json<T>(_url: string, init: HttpRequest = {}): Promise<T> {
      onRequest?.(init);
      return tokenResponse as T;
    },
    async text(): Promise<string> {
      throw new Error('unexpected text() call');
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('unexpected bytes() call');
    },
  };
}

function deps(sql: WorkerDeps['sql'], http: HttpClient): WorkerDeps {
  return {
    sql,
    boss: {} as WorkerDeps['boss'],
    env: {
      APP_URL: 'https://app.example',
      BUFFER_CLIENT_ID: 'buffer-client',
      BUFFER_CLIENT_SECRET: undefined,
      META_GRAPH_VERSION: 'v26.0',
    } as WorkerDeps['env'],
    log: createLogger({ level: 'error', write: () => undefined }),
    encryptionKey: '0123456789abcdef',
    http,
    llm: () => null,
    telegram: () => null,
    s3: null,
    enqueue: async () => true,
  };
}

test('missing accounts return null before provider resolution', async () => {
  const database = fakeSql(null);
  const handle = await loadProviderHandle(deps(database.sql, fakeHttp({})), '00000000-0000-4000-8000-000000000011');
  assert.equal(handle, null);
  assert.equal(database.state.begins, 0);
});

test('revoked connections fail before adapter use', async () => {
  const database = fakeSql(accountRow({ connection_status: 'revoked' }));
  await assert.rejects(
    loadProviderHandle(deps(database.sql, fakeHttp({})), '00000000-0000-4000-8000-000000000011'),
    (error: unknown) => error instanceof ProviderError && error.kind === 'auth',
  );
  assert.equal(database.state.begins, 0);
});

test('Buffer refresh rotates and persists both single-use tokens under one lock', async () => {
  const database = fakeSql(accountRow());
  let form: Record<string, string> | undefined;
  const http = fakeHttp(
    { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    (init) => {
      form = init.form;
    },
  );

  const handle = await loadProviderHandle(deps(database.sql, http), '00000000-0000-4000-8000-000000000011');

  assert.ok(handle);
  assert.equal(handle.ctx.credentials['accessToken'], 'new-access');
  assert.equal(handle.ctx.credentials['refreshToken'], 'new-refresh');
  assert.equal(form?.['refresh_token'], 'single-use');
  assert.equal(database.state.begins, 1);
  assert.equal(database.state.connectionUpdates, 1);
});

test('Buffer refresh never persists or reuses a spent token when rotation is incomplete', async () => {
  const database = fakeSql(accountRow());
  await assert.rejects(
    loadProviderHandle(
      deps(database.sql, fakeHttp({ access_token: 'new-access', expires_in: 3600 })),
      '00000000-0000-4000-8000-000000000011',
    ),
    (error: unknown) => error instanceof ProviderError && error.kind === 'auth',
  );
  assert.equal(database.state.begins, 1);
  assert.equal(database.state.connectionUpdates, 0);
});

test('provider/channel mismatches fail closed', async () => {
  const database = fakeSql(
    accountRow({
      provider: 'telegram',
      channel: 'facebook',
      connection_credentials: { botToken: 'token' },
      token_expires_at: null,
    }),
  );
  await assert.rejects(
    loadProviderHandle(deps(database.sql, fakeHttp({})), '00000000-0000-4000-8000-000000000011'),
    (error: unknown) => error instanceof ProviderError && error.kind === 'invalid',
  );
});

test('supportsChannel reflects provider declaration only', () => {
  const provider = { channels: ['telegram'] } as SocialProvider;
  assert.equal(supportsChannel(provider, 'telegram'), true);
  assert.equal(supportsChannel(provider, 'facebook'), false);
});
