// One-time dashboard login links sent by the bot. Only the SHA-256 of the token is
// stored and the dashboard spends it on POST only (mirrors auth/telegram/actions.ts).

import { createHash, randomBytes } from 'node:crypto';
import type { AnySql } from '../crypto';

export const LOGIN_TOKEN_TTL_SECONDS = 15 * 60;
/** 24 random bytes as hex — the dashboard validates /^[0-9a-f]{48}$/. */
const TOKEN_BYTES = 24;

export interface MintLoginTokenInput {
  clientId: string | null;
  chatId: string | number;
  isAdmin?: boolean;
  ttlSeconds?: number;
}

export interface MintedLoginToken {
  token: string;
  expiresAt: Date;
}

export async function mintLoginToken(sql: AnySql, input: MintLoginTokenInput): Promise<MintedLoginToken> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const ttlSeconds = input.ttlSeconds ?? LOGIN_TOKEN_TTL_SECONDS;
  const [row] = await sql<{ expires_at: Date }[]>`
    INSERT INTO login_tokens (token_hash, client_id, chat_id, is_admin, expires_at)
    VALUES (${createHash('sha256').update(token).digest()}, ${input.clientId}, ${String(input.chatId)}::bigint,
            ${input.isAdmin ?? false}, now() + make_interval(secs => ${ttlSeconds}))
    RETURNING expires_at`;
  if (!row) throw new Error('mintLoginToken: insert returned no row');
  return { token, expiresAt: row.expires_at };
}

export function loginUrl(appUrl: string, token: string): string {
  return new URL(`/auth/telegram?token=${token}`, appUrl).toString();
}

export async function deleteExpiredLoginTokens(sql: AnySql): Promise<number> {
  const rows = await sql<{ chat_id: string }[]>`
    DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day' RETURNING chat_id::text AS chat_id`;
  return rows.length;
}
