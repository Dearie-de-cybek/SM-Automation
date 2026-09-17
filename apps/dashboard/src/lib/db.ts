import postgres from 'postgres';
import { env } from './env';

const globalForDb = globalThis as unknown as { smSql?: postgres.Sql };

// Single pool per process (survives dev hot reloads).
export function db(): postgres.Sql {
  globalForDb.smSql ??= postgres(env().DATABASE_URL, { max: 5, idle_timeout: 30 });
  return globalForDb.smSql;
}
