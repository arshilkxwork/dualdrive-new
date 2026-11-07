import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreRepoState } from '../src/state.ts';

const approval = { headSha: 'a'.repeat(40), reviewers: ['@switch-alice:local'], labels: { '@switch-alice:local': 'alice' } };

test('a per-repo entry from before verdicts were saved keeps its approvals', () => {
  assert.deepEqual(restoreRepoState({ '4': approval, '7': approval }), {
    approvals: { '4': approval, '7': approval },
    verdicts: {},
  });
});

test('a per-repo entry in the current shape is read as it is', () => {
  const verdicts = { '4': { kind: 'malformed', pr: 4, headSha: null, reason: 'x' } };
  assert.deepEqual(restoreRepoState({ approvals: { '4': approval }, verdicts }), {
    approvals: { '4': approval },
    verdicts,
  });
  assert.deepEqual(restoreRepoState({ approvals: { '4': approval } }), { approvals: { '4': approval }, verdicts: {} });
});

test('a missing or broken entry is empty, not a crash', () => {
  for (const entry of [undefined, null, 'x', 3, []]) {
    assert.deepEqual(restoreRepoState(entry), { approvals: {}, verdicts: {} }, String(entry));
  }
  // Only pull request numbers count as approvals in the older shape.
  assert.deepEqual(restoreRepoState({ '4': approval, junk: 1 }).approvals, { '4': approval });
});
