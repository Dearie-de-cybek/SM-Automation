import { z } from 'zod';

/** Docker compose passes unset variables as empty strings; treat those as absent. */
const optional = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const withDefault = (fallback: string) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().min(1).default(fallback));

const disabledByDefault = z
  .preprocess(
    (value) => (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
      ? undefined
      : String(value).trim().toLowerCase()),
    z.enum(['true', 'false']).default('false'),
  )
  .transform((value) => value === 'true');

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  OPERATOR_DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: z.string().min(16),
  APP_URL: z.string().url(),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  META_GRAPH_VERSION: withDefault('v26.0'),
  // When set, /signup asks for this invite code.
  SIGNUP_CODE: z.string().default(''),

  // Optional integrations: each feature is hidden when its keys are missing.
  GEMINI_API_KEY: optional,
  AI_MODEL_FAST: withDefault('gemini-3.5-flash-lite'),
  AI_MODEL_DEFAULT: withDefault('gemini-3.8-flash'),
  AI_MODEL_PREMIUM: withDefault('gemini-3.1-pro-preview'),
  AI_EMBEDDING_MODEL: withDefault('gemini-embedding-2'),

  TELEGRAM_WEBHOOK_SECRET: optional,
  ADMIN_TELEGRAM_CHAT_ID: optional,

  S3_ENDPOINT: optional,
  S3_REGION: withDefault('auto'),
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  MEDIA_PUBLIC_BASE_URL: optional,

  META_APP_ID: optional,
  META_APP_SECRET: optional,
  META_WEBHOOK_VERIFY_TOKEN: optional,
  META_DIRECT_ENABLED: disabledByDefault,

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,

  BUFFER_CLIENT_ID: optional,
  BUFFER_CLIENT_SECRET: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

// Parsed lazily so `next build` works without runtime secrets.
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

export function appUrl(path = '/'): string {
  return new URL(path, env().APP_URL).toString();
}

/** Feature flags derived from env: used to hide UI a deployment cannot support. */
export function features(): {
  ai: boolean;
  media: boolean;
  metaOAuth: boolean;
  googleOAuth: boolean;
  bufferOAuth: boolean;
  telegramWebhook: boolean;
} {
  const current = env();
  return {
    ai: Boolean(current.GEMINI_API_KEY),
    media: Boolean(
      current.S3_ENDPOINT && current.S3_BUCKET && current.S3_ACCESS_KEY_ID && current.S3_SECRET_ACCESS_KEY && current.MEDIA_PUBLIC_BASE_URL,
    ),
    metaOAuth: current.META_DIRECT_ENABLED && Boolean(current.META_APP_ID && current.META_APP_SECRET),
    googleOAuth: Boolean(current.GOOGLE_CLIENT_ID && current.GOOGLE_CLIENT_SECRET),
    bufferOAuth: Boolean(current.BUFFER_CLIENT_ID),
    telegramWebhook: Boolean(current.TELEGRAM_WEBHOOK_SECRET),
  };
}
