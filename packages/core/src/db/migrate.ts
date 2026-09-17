// Forward-only SQL migrations. Every file runs once, in its own transaction, under a
// session advisory lock so concurrent deploys (worker + one-shot migrate container)
// cannot race. Re-running the whole set is a no-op.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from './client';

/** Arbitrary but fixed: shared by every process that applies migrations. */
export const MIGRATION_LOCK_ID = 8_273_423_517_001;

const FILE_RE = /^(\d+)[_-](.+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  fileName: string;
  path: string;
}

export interface MigrationResult {
  applied: MigrationFile[];
  skipped: MigrationFile[];
}

export interface RunMigrationsOptions {
  dir?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate `db/migrations`: MIGRATIONS_DIR wins, otherwise walk up from `startDir`
 * (works from the repo, from apps/worker and from /app inside the container).
 */
export async function findMigrationsDir(startDir: string = process.cwd()): Promise<string> {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv && (await isDirectory(fromEnv))) return path.resolve(fromEnv);

  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'db', 'migrations');
    if (await isDirectory(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No db/migrations directory found from ${startDir} (set MIGRATIONS_DIR)`);
}

export async function listMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];
  for (const fileName of entries.sort()) {
    const match = FILE_RE.exec(fileName);
    if (!match) continue;
    const [, version, name] = match;
    if (!version || !name) continue;
    files.push({ version, name, fileName, path: path.join(dir, fileName) });
  }
  return files;
}

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
}

export async function appliedVersions(sql: Sql): Promise<Set<string>> {
  await ensureMigrationsTable(sql);
  const rows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
  return new Set(rows.map((row) => row.version));
}

/** Apply every pending migration in version order. Safe to call on every boot. */
export async function runMigrations(sql: Sql, options: RunMigrationsOptions = {}): Promise<MigrationResult> {
  const dir = options.dir ?? (await findMigrationsDir());
  const log = options.log ?? (() => {});
  const files = await listMigrationFiles(dir);
  const applied: MigrationFile[] = [];
  const skipped: MigrationFile[] = [];

  // Session-level lock on a reserved connection: the per-file transactions below use
  // other pool connections, so a transaction-scoped lock would not hold across them.
  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID}::bigint)`;
    await ensureMigrationsTable(sql);
    const done = await appliedVersions(sql);

    for (const file of files) {
      if (done.has(file.version)) {
        skipped.push(file);
        continue;
      }
      const contents = await readFile(file.path, 'utf8');
      log('applying migration', { version: file.version, name: file.name });
      await sql.begin(async (tx) => {
        // simple() keeps the multi-statement file as one protocol message.
        await tx.unsafe(contents).simple();
        await tx`INSERT INTO schema_migrations (version, name) VALUES (${file.version}, ${file.name})`;
      });
      applied.push(file);
    }
  } finally {
    await reserved`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID}::bigint)`;
    reserved.release();
  }

  log('migrations up to date', { applied: applied.length, total: files.length });
  return { applied, skipped };
}
