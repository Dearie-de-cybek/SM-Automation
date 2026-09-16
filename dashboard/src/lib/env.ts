import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: z.string().min(16),
  APP_URL: z.string().url(),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  META_GRAPH_VERSION: z.string().default('v24.0'),
  // When set, /signup asks for this invite code.
  SIGNUP_CODE: z.string().default(''),
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
