import postgres from 'postgres';
import { env } from './env';

const globalForAdminDb = globalThis as unknown as { smOperatorSql?: postgres.Sql };

/** Cross-tenant operator pool. Its login can execute narrow functions, not tables. */
export function operatorDb(): postgres.Sql {
  globalForAdminDb.smOperatorSql ??= postgres(env().OPERATOR_DATABASE_URL, {
    max: 1,
    idle_timeout: 15,
    connection: { application_name: 'sm-dashboard-operator' },
  });
  return globalForAdminDb.smOperatorSql;
}
