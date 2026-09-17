// Account → adapter routing. `social_accounts.provider` names the entry here.

import type { Channel, ProviderId } from '../domain/types';
import { createBlueskyProvider } from './bluesky';
import { createBufferProvider } from './buffer';
import { createMastodonProvider } from './mastodon';
import { createMetaProvider } from './meta/index';
import { createTelegramChannelProvider } from './telegram-channel';
import type { SocialProvider } from './types';
import { createYouTubeProvider } from './youtube';

export type ProviderFactory = () => SocialProvider;

export const PROVIDER_FACTORIES: Record<ProviderId, ProviderFactory> = {
  buffer: createBufferProvider,
  meta: createMetaProvider,
  bluesky: createBlueskyProvider,
  mastodon: createMastodonProvider,
  youtube: createYouTubeProvider,
  telegram: createTelegramChannelProvider,
};

// Adapters are stateless, so one instance per process is enough.
const instances = new Map<ProviderId, SocialProvider>();

export function getProvider(id: ProviderId): SocialProvider {
  let provider = instances.get(id);
  if (!provider) {
    provider = PROVIDER_FACTORIES[id]();
    instances.set(id, provider);
  }
  return provider;
}

/** Providers that can serve a channel, in preference order (direct before Buffer). */
export function providersForChannel(channel: Channel): SocialProvider[] {
  const direct: SocialProvider[] = [];
  const viaBuffer: SocialProvider[] = [];
  for (const id of Object.keys(PROVIDER_FACTORIES) as ProviderId[]) {
    const provider = getProvider(id);
    if (!provider.channels.includes(channel)) continue;
    if (id === 'buffer') viaBuffer.push(provider);
    else direct.push(provider);
  }
  return [...direct, ...viaBuffer];
}
