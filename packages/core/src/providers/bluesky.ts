// Bluesky (AT Protocol) adapter. createSession is rate limited (~300/day), so the
// session is cached in the connection credentials and refreshed with refreshSession;
// a full login only happens when the refresh fails.
// No idempotency key: we generate the record key (TID) ourselves and getRecord before
// any retry so a repeat publish cannot create a second post.

import type { Channel } from '../domain/types';
import type {
  Capabilities,
  FetchCommentsOptions,
  FetchCommentsResult,
  ProviderContext,
  PublishInput,
  PublishResult,
  ReplyResult,
  ReplyTarget,
  SocialProvider,
  ValidatedAccount,
} from './types';

export const BLUESKY_DEFAULT_SERVICE = 'https://bsky.social';
export const BLUESKY_CHANNELS: Channel[] = ['bluesky'];

/** Credentials stored for a Bluesky connection. */
export interface BlueskyCredentials {
  service?: string;
  identifier: string;
  appPassword: string;
  accessJwt?: string;
  refreshJwt?: string;
  did?: string;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

const CAPABILITIES: Capabilities = {
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: 4,
  readComments: true,
  replyComments: true,
  // The AT Protocol has no "hide reply" for another author's post.
  hideComments: false,
  webhooks: false,
};

export function createBlueskyProvider(): SocialProvider {
  return {
    id: 'bluesky',
    channels: BLUESKY_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
      return ni('bluesky.validate');
    },
    publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
      return ni('bluesky.publish');
    },
    fetchComments(_ctx: ProviderContext, _options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return ni('bluesky.fetchComments');
    },
    reply(_ctx: ProviderContext, _target: ReplyTarget, _text: string): Promise<ReplyResult> {
      return ni('bluesky.reply');
    },
  };
}
