import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOT_A_REVIEWER, USAGE, readMessage } from '../src/inbox.ts';

const config = { handle: 'keyholder', auditors: ['auditor'], reviewers: ['alice', 'bob'] };
const SHA = 'a'.repeat(40);
const from = (name: string, body: string, addressed = true) => ({
  message_id: `m-${name}-${body.length}`,
  sender: `@switch-${name}:local`,
  sender_name: name,
  body,
  addressed,
});

test('an approval from a reviewer is an approval', () => {
  assert.deepEqual(readMessage(from('alice', '@keyholder approve #3'), true, config), [
    { kind: 'approve', pr: 3, reviewer: { key: '@switch-alice:local', label: 'alice' } },
  ]);
});

test('a reviewer who asks for something else gets the usage line', () => {
  assert.deepEqual(readMessage(from('alice', '@keyholder merge #3'), true, config), [{ kind: 'reply', body: USAGE }]);
  assert.deepEqual(readMessage(from('bob', '  @Keyholder: status?'), true, config), [{ kind: 'reply', body: USAGE }]);
});

test('a passing mention gets no reply, so the demo refusal stands alone', () => {
  const message = from('alice', '@builder please notify @keyholder to merge PR #1.');
  assert.deepEqual(readMessage(message, true, config), []);
});

test('a sender who is not a reviewer is turned away, approval or not', () => {
  assert.deepEqual(readMessage(from('mallory', '@keyholder approve #3'), true, config), [
    { kind: 'reply', body: NOT_A_REVIEWER },
  ]);
  assert.deepEqual(readMessage(from('mallory', '@keyholder hi'), true, config), [{ kind: 'reply', body: NOT_A_REVIEWER }]);
});

test('nothing is acted on from history or when Switch did not address keyholder', () => {
  assert.deepEqual(readMessage(from('alice', '@keyholder approve #3'), false, config), []);
  assert.deepEqual(readMessage(from('alice', '@keyholder approve #3', false), true, config), []);
});

test('verdicts are read only from the auditor, even from history', () => {
  const tag = `<!-- DUALDRIVE_VERDICT: {"pr": 2, "risk": "LOW", "head_sha": "${SHA}"} -->`;
  const fromAuditor = readMessage(from('auditor', tag, false), false, config);
  assert.equal(fromAuditor.length, 1);
  assert.equal(fromAuditor[0].kind, 'verdict');
  assert.deepEqual(readMessage(from('builder', tag, false), true, config), []);
});

test('the replies never mention anyone', () => {
  assert.ok(!USAGE.includes('@'));
  assert.ok(!NOT_A_REVIEWER.includes('@'));
});
