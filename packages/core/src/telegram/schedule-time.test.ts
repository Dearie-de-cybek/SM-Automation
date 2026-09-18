import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLocalTime, parseScheduleTime, safeZone } from './schedule-time';

function published(input: string, zone: string, now: string): Date {
  const result = parseScheduleTime(input, zone, new Date(now));
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.publishAt;
}

test('parses wall-clock, relative, today, and tomorrow input in client timezone', () => {
  const now = '2026-06-15T12:00:00.000Z'; // 13:00 in Lagos
  assert.equal(published('18:30', 'Africa/Lagos', now).toISOString(), '2026-06-15T17:30:00.000Z');
  assert.equal(published('tomorrow 9am', 'Africa/Lagos', now).toISOString(), '2026-06-16T08:00:00.000Z');
  assert.equal(published('+2h', 'Africa/Lagos', now).toISOString(), '2026-06-15T14:00:00.000Z');
  assert.equal(published('6pm', 'Africa/Lagos', '2026-06-15T18:00:00.000Z').toISOString(), '2026-06-16T17:00:00.000Z');
});

test('relative inputs with seconds round up and keep the one-minute safety margin', () => {
  const result = parseScheduleTime('+1m', 'UTC', new Date('2026-06-15T12:00:30.000Z'));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.publishAt.toISOString(), '2026-06-15T12:02:00.000Z');
});

test('rejects invalid dates, ambiguous bare hours, invalid 12-hour clocks, near-past and distant times', () => {
  const now = new Date('2026-06-15T12:00:30.000Z');
  for (const input of ['2026-02-31 10:00', '18', '0pm', '18pm', 'today 12:01', 'nonsense']) {
    assert.equal(parseScheduleTime(input, 'UTC', now).ok, false, input);
  }
  assert.equal(parseScheduleTime('+91d', 'UTC', now).ok, false);
});

test('rejects nonexistent DST wall time and deterministically accepts first repeated hour', () => {
  const gap = parseScheduleTime('2026-03-08 02:30', 'America/New_York', new Date('2026-03-01T00:00:00.000Z'));
  assert.equal(gap.ok, false);

  const overlap = published('2026-11-01 01:30', 'America/New_York', '2026-10-31T00:00:00.000Z');
  assert.equal(overlap.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('invalid stored zones degrade to UTC and labels remain explicit', () => {
  assert.equal(safeZone('Not/A_Zone'), 'UTC');
  assert.equal(published('2026-12-24 18:00', 'Not/A_Zone', '2026-12-01T00:00:00.000Z').toISOString(), '2026-12-24T18:00:00.000Z');
  assert.match(formatLocalTime(new Date('2026-12-24T18:00:00.000Z'), 'UTC'), /Thu 24 Dec 2026, 18:00 \(UTC\)/);
});
