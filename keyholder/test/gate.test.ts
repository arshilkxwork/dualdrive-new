import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, type GitHubPort, type PullRequest } from '../src/gate.ts';
import { parseVerdictTag, type CheckRun } from '../src/rules.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const alice = { key: '@switch-user-a:local', label: 'alice' };
const bob = { key: '@switch-user-b:local', label: 'bob' };

class FakeGitHub implements GitHubPort {
  pull: PullRequest = { state: 'open', merged: false, headSha: A, url: 'https://github.com/o/r/pull/1' };
  paths = ['src/auth.js', 'test/auth.test.js'];
  runs: CheckRun[][] = [[{ status: 'completed', conclusion: 'success' }]];
  merged: string[] = [];
  async getPull() {
    return { ...this.pull };
  }
  async listChangedPaths() {
    return this.paths;
  }
  async listCheckRuns() {
    return this.runs.length > 1 ? this.runs.shift()! : this.runs[0];
  }
  async merge(_pr: number, sha: string) {
    this.merged.push(sha);
    return { sha: 'c'.repeat(40) };
  }
}

function setup() {
  const github = new FakeGitHub();
  const posts: string[] = [];
  const ledger: string[] = [];
  const gate = new Gate(
    github,
    { post: async (body) => void posts.push(body), record: async (line) => void ledger.push(line) },
    { approvals: {} },
    { auditorHandle: 'auditor', ciPollMs: 1, ciTimeoutMs: 3, sleep: async () => {} },
  );
  const verdict = (risk: string, sha = A) =>
    gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "${risk}", "head_sha": "${sha}"} -->`)!);
  return { github, posts, ledger, gate, verdict };
}

test('an approval before any verdict waits and is not counted', async () => {
  const { gate, posts, verdict, github } = setup();
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /No audit verdict yet/);
  verdict('MEDIUM');
  github.paths = ['README.md'];
  await gate.handleApproval(1, alice);
  assert.deepEqual(github.merged, [A]);
});

test('a MEDIUM verdict on src/auth.js needs two people, and the same person twice is one', async () => {
  const { gate, posts, verdict, github, ledger } = setup();
  verdict('MEDIUM');
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /1 of 2, rated MEDIUM by @auditor, raised to HIGH because it changes src\/auth\.js/);
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /Already counted alice's approval for #1 \(1 of 2\)/);
  assert.deepEqual(github.merged, []);
  await gate.handleApproval(1, bob);
  assert.deepEqual(github.merged, [A]);
  assert.match(posts.at(-1)!, /^Merged #1/);
  assert.match(ledger.at(-1)!, /merged as c{40}/);
});

test('a CRITICAL verdict is never merged', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('CRITICAL');
  await gate.handleApproval(1, alice);
  await gate.handleApproval(1, bob);
  assert.deepEqual(github.merged, []);
  assert.match(posts.at(-1)!, /rated CRITICAL/);
});

test('a commit after the verdict makes the audit stale', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.pull.headSha = B;
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /stale/);
  assert.deepEqual(github.merged, []);
});

test('approvals reset when the head moves between approvals', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('HIGH');
  await gate.handleApproval(1, alice);
  github.pull.headSha = B;
  verdict('HIGH', B);
  await gate.handleApproval(1, bob);
  assert.ok(posts.some((post) => /count starts again/.test(post)));
  assert.match(posts.at(-1)!, /1 of 2/);
  assert.deepEqual(github.merged, []);
});

test('a malformed verdict at the current commit fails closed', async () => {
  const { gate, posts, github } = setup();
  gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "LOW", "head_sha": "${A}",} -->`)!);
  github.paths = ['README.md'];
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /Treating #1 as CRITICAL/);
  assert.deepEqual(github.merged, []);
});

test('CI that has not registered yet is waited for, then merged once green', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.runs = [[], [{ status: 'in_progress', conclusion: null }], [{ status: 'completed', conclusion: 'success' }]];
  await gate.handleApproval(1, alice);
  assert.ok(posts.some((post) => /Waiting for CI/.test(post)));
  assert.deepEqual(github.merged, [A]);
});

test('CI that never finishes leaves the approvals and does not merge', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.runs = [[]];
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /hasn't finished/);
  assert.deepEqual(github.merged, []);
});

test('failed CI blocks the merge', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.runs = [[{ status: 'completed', conclusion: 'failure' }]];
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /CI failed/);
  assert.deepEqual(github.merged, []);
});

test('a GitHub error is reported, not thrown', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.getPull = async () => {
    throw new Error('Bad credentials');
  };
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /couldn't check #1 on GitHub.*Bad credentials/);
});
