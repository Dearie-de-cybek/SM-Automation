// OAuth state: only the SHA-256 of the state is stored, it is single-use and expires.
// The raw value is returned once, to be put in the authorize URL.

import { createHash, randomBytes } from 'node:crypto';
import type { AnySql } from '../crypto';

export const DEFAULT_STATE_TTL_SECONDS = 600;

export interface CreateOAuthStateInput {
  clientId: string | null;
  provider: string;
  codeVerifier?: string | null;
  redirectPath?: string | null;
  ttlSeconds?: number;
}

export interface OAuthStateRecord {
  clientId: string | null;
  provider: string;
  codeVerifier: string | null;
  redirectPath: string | null;
}

function hashState(state: string): Buffer {
  return createHash('sha256').update(state).digest();
}

/** Returns the raw state to send to the provider; only its hash is persisted. */
export async function createOAuthState(sql: AnySql, input: CreateOAuthStateInput): Promise<string> {
  const state = randomBytes(24).toString('hex');
  await sql`
    INSERT INTO oauth_states (state_hash, client_id, provider, code_verifier, redirect_path, expires_at)
    VALUES (${hashState(state)}, ${input.clientId}, ${input.provider}, ${input.codeVerifier ?? null},
            ${input.redirectPath ?? null}, now() + make_interval(secs => ${input.ttlSeconds ?? DEFAULT_STATE_TTL_SECONDS}))`;
  return state;
}

/** Single use: the same state can never be redeemed twice. */
export async function consumeOAuthState(sql: AnySql, state: string, provider?: string): Promise<OAuthStateRecord | null> {
  const [row] = await sql<
    { client_id: string | null; provider: string; code_verifier: string | null; redirect_path: string | null }[]
  >`
    UPDATE oauth_states SET used_at = now()
    WHERE state_hash = ${hashState(state)} AND used_at IS NULL AND expires_at > now()
      ${provider ? sql`AND provider = ${provider}` : sql``}
    RETURNING client_id, provider, code_verifier, redirect_path`;
  if (!row) return null;
  return {
    clientId: row.client_id,
    provider: row.provider,
    codeVerifier: row.code_verifier,
    redirectPath: row.redirect_path,
  };
}

export async function deleteExpiredOAuthStates(sql: AnySql): Promise<number> {
  const rows = await sql<{ state_hash: Uint8Array }[]>`
    DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day' RETURNING state_hash`;
  return rows.length;
}

/** PKCE helper: verifier + S256 challenge. */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}
