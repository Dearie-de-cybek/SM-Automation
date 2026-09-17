// Facebook Page channel. Page tokens issued from a long-lived user token do not expire.

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
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: 10,
  readComments: true,
  replyComments: true,
  hideComments: true,
  webhooks: true,
};

export const facebookAdapter: MetaChannelAdapter = {
  channel: 'facebook',
  capabilities: (): Capabilities => CAPABILITIES,
  validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
    return ni('meta.facebook.validate');
  },
  publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
    return ni('meta.facebook.publish');
  },
  fetchComments(_ctx: ProviderContext, _options: FetchCommentsOptions): Promise<FetchCommentsResult> {
    return ni('meta.facebook.fetchComments');
  },
  reply(_ctx: ProviderContext, _target: ReplyTarget, _text: string): Promise<ReplyResult> {
    return ni('meta.facebook.reply');
  },
  hide(_ctx: ProviderContext, _commentExternalId: string, _hidden: boolean): Promise<void> {
    return ni('meta.facebook.hide');
  },
};
