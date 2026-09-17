// Mastodon adapter. Statuses accept an Idempotency-Key (1 hour window), so a publish
// retry inside that window is safe; media v2 uploads return 202 and must be polled.
// The instance URL is user-supplied: always SSRF-check it before the first call.

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

export const MASTODON_CHANNELS: Channel[] = ['mastodon'];

export interface MastodonCredentials {
  instanceUrl: string;
  accessToken: string;
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
  hideComments: false,
  webhooks: false,
};

export function createMastodonProvider(): SocialProvider {
  return {
    id: 'mastodon',
    channels: MASTODON_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
      return ni('mastodon.validate');
    },
    publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
      return ni('mastodon.publish');
    },
    fetchComments(_ctx: ProviderContext, _options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return ni('mastodon.fetchComments');
    },
    reply(_ctx: ProviderContext, _target: ReplyTarget, _text: string): Promise<ReplyResult> {
      return ni('mastodon.reply');
    },
  };
}
