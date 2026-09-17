// Provider connections and the social accounts they expose.
// Credentials are encrypted with pgcrypto and only decrypted inside these queries;
// nothing above this layer ever sees a secret unless it asked for an AccountContext.

import { asCredentials, decryptJson, encryptJson, jsonParam, mergeCredentials, type AnySql, type Credentials } from '../crypto';
import type { AccountStatus, Channel, ConnectionStatus, ProviderId } from '../domain/types';
import type { TransactionSql } from '../db/client';
import type { DiscoveredAccount, ProviderContext } from '../providers/types';
import type { HttpClient } from '../providers/http';

export interface CreateConnectionInput {
  clientId: string;
  provider: ProviderId;
  label?: string | null;
  credentials: Credentials;
  meta?: Record<string, unknown>;
  tokenExpiresAt?: Date | null;
}

export interface ConnectionSummary {
  id: string;
  clientId: string;
  provider: ProviderId;
  label: string | null;
  status: ConnectionStatus;
  lastError: string | null;
  tokenExpiresAt: Date | null;
  meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LockedConnection extends ConnectionSummary {
  /** Decrypted inside the row lock, for an atomic token rotation. */
  credentials: Credentials;
}

export interface SocialAccountSummary {
  id: string;
  clientId: string;
  connectionId: string;
  provider: ProviderId;
  channel: Channel;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  capabilities: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  commentsCursor: string | null;
  commentsSyncedAt: Date | null;
  webhookSubscribed: boolean;
}

export interface AccountContext {
  clientId: string;
  account: SocialAccountSummary;
  connection: {
    id: string;
    provider: ProviderId;
    status: ConnectionStatus;
    tokenExpiresAt: Date | null;
    meta: Record<string, unknown>;
  };
  /** Connection credentials merged with the account-level secret. */
  credentials: Credentials;
}

interface ConnectionRowShape {
  id: string;
  client_id: string;
  provider: ProviderId;
  label: string | null;
  status: ConnectionStatus;
  last_error: string | null;
  token_expires_at: Date | null;
  meta: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface AccountRowShape {
  id: string;
  client_id: string;
  connection_id: string;
  provider: ProviderId;
  channel: Channel;
  external_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: AccountStatus;
  capabilities: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  comments_cursor: string | null;
  comments_synced_at: Date | null;
  webhook_subscribed: boolean;
}

function toConnection(row: ConnectionRowShape): ConnectionSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    lastError: row.last_error,
    tokenExpiresAt: row.token_expires_at,
    meta: row.meta ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAccount(row: AccountRowShape): SocialAccountSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    connectionId: row.connection_id,
    provider: row.provider,
    channel: row.channel,
    externalId: row.external_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: row.status,
    capabilities: row.capabilities,
    meta: row.meta ?? {},
    commentsCursor: row.comments_cursor,
    commentsSyncedAt: row.comments_synced_at,
    webhookSubscribed: row.webhook_subscribed,
  };
}

const CONNECTION_COLUMNS = `id, client_id, provider, label, status, last_error, token_expires_at, meta, created_at, updated_at`;
const ACCOUNT_COLUMNS = `id, client_id, connection_id, provider, channel, external_id, handle, display_name, avatar_url,
  status, capabilities, meta, comments_cursor, comments_synced_at, webhook_subscribed`;

