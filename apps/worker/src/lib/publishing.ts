import type { Channel, ProviderId } from '@sm/core/domain/types';
import type { BufferPostStatus } from '@sm/core/providers/buffer';
import { getBufferPostStatus } from '@sm/core/providers/buffer';
import type { PublishInput, PublishResult } from '@sm/core/providers/types';
import type { WorkerDeps } from '../deps';
import type { ClassifiedError } from './errors';
import { classifyAndReport, loadProviderHandle } from './provider-context';

/** Narrow provider seam used by publication jobs and their deterministic tests. */
export interface PublishingHandle {
  clientId: string;
  accountId: string;
  connectionId: string;
  channel: Channel;
  providerId: ProviderId;
  publish(input: PublishInput): Promise<PublishResult>;
  poll(externalId: string): Promise<BufferPostStatus>;
  classify(error: unknown): Promise<ClassifiedError>;
}

export async function loadPublishingHandle(deps: WorkerDeps, accountId: string): Promise<PublishingHandle | null> {
  const handle = await loadProviderHandle(deps, accountId);
  if (!handle) return null;
  return {
    clientId: handle.account.clientId,
    accountId: handle.account.account.id,
    connectionId: handle.account.connection.id,
    channel: handle.account.account.channel,
    providerId: handle.provider.id,
    publish: (input) => handle.provider.publish(handle.ctx, input),
    poll: (externalId) => getBufferPostStatus(handle.ctx, externalId),
    classify: (error) => classifyAndReport(deps, handle, error, 'The social network request failed.'),
  };
}

export function bufferPublishIsPending(providerId: ProviderId, result: PublishResult): boolean {
  if (providerId !== 'buffer') return false;
  if (!result.raw || typeof result.raw !== 'object' || Array.isArray(result.raw)) return true;
  return (result.raw as Record<string, unknown>)['status'] !== 'sent';
}
