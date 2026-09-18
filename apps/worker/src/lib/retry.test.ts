import assert from 'node:assert/strict';
import test from 'node:test';

import { backoffSeconds, startAfterDate } from './retry';

test('uses capped exponential backoff from the failed attempt number', () => {
  assert.equal(backoffSeconds(0), 60);
  assert.equal(backoffSeconds(1), 60);
  assert.equal(backoffSeconds(2), 120);
  assert.equal(backoffSeconds(3), 240);
  assert.equal(backoffSeconds(99), 3_600);
  assert.equal(backoffSeconds(Number.NaN), 60);
});

test('provider Retry-After wins and is rounded and capped', () => {
  assert.equal(backoffSeconds(9, 0.1), 1);
  assert.equal(backoffSeconds(1, 75), 75);
  assert.equal(backoffSeconds(1, 9_000), 3_600);
  assert.equal(backoffSeconds(2, -1), 120);
});

test('startAfterDate is pure and guards non-finite or negative delays', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(startAfterDate(30, now).toISOString(), '2026-01-01T00:00:30.000Z');
  assert.equal(startAfterDate(-1, now).toISOString(), now.toISOString());
  assert.equal(startAfterDate(Number.NaN, now).toISOString(), now.toISOString());
});
