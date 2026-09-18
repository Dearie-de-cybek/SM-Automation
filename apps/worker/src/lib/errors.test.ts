import assert from 'node:assert/strict';
import test from 'node:test';

import { LlmError } from '@sm/core/ai/types';
import { ProviderError } from '@sm/core/providers/errors';
import { classifyError, isReauthError } from './errors';

test('preserves provider retry metadata', () => {
  const result = classifyError(
    new ProviderError('rate_limit', 'slow down', { safeToRetry: true, retryAfterSec: 9, status: 429 }),
  );
  assert.deepEqual(result, { message: 'slow down', kind: 'rate_limit', safeToRetry: true, retryAfterSec: 9 });
});

test('classifies LLM rate limits and terminal validation failures', () => {
  assert.deepEqual(classifyError(new LlmError('quota', { retryable: true, status: 429 })), {
    message: 'quota',
    kind: 'rate_limit',
    safeToRetry: true,
    retryAfterSec: null,
  });
  assert.equal(classifyError(new LlmError('bad prompt')).kind, 'invalid');
});

test('unknown errors are terminal, use fallback, and clamp stored message length', () => {
  assert.deepEqual(classifyError(null, 'fallback'), {
    message: 'fallback',
    kind: 'unknown',
    safeToRetry: false,
    retryAfterSec: null,
  });
  const result = classifyError(new Error('x'.repeat(3_000)));
  assert.equal(result.message.length, 2_000);
  assert.equal(result.message.endsWith('…'), true);
});

test('only auth and permission failures require reconnection', () => {
  const base = { message: 'x', safeToRetry: false, retryAfterSec: null } as const;
  assert.equal(isReauthError({ ...base, kind: 'auth' }), true);
  assert.equal(isReauthError({ ...base, kind: 'permission' }), true);
  assert.equal(isReauthError({ ...base, kind: 'transient' }), false);
});
