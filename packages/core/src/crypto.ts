// Credential storage. Secrets live in Postgres as pgcrypto bytea and are only ever
// decrypted inside a query on the server (same scheme as the legacy clients.meta_token_enc).
// Nothing here returns a secret to the caller unless it explicitly decrypts one.

import type postgres from 'postgres';
import type { Sql, TransactionSql } from './db/client';

export type AnySql = Sql | TransactionSql;

export type Credentials = Record<string, unknown>;

/**
 * jsonb parameter. postgres.js types `sql.json` against its own JSONValue, which does
 * not accept `Record<string, unknown>`; the value is serialized either way.
 */
export function jsonParam(sql: AnySql, value: unknown) {
  return sql.json(value as postgres.JSONValue);
}

/**
 * SQL fragment that encrypts `value` as JSON text.
 * Usage: sql`INSERT INTO provider_connections (credentials_enc) VALUES (${encryptJson(sql, creds, key)})`
 */
export function encryptJson(sql: AnySql, value: unknown, key: string) {
  return sql`pgp_sym_encrypt(${JSON.stringify(value ?? {})}::text, ${key}::text)`;
}

/**
 * SQL fragment that decrypts a bytea column back to jsonb.
 * `column` must be a literal column reference written in code, never user input.
 */
export function decryptJson(sql: AnySql, column: string, key: string) {
  return sql`CASE WHEN ${sql.unsafe(column)} IS NULL THEN NULL ELSE pgp_sym_decrypt(${sql.unsafe(column)}, ${key}::text)::jsonb END`;
}

/** Narrow a decrypted jsonb value (postgres.js already parsed it) to an object. */
export function asCredentials(value: unknown): Credentials {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Credentials;
  return {};
}

/** Connection credentials merged with account-level secrets (account wins). */
export function mergeCredentials(connection: unknown, account: unknown): Credentials {
  return { ...asCredentials(connection), ...asCredentials(account) };
}

/** Read a required string field out of decrypted credentials. */
export function requireCredential(credentials: Credentials, field: string): string {
  const value = credentials[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing credential "${field}" — reconnect the account.`);
  }
  return value;
}

export function credentialString(credentials: Credentials, field: string): string | null {
  const value = credentials[field];
  return typeof value === 'string' && value !== '' ? value : null;
}
