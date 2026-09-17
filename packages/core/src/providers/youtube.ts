// YouTube Data API adapter. The 10,000 units/day quota is per Google project, i.e.
// SHARED by every tenant: each call must be booked against the system_counters row
// before it is made (see usage.consumeSystemCounter with YOUTUBE_QUOTA_METRIC).

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

export const YOUTUBE_CHANNELS: Channel[] = ['youtube'];

/** Documented unit costs of the calls this adapter makes. */
export const YOUTUBE_QUOTA_COST = {
  channelsList: 1,
  commentThreadsList: 1,
  commentsList: 1,
  commentsInsert: 50,
  commentsSetModerationStatus: 50,
  videosInsert: 1600,
  videosUpdate: 50,
} as const;
export type YouTubeQuotaOperation = keyof typeof YOUTUBE_QUOTA_COST;

export const YOUTUBE_DAILY_QUOTA = 10_000;
/** Stop background polling once this share of the daily quota is gone. */
export const YOUTUBE_POLL_BUDGET_RATIO = 0.8;
export const YOUTUBE_QUOTA_METRIC = 'youtube_quota';
/** Comments are polled at most this often per channel. */
export const YOUTUBE_MIN_POLL_MINUTES = 30;

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

const CAPABILITIES: Capabilities = {
  publishText: false,
  publishImage: false,
  publishVideo: true,
  maxImages: 0,
  readComments: true,
  replyComments: true,
  // heldForReview is reversible; we never use `rejected`.
  hideComments: true,
  webhooks: false,
};

export function createYouTubeProvider(): SocialProvider {
  return {
    id: 'youtube',
    channels: YOUTUBE_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
      return ni('youtube.validate');
    },
    publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
      return ni('youtube.publish');
    },
    fetchComments(_ctx: ProviderContext, _options: FetchCommentsOptions): Promise<FetchCommentsResult> {
      return ni('youtube.fetchComments');
    },
    reply(_ctx: ProviderContext, _target: ReplyTarget, _text: string): Promise<ReplyResult> {
      return ni('youtube.reply');
    },
    hide(_ctx: ProviderContext, _commentExternalId: string, _hidden: boolean): Promise<void> {
      return ni('youtube.hide');
    },
  };
}
