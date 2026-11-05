import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciState, floorRisk, parseApproval, parseVerdictTag, requiredApprovals } from '../src/rules.ts';

const SHA = 'a1b2c3d4e5f67890123456789012345678901234';

test('a well-formed verdict tag parses', () => {
  const body = `<!-- DUALDRIVE_VERDICT: {"pr": 42, "risk": "CRITICAL", "head_sha": "${SHA}", "cwe": ["CWE-306"]} -->\n🛡️ CRITICAL`;
  assert.deepEqual(parseVerdictTag(body), {
    kind: 'valid',
    verdict: { pr: 42, risk: 'CRITICAL', headSha: SHA, cwe: ['CWE-306'] },
  });
});

test('a short sha makes the verdict malformed but keeps the pr', () => {
  const parsed = parseVerdictTag('<!-- DUALDRIVE_VERDICT: {"pr": 7, "risk": "LOW", "head_sha": "a1b2c3d"} -->');
  assert.equal(parsed?.kind, 'malformed');
  assert.equal(parsed?.kind === 'malformed' && parsed.pr, 7);
});

test('broken JSON is malformed, with the sha recovered', () => {
  const parsed = parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 3, "risk": "LOW", "head_sha": "${SHA}", } -->`);
  assert.deepEqual(parsed, { kind: 'malformed', pr: 3, headSha: SHA, reason: 'the tag is not valid JSON' });
});

test('an unknown risk level is malformed', () => {
  const parsed = parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 3, "risk": "FINE", "head_sha": "${SHA}"} -->`);
  assert.equal(parsed?.kind, 'malformed');
});

test('a message with no tag has no verdict', () => {
  assert.equal(parseVerdictTag('looks fine to me'), null);
});

test('approvals parse with or without a colon, hash or "pr"', () => {
  assert.equal(parseApproval('@keyholder approve #1', 'keyholder'), 1);
  assert.equal(parseApproval('@keyholder: approve #12 - looks good', 'keyholder'), 12);
  assert.equal(parseApproval('@Keyholder approve 3', 'keyholder'), 3);
  assert.equal(parseApproval('@keyholder approve PR 4', 'keyholder'), 4);
  assert.equal(parseApproval('@keyholder please merge #1', 'keyholder'), null);
  assert.equal(parseApproval('@keyholderx approve #1', 'keyholder'), null);
});

test('src/auth.js itself raises the floor', () => {
  assert.equal(floorRisk(['src/auth.js']), 'HIGH');
  assert.equal(floorRisk(['src/auth/hash.js']), 'HIGH');
  assert.equal(floorRisk(['package.json']), 'HIGH');
  assert.equal(floorRisk(['.github/workflows/test.yml']), 'HIGH');
  assert.equal(floorRisk(['config/.env.production']), 'HIGH');
  assert.equal(floorRisk(['README.md', 'test/auth.test.js']), 'LOW');
});

test('approvals needed per risk', () => {
  assert.equal(requiredApprovals('LOW'), 1);
  assert.equal(requiredApprovals('MEDIUM'), 1);
  assert.equal(requiredApprovals('HIGH'), 2);
  assert.equal(requiredApprovals('CRITICAL'), Infinity);
});

test('no check runs yet is pending, not passed', () => {
  assert.equal(ciState([]), 'pending');
  assert.equal(ciState([{ status: 'in_progress', conclusion: null }]), 'pending');
  assert.equal(ciState([{ status: 'completed', conclusion: 'success' }]), 'passed');
  assert.equal(ciState([{ status: 'completed', conclusion: 'failure' }, { status: 'queued', conclusion: null }]), 'failed');
});
