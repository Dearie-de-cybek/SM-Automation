'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { isUuid, requireAdmin, setActingClient } from '@/lib/session';

export async function viewAsClient(formData: FormData): Promise<void> {
  await requireAdmin();
  const clientId = String(formData.get('client_id') ?? '');
  if (!isUuid(clientId)) return;
  await setActingClient(clientId);
  redirect('/');
}

export async function stopActing(): Promise<void> {
  await requireAdmin();
  await setActingClient(null);
  redirect('/admin');
}

export async function toggleClientActive(formData: FormData): Promise<void> {
  await requireAdmin();
  const clientId = String(formData.get('client_id') ?? '');
  if (!isUuid(clientId)) return;
  await db()`UPDATE clients SET active = NOT active WHERE id = ${clientId}::uuid`;
  revalidatePath('/admin');
}

/** Creates a client and returns to /admin showing the Telegram invite link to send them. */
export async function createClientInvite(formData: FormData): Promise<void> {
  await requireAdmin();
  const name = String(formData.get('name') ?? '').trim().slice(0, 100);
  if (name.length < 2) return;
  const code = randomBytes(16).toString('hex');
  await db()`
    WITH created AS (
      INSERT INTO clients (name, telegram_link_code) VALUES (${name}, ${code}) RETURNING id
    )
    INSERT INTO brand_profiles (client_id) SELECT id FROM created`;
  revalidatePath('/admin');
  redirect(`/admin?invite=${code}`);
}