export async function createConnection(sql: AnySql, key: string, input: CreateConnectionInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO provider_connections (client_id, provider, label, credentials_enc, token_expires_at, meta)
    VALUES (${input.clientId}::uuid, ${input.provider}, ${input.label ?? null},
            ${encryptJson(sql, input.credentials, key)}, ${input.tokenExpiresAt ?? null},
            ${jsonParam(sql, input.meta ?? {})})
    RETURNING id`;
  if (!row) throw new Error('createConnection: insert returned no row');
  return row.id;
}

export async function listConnections(sql: AnySql, clientId: string): Promise<ConnectionSummary[]> {
  const rows = await sql<ConnectionRowShape[]>`
    SELECT ${sql.unsafe(CONNECTION_COLUMNS)} FROM provider_connections
    WHERE client_id = ${clientId}::uuid ORDER BY created_at`;
  return rows.map(toConnection);
}

export async function getConnection(sql: AnySql, clientId: string, connectionId: string): Promise<ConnectionSummary | null> {
  const [row] = await sql<ConnectionRowShape[]>`
    SELECT ${sql.unsafe(CONNECTION_COLUMNS)} FROM provider_connections
    WHERE id = ${connectionId}::uuid AND client_id = ${clientId}::uuid`;
  return row ? toConnection(row) : null;
}

/**
 * Lock the connection row and decrypt its credentials. Buffer refresh tokens are
 * single-use, so refresh + persist must happen inside this lock, in one transaction.
 */
export async function lockConnectionForRefresh(
  tx: TransactionSql,
  key: string,
  connectionId: string,
): Promise<LockedConnection | null> {
  const [row] = await tx<(ConnectionRowShape & { credentials: unknown })[]>`
    SELECT ${tx.unsafe(CONNECTION_COLUMNS)}, ${decryptJson(tx, 'credentials_enc', key)} AS credentials
    FROM provider_connections
    WHERE id = ${connectionId}::uuid
    FOR UPDATE`;
  if (!row) return null;
  return { ...toConnection(row), credentials: asCredentials(row.credentials) };
}

export async function updateConnectionCredentials(
  sql: AnySql,
  key: string,
  connectionId: string,
  credentials: Credentials,
  options: { tokenExpiresAt?: Date | null; status?: ConnectionStatus; lastError?: string | null } = {},
): Promise<void> {
  await sql`
    UPDATE provider_connections SET
      credentials_enc = ${encryptJson(sql, credentials, key)},
      token_expires_at = ${options.tokenExpiresAt ?? null},
      status = ${options.status ?? 'active'},
      last_error = ${options.lastError ?? null}
    WHERE id = ${connectionId}::uuid`;
}

export async function setConnectionStatus(
  sql: AnySql,
  connectionId: string,
  status: ConnectionStatus,
  lastError: string | null = null,
): Promise<void> {
  await sql`
    UPDATE provider_connections SET status = ${status}, last_error = ${lastError}
    WHERE id = ${connectionId}::uuid`;
}

export async function deleteConnection(sql: AnySql, clientId: string, connectionId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM provider_connections WHERE id = ${connectionId}::uuid AND client_id = ${clientId}::uuid RETURNING id`;
  return rows.length > 0;
}

/** Connections whose token expires inside the window (connections.health job). */
export async function connectionsExpiringSoon(
  sql: AnySql,
  withinHours: number,
): Promise<(ConnectionSummary & { clientId: string })[]> {
  const rows = await sql<ConnectionRowShape[]>`
    SELECT ${sql.unsafe(CONNECTION_COLUMNS)} FROM provider_connections
    WHERE status = 'active' AND token_expires_at IS NOT NULL
      AND token_expires_at < now() + make_interval(hours => ${withinHours})
    ORDER BY token_expires_at`;
  return rows.map(toConnection);
}

export interface UpsertAccountsInput {
  clientId: string;
  connectionId: string;
  accounts: DiscoveredAccount[];
}

/** Insert or refresh the discovered accounts of one connection. */
export async function upsertAccounts(sql: AnySql, key: string, input: UpsertAccountsInput): Promise<SocialAccountSummary[]> {
  const saved: SocialAccountSummary[] = [];
  for (const account of input.accounts) {
    const [row] = await sql<AccountRowShape[]>`
      INSERT INTO social_accounts (client_id, connection_id, provider, channel, external_id, handle, display_name,
                                   avatar_url, credentials_enc, meta, status)
      VALUES (${input.clientId}::uuid, ${input.connectionId}::uuid, ${account.provider}, ${account.channel},
              ${account.externalId}, ${account.handle}, ${account.displayName}, ${account.avatarUrl},
              ${account.accountCredentials ? encryptJson(sql, account.accountCredentials, key) : null},
              ${jsonParam(sql, account.meta ?? {})}, 'active')
      ON CONFLICT (client_id, provider, channel, external_id) DO UPDATE SET
        connection_id = EXCLUDED.connection_id,
        handle = EXCLUDED.handle,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        credentials_enc = COALESCE(EXCLUDED.credentials_enc, social_accounts.credentials_enc),
        meta = social_accounts.meta || EXCLUDED.meta,
        status = 'active',
        updated_at = now()
      RETURNING ${sql.unsafe(ACCOUNT_COLUMNS)}`;
    if (row) saved.push(toAccount(row));
  }
  return saved;
}

export interface ListAccountsOptions {
  channels?: Channel[];
  statuses?: AccountStatus[];
  connectionId?: string;
}

export async function listAccounts(sql: AnySql, clientId: string, options: ListAccountsOptions = {}): Promise<SocialAccountSummary[]> {
  const rows = await sql<AccountRowShape[]>`
    SELECT ${sql.unsafe(ACCOUNT_COLUMNS)} FROM social_accounts
    WHERE client_id = ${clientId}::uuid
      ${options.channels?.length ? sql`AND channel IN ${sql(options.channels)}` : sql``}
      ${options.statuses?.length ? sql`AND status IN ${sql(options.statuses)}` : sql``}
      ${options.connectionId ? sql`AND connection_id = ${options.connectionId}::uuid` : sql``}
    ORDER BY channel, handle`;
  return rows.map(toAccount);
}

