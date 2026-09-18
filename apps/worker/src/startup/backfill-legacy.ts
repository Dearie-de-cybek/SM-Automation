// One-off, idempotent migration of legacy per-client Meta credentials
// (clients.fb_page_id / ig_user_id / meta_token_enc) into provider_connections +
// social_accounts. Needs the encryption key, so it runs in TS at worker startup
// rather than in SQL. Safe to run on every boot: it skips clients that already have
// a Meta connection.

import type { WorkerDeps } from '../deps';
import { createConnection, upsertAccounts } from '@sm/core/repos/accounts';
import type { DiscoveredAccount } from '@sm/core/providers/types';

export interface BackfillResult {
  clientsScanned: number;
  connectionsCreated: number;
  accountsCreated: number;
}

export async function backfillLegacyConnections(deps: WorkerDeps): Promise<BackfillResult> {
  const clients = await deps.sql<{
    id: string;
    name: string;
    fb_page_id: string | null;
    fb_page_name: string | null;
    ig_user_id: string | null;
    ig_username: string | null;
  }[]>`
    SELECT id, name, fb_page_id, fb_page_name, ig_user_id, ig_username
    FROM clients
    WHERE active AND meta_token_enc IS NOT NULL AND (fb_page_id IS NOT NULL OR ig_user_id IS NOT NULL)`;

  let connectionsCreated = 0;
  let accountsCreated = 0;
  for (const client of clients) {
    try {
      const result = await deps.sql.begin(async (tx): Promise<{ connection: boolean; accounts: number }> => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-meta:${client.id}`}, 0))`;
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM provider_connections WHERE client_id = ${client.id}::uuid AND provider = 'meta' LIMIT 1`;
        if (existing) return { connection: false, accounts: 0 };

        const [legacy] = await tx<{ access_token: string }[]>`
          SELECT pgp_sym_decrypt(meta_token_enc, ${deps.encryptionKey}) AS access_token
          FROM clients WHERE id = ${client.id}::uuid`;
        const accessToken = legacy?.access_token?.trim();
        if (!accessToken) return { connection: false, accounts: 0 };

        const connectionId = await createConnection(tx, deps.encryptionKey, {
          clientId: client.id,
          provider: 'meta',
          label: 'Legacy Meta connection',
          credentials: { accessToken },
          meta: { legacyBackfill: true },
        });
        const discovered: DiscoveredAccount[] = [];
        if (client.fb_page_id) {
          discovered.push({
            provider: 'meta',
            channel: 'facebook',
            externalId: client.fb_page_id,
            handle: client.fb_page_name ?? client.fb_page_id,
            displayName: client.fb_page_name ?? client.name,
            avatarUrl: null,
            meta: { graphVersion: deps.env.META_GRAPH_VERSION },
            accountCredentials: { pageAccessToken: accessToken, pageId: client.fb_page_id },
          });
        }
        if (client.ig_user_id) {
          discovered.push({
            provider: 'meta',
            channel: 'instagram',
            externalId: client.ig_user_id,
            handle: client.ig_username ?? client.ig_user_id,
            displayName: client.ig_username ?? client.name,
            avatarUrl: null,
            meta: { graphVersion: deps.env.META_GRAPH_VERSION, ...(client.fb_page_id ? { pageId: client.fb_page_id } : {}) },
            accountCredentials: {
              pageAccessToken: accessToken,
              igUserId: client.ig_user_id,
              ...(client.fb_page_id ? { pageId: client.fb_page_id } : {}),
            },
          });
        }
        const saved = await upsertAccounts(tx, deps.encryptionKey, {
          clientId: client.id,
          connectionId,
          accounts: discovered,
        });
        return { connection: true, accounts: saved.length };
      });
      if (result.connection) connectionsCreated += 1;
      accountsCreated += result.accounts;
    } catch (error: unknown) {
      deps.log.error('legacy Meta connection backfill failed', { clientId: client.id, error });
    }
  }

  const result = { clientsScanned: clients.length, connectionsCreated, accountsCreated };
  if (connectionsCreated > 0) deps.log.info('legacy Meta connections backfilled', result);
  return result;
}
