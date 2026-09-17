import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;
export type ReservedSql = postgres.ReservedSql;
export type Row = postgres.Row;

export interface CreateSqlOptions {
  /** Pool size. Keep it small in the dashboard (many processes), larger in the worker. */
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  applicationName?: string;
  onNotice?: (notice: unknown) => void;
}

/** One postgres.js pool. Tagged templates only — never build SQL by concatenation. */
export function createSql(url: string, options: CreateSqlOptions = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    connection: { application_name: options.applicationName ?? 'sm-core' },
    onnotice: options.onNotice ?? (() => {}),
  });
}

/** postgres.js reports unique-violations as a code on the error object. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503';
}
