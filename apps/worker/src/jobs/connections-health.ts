// Daily: tokens close to expiry → needs_reauth + notify the client.
import type { ParsedJobPayload } from '@sm/core/jobs';
import { connectionsExpiringSoon, listAccounts, setConnectionStatus } from '@sm/core/repos/accounts';
import {
  YOUTUBE_DAILY_QUOTA,
  YOUTUBE_OPERATION_COST,
  YOUTUBE_QUOTA_METRIC,
} from '@sm/core/providers/youtube';
import { consumeSystemCounter } from '@sm/core/usage';
import type { WorkerDeps } from '../deps';
import { classifyAndReport, loadProviderHandle, markNeedsReauth, type ProviderHandle } from '../lib/provider-context';

export async function connectionsHealth(deps: WorkerDeps, _payload: ParsedJobPayload<'connections.health'>): Promise<void> {
  const connections = await connectionsExpiringSoon(deps.sql, 24);
  for (const connection of connections) {
    const accounts = await listAccounts(deps.sql, connection.clientId, {
      connectionId: connection.id,
      statuses: ['active', 'error'],
    });
    if (!accounts.length) {
      await markNeedsReauth(deps, { clientId: connection.clientId, connectionId: connection.id }, 'No usable account remains on this connection.');
      continue;
    }

    let healthy = false;
    for (const account of accounts) {
      let handle: ProviderHandle | null = null;
      try {
        handle = await loadProviderHandle(deps, account.id);
        if (!handle) continue;
        if (handle.provider.id === 'youtube') {
          const reserved = await consumeSystemCounter(
            deps.sql,
            YOUTUBE_QUOTA_METRIC,
            YOUTUBE_OPERATION_COST.validate,
            YOUTUBE_DAILY_QUOTA,
          );
          if (!reserved) continue;
        }
        await handle.provider.validate(handle.ctx);
        healthy = true;
        break;
      } catch (error: unknown) {
        const classified = await classifyAndReport(deps, handle, error, 'Connection validation failed.');
        deps.log.warn('connection health check failed', {
          connectionId: connection.id,
          accountId: account.id,
          kind: classified.kind,
          error: classified.message,
        });
      }
    }
    if (healthy) await setConnectionStatus(deps.sql, connection.id, 'active', null);
  }
}
