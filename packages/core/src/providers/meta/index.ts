// One provider id ('meta') serves both Meta channels; the account's channel picks the
// adapter. Registry entry: meta → createMetaProvider.

import { credentialString, requireCredential } from '../../crypto';
import type { Channel } from '../../domain/types';
import { ProviderError } from '../errors';
import type { HttpClient } from '../http';
import type {
  Capabilities,
  DiscoveredAccount,
  FetchCommentsOptions,
  FetchCommentsResult,
  ProviderContext,
  PublishInput,
  PublishResult,
  ReplyResult,
  ReplyTarget,
  SocialProvider,
  ValidatedAccount,
} from '../types';
import { facebookAdapter } from './facebook';
import { DEFAULT_GRAPH_VERSION, type MetaChannelAdapter } from './graph';
import { instagramAdapter } from './instagram';
import { listMetaAccounts } from './oauth';

export * from './graph';
export * from './oauth';
export * from './webhook';
export { facebookAdapter } from './facebook';
export { instagramAdapter } from './instagram';

export const META_CHANNELS: Channel[] = ['facebook', 'instagram'];

const ADAPTERS: Record<'facebook' | 'instagram', MetaChannelAdapter> = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
};

function adapterFor(channel: Channel): MetaChannelAdapter {
  const adapter = channel === 'facebook' || channel === 'instagram' ? ADAPTERS[channel] : null;
  if (!adapter) throw ProviderError.invalid(`Meta provider cannot handle channel "${channel}"`);
  return adapter;
}

export function createMetaProvider(): SocialProvider {
  return {
    id: 'meta',
    channels: META_CHANNELS,
    capabilities: (channel: Channel): Capabilities => adapterFor(channel).capabilities(),
    listAccounts(credentials: Record<string, unknown>, http: HttpClient): Promise<DiscoveredAccount[]> {
      const graphVersion = credentialString(credentials, 'graphVersion') ?? DEFAULT_GRAPH_VERSION;
      return listMetaAccounts(http, { graphVersion }, requireCredential(credentials, 'accessToken'));
    },
    validate(ctx: ProviderContext): Promise<ValidatedAccount> {
      return adapterFor(ctx.account.channel).validate(ctx);
    },
    publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
      return adapterFor(ctx.account.channel).publish(ctx, input);
    },
    fetchComments(ctx: ProviderContext, options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return adapterFor(ctx.account.channel).fetchComments(ctx, options);
    },
    reply(ctx: ProviderContext, target: ReplyTarget, text: string): Promise<ReplyResult> {
      return adapterFor(ctx.account.channel).reply(ctx, target, text);
    },
    hide(ctx: ProviderContext, commentExternalId: string, hidden: boolean): Promise<void> {
      return adapterFor(ctx.account.channel).hide(ctx, commentExternalId, hidden);
    },
  };
}
