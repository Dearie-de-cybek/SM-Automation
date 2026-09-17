// Client + brand profile queries. Every query filters by client_id: tenant isolation is
// enforced here, not in the callers.

import type { BrandContext, BrandProfileDraft } from '../ai/types';
import { jsonParam, type AnySql } from '../crypto';
import type { Plan } from '../domain/types';

export interface ClientContext {
  id: string;
  name: string;
  plan: Plan;
  planOverrides: Record<string, unknown>;
  timezone: string;
  telegramChatId: string | null;
  telegramLinkCode: string | null;
  defaultPlatforms: string[];
  active: boolean;
}

interface ClientRowShape {
  id: string;
  name: string;
  plan: Plan;
  plan_overrides: Record<string, unknown> | null;
  timezone: string;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  default_platforms: string[];
  active: boolean;
}

function toClientContext(row: ClientRowShape): ClientContext {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    planOverrides: row.plan_overrides ?? {},
    timezone: row.timezone,
    telegramChatId: row.telegram_chat_id,
    telegramLinkCode: row.telegram_link_code,
    defaultPlatforms: row.default_platforms,
    active: row.active,
  };
}

export async function getClient(sql: AnySql, clientId: string): Promise<ClientContext | null> {
  const [row] = await sql<ClientRowShape[]>`
    SELECT id, name, plan, plan_overrides, timezone, telegram_chat_id::text AS telegram_chat_id,
           telegram_link_code, default_platforms, active
    FROM clients WHERE id = ${clientId}::uuid`;
  return row ? toClientContext(row) : null;
}

export async function getClientByChat(sql: AnySql, chatId: string | number): Promise<ClientContext | null> {
  const [row] = await sql<ClientRowShape[]>`
    SELECT id, name, plan, plan_overrides, timezone, telegram_chat_id::text AS telegram_chat_id,
           telegram_link_code, default_platforms, active
    FROM clients WHERE telegram_chat_id = ${String(chatId)}::bigint`;
  return row ? toClientContext(row) : null;
}

export async function listActiveClients(sql: AnySql): Promise<ClientContext[]> {
  const rows = await sql<ClientRowShape[]>`
    SELECT id, name, plan, plan_overrides, timezone, telegram_chat_id::text AS telegram_chat_id,
           telegram_link_code, default_platforms, active
    FROM clients WHERE active ORDER BY created_at`;
  return rows.map(toClientContext);
}

export async function setPlan(
  sql: AnySql,
  clientId: string,
  plan: Plan,
  overrides: Record<string, unknown> | null = null,
): Promise<void> {
  await sql`
    UPDATE clients
    SET plan = ${plan}${overrides === null ? sql`` : sql`, plan_overrides = ${jsonParam(sql, overrides)}`}
    WHERE id = ${clientId}::uuid`;
}

export async function setTimezone(sql: AnySql, clientId: string, timezone: string): Promise<void> {
  await sql`UPDATE clients SET timezone = ${timezone} WHERE id = ${clientId}::uuid`;
}

const BRAND_DEFAULTS = {
  business_description: '',
  voice: 'Friendly, clear and professional',
  audience: '',
  language: 'English',
  default_cta: '',
  hashtags: [] as string[],
  banned_words: [] as string[],
  emoji_policy: 'A few relevant emojis',
  sample_posts: '',
};

interface BrandRowShape {
  name: string;
  timezone: string;
  business_description: string | null;
  voice: string | null;
  audience: string | null;
  language: string | null;
  default_cta: string | null;
  hashtags: string[] | null;
  banned_words: string[] | null;
  emoji_policy: string | null;
  sample_posts: string | null;
}

/** Brand profile with defaults filled in — prompts always get a complete context. */
export async function getBrandProfile(sql: AnySql, clientId: string): Promise<BrandContext | null> {
  const [row] = await sql<BrandRowShape[]>`
    SELECT c.name, c.timezone, b.business_description, b.voice, b.audience, b.language, b.default_cta,
           b.hashtags, b.banned_words, b.emoji_policy, b.sample_posts
    FROM clients c LEFT JOIN brand_profiles b ON b.client_id = c.id
    WHERE c.id = ${clientId}::uuid`;
  if (!row) return null;
  return {
    clientId,
    name: row.name,
    timezone: row.timezone,
    businessDescription: row.business_description ?? BRAND_DEFAULTS.business_description,
    voice: row.voice ?? BRAND_DEFAULTS.voice,
    audience: row.audience ?? BRAND_DEFAULTS.audience,
    language: row.language ?? BRAND_DEFAULTS.language,
    defaultCta: row.default_cta ?? BRAND_DEFAULTS.default_cta,
    hashtags: row.hashtags ?? [],
    bannedWords: row.banned_words ?? [],
    emojiPolicy: row.emoji_policy ?? BRAND_DEFAULTS.emoji_policy,
    samplePosts: row.sample_posts ?? BRAND_DEFAULTS.sample_posts,
  };
}

export async function upsertBrandProfile(sql: AnySql, clientId: string, draft: BrandProfileDraft): Promise<void> {
  await sql`
    INSERT INTO brand_profiles (client_id, business_description, voice, audience, language, default_cta,
                                hashtags, banned_words, emoji_policy, sample_posts)
    VALUES (${clientId}::uuid, ${draft.businessDescription}, ${draft.voice}, ${draft.audience}, ${draft.language},
            ${draft.defaultCta}, ${draft.hashtags}::text[], ${draft.bannedWords}::text[], ${draft.emojiPolicy},
            ${draft.samplePosts})
    ON CONFLICT (client_id) DO UPDATE SET
      business_description = EXCLUDED.business_description,
      voice = EXCLUDED.voice,
      audience = EXCLUDED.audience,
      language = EXCLUDED.language,
      default_cta = EXCLUDED.default_cta,
      hashtags = EXCLUDED.hashtags,
      banned_words = EXCLUDED.banned_words,
      emoji_policy = EXCLUDED.emoji_policy,
      sample_posts = EXCLUDED.sample_posts,
      updated_at = now()`;
}
