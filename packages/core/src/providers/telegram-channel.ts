// Telegram channel adapter: the client's bot posts into a channel it administers.
// Send-by-URL is capped at 5 MB for photos and 20 MB for video; larger media must be
// downloaded and uploaded as multipart.

import type { Channel } from '../domain/types';
import type {
  Capabilities,
  ProviderContext,
  PublishInput,
  PublishResult,
  SocialProvider,
  ValidatedAccount,
} from './types';

export const TELEGRAM_CHANNELS: Channel[] = ['telegram'];

export interface TelegramChannelCredentials {
  botToken: string;
  /** @channelusername or a numeric -100… chat id. */
  chatId: string;
}

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

const CAPABILITIES: Capabilities = {
  publishText: true,
  publishImage: true,
  publishVideo: true,
  maxImages: 10,
  // Channel comments live in a linked discussion group, which we do not manage yet.
  readComments: false,
  replyComments: false,
  hideComments: false,
  webhooks: false,
};

export function createTelegramChannelProvider(): SocialProvider {
  return {
    id: 'telegram',
    channels: TELEGRAM_CHANNELS,
    capabilities: (_channel: Channel) => CAPABILITIES,
    validate(_ctx: ProviderContext): Promise<ValidatedAccount> {
      return ni('telegram-channel.validate');
    },
    publish(_ctx: ProviderContext, _input: PublishInput): Promise<PublishResult> {
      return ni('telegram-channel.publish');
    },
  };
}
