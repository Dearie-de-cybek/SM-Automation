// Shared env schema pieces. Apps compose the pieces they need and parse once at boot.
// Optional integrations stay optional: a missing key disables the feature instead of
// crashing the process (the UI explains what to configure).

import { z } from 'zod';
import { LOG_LEVELS } from './log';

/** Docker compose passes unset variables as empty strings; treat those as absent. */
const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalWithDefault = (fallback: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default(fallback),
  );

export const baseEnvSchema = z.object({
  NODE_ENV: optionalWithDefault('production'),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url(),
  TOKEN_ENCRYPTION_KEY: z.string().min(16),
  LOG_LEVEL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(LOG_LEVELS).default('info'),
  ),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Gemini. Model ids are pinned: aliases are hot-swapped by Google. */
export const aiEnvSchema = z.object({
  GEMINI_API_KEY: optionalString,
  AI_MODEL_FAST: optionalWithDefault('gemini-3.5-flash-lite'),
  AI_MODEL_DEFAULT: optionalWithDefault('gemini-3.8-flash'),
  AI_MODEL_PREMIUM: optionalWithDefault('gemini-3.1-pro-preview'),
  AI_EMBEDDING_MODEL: optionalWithDefault('gemini-embedding-2'),
});
export type AiEnv = z.infer<typeof aiEnvSchema>;

export const telegramEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_BOT_USERNAME: optionalString,
  TELEGRAM_WEBHOOK_SECRET: optionalString,
  ADMIN_TELEGRAM_CHAT_ID: optionalString,
});
export type TelegramEnv = z.infer<typeof telegramEnvSchema>;

export const mediaEnvSchema = z.object({
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalWithDefault('auto'),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  MEDIA_PUBLIC_BASE_URL: optionalString,
});
export type MediaEnv = z.infer<typeof mediaEnvSchema>;

export const metaEnvSchema = z.object({
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_WEBHOOK_VERIFY_TOKEN: optionalString,
  META_GRAPH_VERSION: optionalWithDefault('v26.0'),
});
export type MetaEnv = z.infer<typeof metaEnvSchema>;

export const googleEnvSchema = z.object({
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
});
export type GoogleEnv = z.infer<typeof googleEnvSchema>;

export const bufferEnvSchema = z.object({
  BUFFER_CLIENT_ID: optionalString,
  BUFFER_CLIENT_SECRET: optionalString,
});
export type BufferEnv = z.infer<typeof bufferEnvSchema>;

export const integrationsEnvSchema = aiEnvSchema
  .extend(telegramEnvSchema.shape)
  .extend(mediaEnvSchema.shape)
  .extend(metaEnvSchema.shape)
  .extend(googleEnvSchema.shape)
  .extend(bufferEnvSchema.shape);
export type IntegrationsEnv = z.infer<typeof integrationsEnvSchema>;

export const workerEnvSchema = baseEnvSchema.extend(integrationsEnvSchema.shape).extend({
  WORKER_CONCURRENCY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(1).max(64).default(4),
  ),
  PGBOSS_SCHEMA: optionalWithDefault('pgboss'),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment: ${issues.join('; ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

/** Parse `source` with `schema`, throwing one readable error listing every bad key. */
export function parseEnv<T extends z.ZodType>(schema: T, source: unknown = process.env): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new EnvError(issues);
}

export function hasAi(env: AiEnv): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

export function hasTelegram(env: TelegramEnv): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

export function hasMedia(env: MediaEnv): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.MEDIA_PUBLIC_BASE_URL);
}

export function hasMetaApp(env: MetaEnv): boolean {
  return Boolean(env.META_APP_ID && env.META_APP_SECRET);
}

export function hasGoogleApp(env: GoogleEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function hasBufferApp(env: BufferEnv): boolean {
  return Boolean(env.BUFFER_CLIENT_ID);
}
