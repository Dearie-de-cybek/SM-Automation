'use server';

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { isValidTimeZone } from '@/lib/format';

export type SignupState = { error?: string };

const schema = z.object({
  name: z.string().trim().min(2, 'Enter your business name').max(100),
  timezone: z.string().refine(isValidTimeZone).catch('UTC'),
  invite: z.string().trim().optional(),
});

function inviteMatches(given: string | undefined, expected: string): boolean {
  if (!expected) return true;
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function signup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form' };
  if (!inviteMatches(parsed.data.invite, env().SIGNUP_CODE)) return { error: 'That invite code is not valid' };

  const linkCode = randomBytes(16).toString('hex');
  const sql = db();
  await sql`
    WITH created AS (
      INSERT INTO clients (name, timezone, telegram_link_code)
      VALUES (${parsed.data.name}, ${parsed.data.timezone}, ${linkCode})
      RETURNING id
    )
    INSERT INTO brand_profiles (client_id) SELECT id FROM created`;

  redirect(`/signup/telegram?code=${linkCode}`);
}
