import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnySql } from '../crypto';
import { claimTargetForPublish } from './posts';

test('publish claim cannot take a scheduled target before its publish time', async () => {
  const queries: string[] = [];
  interface RuntimeSql {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    unsafe(value: string): string;
  }
  const runtime = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
      queries.push(strings.join('?'));
      return [];
    },
    { unsafe: (value: string): string => value },
  ) satisfies RuntimeSql;

  await claimTargetForPublish(runtime as unknown as AnySql, '00000000-0000-4000-8000-000000000001');

  assert.equal(queries.length, 1);
  assert.match(
    queries[0] ?? '',
    /status = 'queued' OR \(status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= now\(\)\)/,
  );
});
