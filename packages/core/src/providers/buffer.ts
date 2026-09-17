// Buffer adapter (GraphQL, POST https://api.buffer.com). Buffer is the posting-only
// route for networks we do not talk to directly. createPost has no idempotency key,
// so a publish that may have reached Buffer is never retried automatically — the
// worker polls getBufferPostStatus() instead.

import { CHANNEL_RULES } from '../platform-rules';
import type { Channel } from '../domain/types';
import type {
  Capabilities,
  DiscoveredAccount,
  FetchCommentsOptions,
  FetchCommentsResult,
  ProviderContext,
  PublishInput,
  PublishResult,
  SocialProvider,
  ValidatedAccount,
} from './types';
import type { HttpClient } from './http';

export const BUFFER_API_URL = 'https://api.buffer.com';

/** Networks routed through Buffer. Telegram is always direct. */
export const BUFFER_CHANNELS: Channel[] = [
  'facebook',
  'instagram',
  'threads',
  'x',
  'linkedin',
  'tiktok',
  'youtube',
  'pinterest',
  'google_business',
  'mastodon',
  'bluesky',
];

export interface BufferPostStatus {
  status: 'pending' | 'sent' | 'error';
  permalink: string | null;
  error: string | null;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

function bufferCapabilities(channel: Channel): Capabilities {
  const rules = CHANNEL_RULES[channel];
  return {
    publishText: !rules.needsMedia,
    publishImage: rules.maxImages > 0,
    publishVideo: rules.maxVideos > 0,
    maxImages: rules.maxImages,
    // Buffer's API is publish-only for our purposes: engagement stays direct.
    readComments: false,
    replyComments: false,
    hideComments: false,
    webhooks: false,
  };
}

export function createBufferProvider(): SocialProvider {
  return {
    id: 'buffer',
    channels: BUFFER_CHANNELS,
    capabilities: bufferCapabilities,
    listAccounts(_credentials: Record<string, unknown>, _http: HttpClient): Promise<DiscoveredAccount[]> {
      return ni('buffer.listAccounts');
    },
    validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
      return ni('buffer.validate');
    },
    publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
      return ni('buffer.publish');
    },
    fetchComments(_ctx: ProviderContext, _options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return ni('buffer.fetchComments');
    },
  };
}

/**
 * Poll a Buffer post until it leaves `pending`. The target keeps status `publishing`
 * with external_id = the Buffer post id until this resolves.
 */
export function getBufferPostStatus(_ctx: ProviderContext, _externalId: string): Promise<BufferPostStatus> {
  return ni('buffer.getBufferPostStatus');
}
