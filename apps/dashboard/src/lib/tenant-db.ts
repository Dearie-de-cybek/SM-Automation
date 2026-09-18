import type postgres from 'postgres';
import { db } from './db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireTenantId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TypeError('A valid tenant UUID is required');
  }
  return value;
}

/** Sets transaction-local RLS context. Pool connections never retain tenant state. */
export async function withTenantTransaction<T>(
  tenantId: unknown,
  work: (sql: postgres.TransactionSql) => T | Promise<T>,
  connection: postgres.Sql = db(),
): Promise<T> {
  const validatedTenantId = requireTenantId(tenantId);
  const result = await connection.begin(async (sql) => {
    await sql`SELECT set_config('app.client_id', ${validatedTenantId}, true)`;
    return { value: await work(sql) };
  });
  return result.value;
}
