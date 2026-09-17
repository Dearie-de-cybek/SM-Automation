// CLI entry: `npm run migrate` (repo) and `node dist/migrate.js` (worker image).
import { createSql } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createLogger, isLogLevel } from '../log';

export async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const log = createLogger({
    level: isLogLevel(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : 'info',
    base: { service: 'migrate' },
  });
  const sql = createSql(url, { max: 2, applicationName: 'sm-migrate' });
  try {
    const result = await runMigrations(sql, { log: (message, fields) => log.info(message, fields) });
    log.info('migrate done', {
      applied: result.applied.map((file) => file.fileName),
      skipped: result.skipped.length,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const log = createLogger({ base: { service: 'migrate' } });
  log.error('migrate failed', { error });
  process.exitCode = 1;
});
