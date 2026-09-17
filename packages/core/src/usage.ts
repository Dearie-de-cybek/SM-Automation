// Monthly counters. Every gated action consumes atomically: the limit check and the
// increment are the same statement, so two concurrent jobs can never both slip through.

import type { AnySql } from './crypto';

export const USAGE_METRICS = ['ai_generations', 'ai_reply_suggestions', 'auto_replies', 'knowledge_pages'] as const;
export type KnownUsageMetric = (typeof USAGE_METRICS)[number];
/** `api_calls:<provider>` is also a valid metric. */
export type UsageMetric = KnownUsageMetric | `api_calls:${string}`;

/** Project-wide counters that are not tied to a client (e.g. the shared YouTube quota). */
export const SYSTEM_METRICS = ['youtube_quota'] as const;
export type SystemMetric = (typeof SYSTEM_METRICS)[number] | (string & {});

/** First day of the month, in UTC, as a date literal. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Day bucket for system counters (the YouTube quota resets daily). */
export function currentDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface UsageStatus {
  used: number;
  limit: number;
  remaining: number;
  allowed: boolean;
}

export async function checkUsage(
  sql: AnySql,
  clientId: string,
  metric: UsageMetric,
  limit: number,
  period: string = currentPeriod(),
): Promise<UsageStatus> {
  const [row] = await sql<{ value: string }[]>`
    SELECT value::text AS value FROM usage_counters
    WHERE client_id = ${clientId}::uuid AND period = ${period}::date AND metric = ${metric}`;
  const used = row ? Number(row.value) : 0;
  return { used, limit, remaining: Math.max(0, limit - used), allowed: used < limit };
}

/**
 * Increment by `amount` only if it keeps the client at or under `limit`.
 * Returns false when the quota is exhausted (caller shows the upsell).
 */
export async function consumeUsage(
  sql: AnySql,
  clientId: string,
  metric: UsageMetric,
  amount: number,
  limit: number,
  period: string = currentPeriod(),
): Promise<boolean> {
  if (amount <= 0) return true;
  if (amount > limit) return false;
  const rows = await sql<{ value: string }[]>`
    INSERT INTO usage_counters (client_id, period, metric, value)
    VALUES (${clientId}::uuid, ${period}::date, ${metric}, ${amount})
    ON CONFLICT (client_id, period, metric) DO UPDATE
      SET value = usage_counters.value + ${amount}
      WHERE usage_counters.value + ${amount} <= ${limit}
    RETURNING value::text AS value`;
  return rows.length > 0;
}

/** Give back a reservation when the gated action failed before doing any work. */
export async function releaseUsage(
  sql: AnySql,
  clientId: string,
  metric: UsageMetric,
  amount: number,
  period: string = currentPeriod(),
): Promise<void> {
  if (amount <= 0) return;
  await sql`
    UPDATE usage_counters SET value = GREATEST(0, value - ${amount})
    WHERE client_id = ${clientId}::uuid AND period = ${period}::date AND metric = ${metric}`;
}

export async function getUsageSummary(
  sql: AnySql,
  clientId: string,
  period: string = currentPeriod(),
): Promise<Record<string, number>> {
  const rows = await sql<{ metric: string; value: string }[]>`
    SELECT metric, value::text AS value FROM usage_counters
    WHERE client_id = ${clientId}::uuid AND period = ${period}::date`;
  return Object.fromEntries(rows.map((row) => [row.metric, Number(row.value)]));
}

/** Same atomic consume, for counters shared by every tenant. */
export async function consumeSystemCounter(
  sql: AnySql,
  metric: SystemMetric,
  amount: number,
  limit: number,
  period: string = currentDay(),
): Promise<boolean> {
  if (amount <= 0) return true;
  if (amount > limit) return false;
  const rows = await sql<{ value: string }[]>`
    INSERT INTO system_counters (period, metric, value)
    VALUES (${period}::date, ${metric}, ${amount})
    ON CONFLICT (period, metric) DO UPDATE
      SET value = system_counters.value + ${amount}
      WHERE system_counters.value + ${amount} <= ${limit}
    RETURNING value::text AS value`;
  return rows.length > 0;
}

export async function readSystemCounter(
  sql: AnySql,
  metric: SystemMetric,
  period: string = currentDay(),
): Promise<number> {
  const [row] = await sql<{ value: string }[]>`
    SELECT value::text AS value FROM system_counters WHERE period = ${period}::date AND metric = ${metric}`;
  return row ? Number(row.value) : 0;
}