export async function countAccounts(sql: AnySql, clientId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM social_accounts WHERE client_id = ${clientId}::uuid AND status <> 'revoked'`;
  return row?.count ?? 0;
}

/** Account + merged decrypted credentials: everything an adapter call needs. */
export async function getAccountContext(sql: AnySql, key: string, accountId: string): Promise<AccountContext | null> {
  const [row] = await sql<
    (AccountRowShape & {
      connection_status: ConnectionStatus;
      connection_meta: Record<string, unknown> | null;
      token_expires_at: Date | null;
      connection_credentials: unknown;
      account_credentials: unknown;
    })[]
  >`
    SELECT ${sql.unsafe(ACCOUNT_COLUMNS.split(',').map((column) => `a.${column.trim()}`).join(', '))},
           c.status AS connection_status, c.meta AS connection_meta, c.token_expires_at,
           ${decryptJson(sql, 'c.credentials_enc', key)} AS connection_credentials,
           ${decryptJson(sql, 'a.credentials_enc', key)} AS account_credentials
    FROM social_accounts a
    JOIN provider_connections c ON c.id = a.connection_id
    WHERE a.id = ${accountId}::uuid`;
  if (!row) return null;
  return {
    clientId: row.client_id,
    account: toAccount(row),
    connection: {
      id: row.connection_id,
      provider: row.provider,
      status: row.connection_status,
      tokenExpiresAt: row.token_expires_at,
      meta: row.connection_meta ?? {},
    },
    credentials: mergeCredentials(row.connection_credentials, row.account_credentials),
  };
}

export async function setAccountStatus(
  sql: AnySql,
  accountId: string,
  status: AccountStatus,
  lastError: string | null = null,
): Promise<void> {
  await sql`
    UPDATE social_accounts SET status = ${status}, meta = meta || ${jsonParam(sql, { lastError })}
    WHERE id = ${accountId}::uuid`;
}

export async function updateCommentsCursor(
  sql: AnySql,
  accountId: string,
  cursor: string | null,
  syncedAt: Date = new Date(),
): Promise<void> {
  await sql`
    UPDATE social_accounts SET comments_cursor = ${cursor}, comments_synced_at = ${syncedAt}
    WHERE id = ${accountId}::uuid`;
}

export async function setWebhookSubscribed(sql: AnySql, accountId: string, subscribed: boolean): Promise<void> {
  await sql`UPDATE social_accounts SET webhook_subscribed = ${subscribed} WHERE id = ${accountId}::uuid`;
}

/** Webhook dispatch: find the account a provider-side id belongs to. */
export async function findAccountByExternalId(
  sql: AnySql,
  channel: Channel,
  externalId: string,
): Promise<SocialAccountSummary | null> {
  const [row] = await sql<AccountRowShape[]>`
    SELECT ${sql.unsafe(ACCOUNT_COLUMNS)} FROM social_accounts
    WHERE channel = ${channel} AND external_id = ${externalId} AND status <> 'revoked'
    ORDER BY updated_at DESC LIMIT 1`;
  return row ? toAccount(row) : null;
}

/** Accounts due for a comments poll (comments.poll-all fan-out). */
export async function listAccountsForCommentPolling(
  sql: AnySql,
  options: { staleMinutes?: number; limit?: number } = {},
): Promise<SocialAccountSummary[]> {
  const staleMinutes = options.staleMinutes ?? 5;
  const limit = options.limit ?? 200;
  const rows = await sql<AccountRowShape[]>`
    SELECT ${sql.unsafe(ACCOUNT_COLUMNS.split(',').map((column) => `a.${column.trim()}`).join(', '))}
    FROM social_accounts a
    JOIN clients cl ON cl.id = a.client_id
    JOIN provider_connections c ON c.id = a.connection_id
    WHERE a.status = 'active' AND c.status = 'active' AND cl.active
      AND (a.comments_synced_at IS NULL OR a.comments_synced_at < now() - make_interval(mins => ${staleMinutes}))
    ORDER BY a.comments_synced_at NULLS FIRST
    LIMIT ${limit}`;
  return rows.map(toAccount);
}

/** Bridge an AccountContext into the shape adapters expect. */
export function providerContextFor(
  context: AccountContext,
  http: HttpClient,
  onCredentialsRefreshed?: (credentials: Credentials) => Promise<void>,
): ProviderContext {
  return {
    account: {
      id: context.account.id,
      clientId: context.clientId,
      channel: context.account.channel,
      externalId: context.account.externalId,
      handle: context.account.handle,
      meta: { ...context.connection.meta, ...context.account.meta },
    },
    credentials: context.credentials,
    http,
    ...(onCredentialsRefreshed ? { onCredentialsRefreshed } : {}),
  };
}
