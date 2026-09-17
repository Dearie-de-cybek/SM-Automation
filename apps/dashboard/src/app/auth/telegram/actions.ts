'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { createSession } from '@/lib/session';

export async function consumeLoginToken(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  if (!/^[0-9a-f]{48}$/.test(token)) redirect('/login?error=expired');

  const sql = db();
  const [row] = await sql<{ client_id: string | null; chat_id: string; is_admin: boolean; client_active: boolean | null }[]>`
    WITH used AS (
      UPDATE login_tokens SET used_at = now()
      WHERE token_hash = digest(${token}::text, 'sha256') AND used_at IS NULL AND expires_at > now()
      RETURNING client_id, chat_id, is_admin
    )
    SELECT u.client_id, u.chat_id::text AS chat_id, u.is_admin, c.active AS client_active
    FROM used u
    LEFT JOIN clients c ON c.id = u.client_id`;

  if (!row) redirect('/login?error=expired');
  if (row.client_id && !row.client_active && !row.is_admin) redirect('/login?error=inactive');

  await createSession({ chatId: row.chat_id, clientId: row.client_id, isAdmin: row.is_admin });
  redirect(row.client_id ? '/' : '/admin');
}
