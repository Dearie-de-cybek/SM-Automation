// Append-only trail of who did what. Details are free-form but must never hold secrets.

import { jsonParam, type AnySql } from '../crypto';

export interface WriteAuditInput {
  clientId: string | null;
  postId?: string | null;
  actorChatId?: string | number | null;
  action: string;
  detail?: Record<string, unknown>;
}

export async function writeAudit(sql: AnySql, input: WriteAuditInput): Promise<void> {
  await sql`
    INSERT INTO audit_log (client_id, post_id, actor_chat_id, action, detail)
    VALUES (${input.clientId}, ${input.postId ?? null}, ${input.actorChatId === null || input.actorChatId === undefined ? null : String(input.actorChatId)},
            ${input.action}, ${jsonParam(sql, input.detail ?? {})})`;
}

export interface AuditEntry {
  action: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export async function listAuditForPost(sql: AnySql, postId: string): Promise<AuditEntry[]> {
  const rows = await sql<{ action: string; detail: Record<string, unknown>; created_at: Date }[]>`
    SELECT action, detail, created_at FROM audit_log WHERE post_id = ${postId}::uuid ORDER BY created_at`;
  return rows.map((row) => ({ action: row.action, detail: row.detail, createdAt: row.created_at }));
}
