// One-off, idempotent migration of legacy per-client Meta credentials
// (clients.fb_page_id / ig_user_id / meta_token_enc) into provider_connections +
// social_accounts. Needs the encryption key, so it runs in TS at worker startup
// rather than in SQL. Safe to run on every boot: it skips clients that already have
// a Meta connection.

import type { WorkerDeps } from '../deps';

export interface BackfillResult {
  clientsScanned: number;
  connectionsCreated: number;
  accountsCreated: number;
}

export async function backfillLegacyConnections(deps: WorkerDeps): Promise<BackfillResult> {
  deps.log.warn('not implemented', { task: 'backfill-legacy' });
  return { clientsScanned: 0, connectionsCreated: 0, accountsCreated: 0 };
}
