// Instagram professional account channel. Publishing is container → poll status_code →
// media_publish, images must be JPEG, comments page at 50 with no time filter, and a
// reply to a reply attaches to the top-level comment. Our own comments cannot be hidden.

import type {
  Capabilities,
  FetchCommentsOptions,
  FetchCommentsResult,
  ProviderContext,
  PublishInput,
  PublishResult,
  ReplyResult,
  ReplyTarget,
  ValidatedAccount,
} from '../types';
import type { MetaChannelAdapter } from './graph';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

const CAPABILITIES: Capabilities = {
  publishText: false,
  publishImage: true,
  publishVideo: true,
  maxImages: 10,
  readComments: true,
  replyComments: true,
  hideComments: true,
  webhooks: true,
};

/** Instagram containers only accept JPEG source images. */
export const INSTAGRAM_IMAGE_MIME_TYPES = ['image/jpeg'] as const;
/** How many comments one page returns. */
export const INSTAGRAM_COMMENTS_PAGE_SIZE = 50;

export const instagramAdapter: MetaChannelAdapter = {
  channel: 'instagram',
  capabilities: (): Capabilities => CAPABILITIES,
  validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
    return ni('meta.instagram.validate');
  },
  publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
    return ni('meta.instagram.publish');
  },
  fetchComments(_ctx: ProviderContext, _options: FetchCommentsOptions): Promise<FetchCommentsResult> {
    return ni('meta.instagram.fetchComments');
  },
  reply(_ctx: ProviderContext, _target: ReplyTarget, _text: string): Promise<ReplyResult> {
    return ni('meta.instagram.reply');
  },
  hide(_ctx: ProviderContext, _commentExternalId: string, _hidden: boolean): Promise<void> {
    return ni('meta.instagram.hide');
  },
};
