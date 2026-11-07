import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff, describeNetworkError } from '../src/backoff.ts';

test('the wait doubles from 1s and stops at 30s', () => {
  const backoff = new Backoff();
  const waits = Array.from({ length: 8 }, () => backoff.next());
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('a good connection starts the count again', () => {
  const backoff = new Backoff();
  backoff.next();
  backoff.next();
  backoff.next();
  backoff.reset();
  assert.equal(backoff.next(), 1000);
});

test('a long outage never overflows the wait', () => {
  const backoff = new Backoff();
  for (let i = 0; i < 2000; i++) {
    backoff.next();
  }
  assert.equal(backoff.next(), 30000);
});

test('a refused connection is logged with its code', () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
  assert.equal(describeNetworkError(refused), 'fetch failed (ECONNREFUSED)');
  assert.equal(describeNetworkError(new Error('opening the event stream failed with 502')), 'opening the event stream failed with 502');
  assert.equal(describeNetworkError('plain'), 'plain');
});
