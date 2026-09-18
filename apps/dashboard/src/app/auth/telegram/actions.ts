'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { createSession } from '@/lib/session';

export async function consumeLoginToken(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  if (!/^[0-9a-f]{48}$/.test(token)) redirect('/login?error=expired');

  const sql = db();
  const [row] = await sql<{ client_id: string | null; chat_id: string; is_admin: boolean; client_active: boolean | null }[]>`
    SELECT * FROM app_consume_login_token(${token})`;

  if (!row) redirect('/login?error=expired');
  if (row.client_id && !row.client_active && !row.is_admin) redirect('/login?error=inactive');

  await createSession({ chatId: row.chat_id, clientId: row.client_id, isAdmin: row.is_admin });
  redirect(row.client_id ? '/' : '/admin');
}
