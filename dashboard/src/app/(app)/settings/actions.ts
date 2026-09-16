'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { isValidTimeZone } from '@/lib/format';
import { GraphError, saveClientMetaCredentials, verifyMetaCredentials } from '@/lib/meta';
import { requireClientViewer } from '@/lib/session';

export type SaveState = { saved?: boolean; error?: string };

const list = (separators: RegExp) =>
  z.string().default('').transform((s) => [...new Set(s.split(separators).map((x) => x.trim()).filter(Boolean))].slice(0, 50));

const brandSchema = z.object({
  business_description: z.string().trim().max(2000).default(''),
  audience: z.string().trim().max(500).default(''),
  voice: z.string().trim().max(500).default(''),
  language: z.string().trim().max(50).default(''),
  emoji_policy: z.string().trim().max(100).default(''),
  default_cta: z.string().trim().max(300).default(''),
  timezone: z.string().refine(isValidTimeZone, 'Unknown timezone'),
  hashtags: list(/[\s,]+/).transform((tags) => tags.map((t) => `#${t.replace(/^#+/, '')}`)),
  banned_words: list(/,/),
  sample_posts: z.string().trim().max(8000).default(''),
});

export async function saveBrandProfile(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const viewer = await requireClientViewer();
  const parsed = brandSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form' };
  const b = parsed.data;

  const sql = db();
  await sql`
    WITH tz AS (
      UPDATE clients SET timezone = ${b.timezone} WHERE id = ${viewer.actingClientId}::uuid
    )
    INSERT INTO brand_profiles (client_id, business_description, audience, voice, language, emoji_policy, default_cta, hashtags, banned_words, sample_posts)
    VALUES (
      ${viewer.actingClientId}::uuid, ${b.business_description}, ${b.audience},
      ${b.voice || 'Friendly, clear and professional'}, ${b.language || 'English'}, ${b.emoji_policy || 'A few relevant emojis'},
      ${b.default_cta}, ${sql.array(b.hashtags)}::text[], ${sql.array(b.banned_words)}::text[], ${b.sample_posts}
    )
    ON CONFLICT (client_id) DO UPDATE SET
      business_description = EXCLUDED.business_description, audience = EXCLUDED.audience, voice = EXCLUDED.voice,
      language = EXCLUDED.language, emoji_policy = EXCLUDED.emoji_policy, default_cta = EXCLUDED.default_cta,
      hashtags = EXCLUDED.hashtags, banned_words = EXCLUDED.banned_words, sample_posts = EXCLUDED.sample_posts`;

  revalidatePath('/settings');
  revalidatePath('/');
  return { saved: true };
}

const metaSchema = z.object({
  fb_page_id: z.string().trim().min(1, 'Facebook Page ID is required'),
  page_token: z.string().trim().min(1, 'Page Access Token is required'),
  ig_user_id: z.string().trim().optional(),
});

export async function saveMetaCredentials(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const viewer = await requireClientViewer();
  const parsed = metaSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const { fb_page_id, page_token, ig_user_id } = parsed.data;

  try {
    const verified = await verifyMetaCredentials(fb_page_id, page_token);
    await saveClientMetaCredentials({
      clientId: viewer.actingClientId,
      pageId: verified.pageId,
      pageName: verified.pageName,
      pageToken: page_token,
      igUserId: ig_user_id || verified.igUserId,
      igUsername: verified.igUsername,
    });

    revalidatePath('/settings');
    revalidatePath('/');
    return { saved: true };
  } catch (err) {
    const message = err instanceof GraphError ? err.message : 'Failed to verify token with Meta API.';
    return { error: message };
  }
}
