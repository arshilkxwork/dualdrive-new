import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate, type GateOptions, type GitHubPort, type PullRequest } from '../src/gate.ts';
import { parseVerdictTag, type CheckRun } from '../src/rules.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const alice = { key: '@switch-user-a:local', label: 'alice' };
const bob = { key: '@switch-user-b:local', label: 'bob' };

class FakeGitHub implements GitHubPort {
  pull: PullRequest = {
    state: 'open',
    merged: false,
    headSha: A,
    baseRef: 'main',
    title: 'Hash passwords with scrypt',
    url: 'https://github.com/o/r/pull/1',
  };
  paths = ['src/auth.js', 'test/auth.test.js'];
  runs: CheckRun[][] = [[{ status: 'completed', conclusion: 'success' }]];
  merged: string[] = [];
  messages: string[] = [];
  // Runs once, the first time CI is polled, to act between approval and merge.
  onFirstCiPoll: (() => Promise<void>) | null = null;
  async getPull() {
    return { ...this.pull };
  }
  async listChangedPaths() {
    return this.paths;
  }
  async listCheckRuns() {
    const hook = this.onFirstCiPoll;
    this.onFirstCiPoll = null;
    await hook?.();
    return this.runs.length > 1 ? this.runs.shift()! : this.runs[0];
  }
  async merge(_pr: number, sha: string, message: string) {
    this.merged.push(sha);
    this.messages.push(message);
    return { sha: 'c'.repeat(40) };
  }
}

function setup(options: Partial<GateOptions> = {}) {
  const github = new FakeGitHub();
  const posts: string[] = [];
  const ledger: string[] = [];
  const gate = new Gate(
    github,
    { post: async (body) => void posts.push(body), record: async (line) => void ledger.push(line) },
    { approvals: {} },
    { ciPollMs: 1, ciTimeoutMs: 3, sleep: async () => {}, ...options },
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
  assert.match(posts.at(-1)!, /1 of 2, rated MEDIUM by the auditor, raised to HIGH because it changes src\/auth\.js/);
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

test('a GitHub failure after the approval is counted says it was counted', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.listCheckRuns = async () => {
    throw new Error('API rate limit exceeded');
  };
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /approvals for #1 stand \(1 of 1\).*rate limit.*Approve again to retry/);
  assert.ok(!posts.some((post) => /nothing was counted/.test(post)));
  github.runs = [[{ status: 'completed', conclusion: 'success' }]];
  github.listCheckRuns = FakeGitHub.prototype.listCheckRuns;
  await gate.handleApproval(1, alice);
  assert.deepEqual(github.merged, [A]);
});

test('a merge GitHub refuses is reported as a refusal', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.merge = async () => {
    throw new Error('Required status check "test" is expected');
  };
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /GitHub refused to merge #1: Required status check/);
});

test('nothing the gate posts mentions anyone with an @', async () => {
  const runs: string[][] = [];
  for (const risk of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
    const { gate, posts, verdict } = setup();
    await gate.handleApproval(1, alice);
    verdict(risk);
    await gate.handleApproval(1, alice);
    await gate.handleApproval(1, bob);
    runs.push(posts);
  }
  const { gate, posts, github } = setup();
  gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "LOW", "head_sha": "${B}"} -->`)!);
  await gate.handleApproval(1, alice);
  gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "LOW", "head_sha": "${A}",} -->`)!);
  await gate.handleApproval(1, alice);
  github.pull.merged = true;
  await gate.handleApproval(1, alice);
  runs.push(posts);
  const withMention = runs.flat().filter((post) => post.includes('@'));
  assert.deepEqual(withMention, []);
});

test('a failure after the approval is saved says it was saved', async () => {
  const github = new FakeGitHub();
  github.paths = ['README.md'];
  github.runs = [[{ status: 'completed', conclusion: 'failure' }]];
  const posts: string[] = [];
  let failed = false;
  const state = { approvals: {} as Record<string, { headSha: string; reviewers: string[] }> };
  const gate = new Gate(
    github,
    {
      post: async (body) => {
        if (!failed && body.startsWith('Approval from')) {
          failed = true;
          throw new Error('Switch is unreachable');
        }
        posts.push(body);
      },
      record: async () => {},
    },
    state,
    { ciPollMs: 1, ciTimeoutMs: 3, sleep: async () => {} },
  );
  gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "LOW", "head_sha": "${A}"} -->`)!);
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /alice's approval for #1 is recorded, but something failed after that: Switch is unreachable/);
  assert.deepEqual(state.approvals[1].reviewers, [alice.key]);
});

test('the gate uses the configured sensitive paths and names the one that tripped it', async () => {
  const github = new FakeGitHub();
  github.paths = ['internal/auth/token.go'];
  const posts: string[] = [];
  const gate = new Gate(
    github,
    { post: async (body) => void posts.push(body), record: async () => {} },
    { approvals: {} },
    { sensitivePaths: ['internal/auth/'], ciPollMs: 1, ciTimeoutMs: 3, sleep: async () => {} },
  );
  gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "LOW", "head_sha": "${A}"} -->`)!);
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /1 of 2, rated LOW by the auditor, raised to HIGH because it changes internal\/auth\/token\.go/);
  assert.deepEqual(github.merged, []);
});

test('a pull request retargeted away from main is not merged, and its approvals wait', async () => {
  const { gate, posts, verdict, github, ledger } = setup();
  verdict('HIGH');
  await gate.handleApproval(1, alice);
  github.pull.baseRef = 'gh-pages';
  await gate.handleApproval(1, bob);
  assert.match(posts.at(-1)!, /#1 targets gh-pages, and DualDrive only merges into main, so this approval wasn't counted/);
  assert.match(ledger.at(-1)!, /targets gh-pages, not main/);
  assert.deepEqual(github.merged, []);
  github.pull.baseRef = 'main';
  await gate.handleApproval(1, bob);
  assert.deepEqual(github.merged, [A]);
});

test('a retarget while CI runs stops the merge', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.runs = [[], [{ status: 'completed', conclusion: 'success' }]];
  github.onFirstCiPoll = async () => {
    github.pull.baseRef = 'release';
  };
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /#1 targets release, and DualDrive only merges into main, so it isn't being merged/);
  assert.deepEqual(github.merged, []);
});

test('the base branch can be configured', async () => {
  const { gate, verdict, github } = setup({ baseBranch: 'trunk' });
  verdict('LOW');
  github.paths = ['README.md'];
  await gate.handleApproval(1, alice);
  assert.deepEqual(github.merged, []);
  github.pull.baseRef = 'trunk';
  await gate.handleApproval(1, alice);
  assert.deepEqual(github.merged, [A]);
});

test('a reviewer can take an approval back, and only their own', async () => {
  const { gate, posts, verdict, github, ledger } = setup();
  verdict('HIGH');
  await gate.handleRevoke(1, alice);
  assert.match(posts.at(-1)!, /alice hasn't approved #1, so there's nothing to take back/);
  await gate.handleApproval(1, alice);
  await gate.handleRevoke(1, bob);
  assert.match(posts.at(-1)!, /bob hasn't approved #1/);
  await gate.handleRevoke(1, alice);
  assert.match(posts.at(-1)!, /Took back alice's approval for #1\. 0 approvals are left\./);
  assert.match(ledger.at(-1)!, /approval withdrawn by alice/);
  await gate.handleApproval(1, bob);
  assert.match(posts.at(-1)!, /Approval from bob recorded for #1 \(1 of 2/);
  assert.deepEqual(github.merged, []);
});

test('an approval taken back while CI runs stops the merge', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('LOW');
  github.paths = ['README.md'];
  github.runs = [[], [{ status: 'completed', conclusion: 'success' }]];
  github.onFirstCiPoll = () => gate.handleRevoke(1, alice);
  await gate.handleApproval(1, alice);
  assert.ok(posts.some((post) => /Took back alice's approval/.test(post)));
  assert.match(posts.at(-1)!, /An approval for #1 was taken back while CI ran \(0 of 1\), so it isn't being merged/);
  assert.deepEqual(github.merged, []);
});

test('a required check that has not registered yet is waited for', async () => {
  const { gate, posts, verdict, github } = setup({ requiredChecks: ['test'] });
  verdict('LOW');
  github.paths = ['README.md'];
  const lint = { name: 'lint', status: 'completed', conclusion: 'success' };
  github.runs = [[lint], [lint, { name: 'test', status: 'completed', conclusion: 'success' }]];
  await gate.handleApproval(1, alice);
  assert.ok(posts.some((post) => /Waiting for CI/.test(post)));
  assert.deepEqual(github.merged, [A]);
});

test('a required check that never shows up blocks the merge', async () => {
  const { gate, posts, verdict, github } = setup({ requiredChecks: ['test'] });
  verdict('LOW');
  github.paths = ['README.md'];
  github.runs = [[{ name: 'lint', status: 'completed', conclusion: 'success' }]];
  await gate.handleApproval(1, alice);
  assert.match(posts.at(-1)!, /hasn't finished/);
  assert.deepEqual(github.merged, []);
});

test('the merge commit names the reviewers, the commit and the risk', async () => {
  const { gate, verdict, github } = setup();
  verdict('MEDIUM');
  await gate.handleApproval(1, alice);
  await gate.handleApproval(1, bob);
  assert.deepEqual(github.messages, [
    'Hash passwords with scrypt\n\n' +
      'Approved-by: alice\n' +
      'Approved-by: bob\n' +
      `Approved-commit: ${A}\n` +
      'Risk: rated MEDIUM by the auditor, raised to HIGH because it changes src/auth.js',
  ]);
});

test('approvals saved before labels existed still merge, named by their key', async () => {
  const github = new FakeGitHub();
  const gate = new Gate(
    github,
    { post: async () => {}, record: async () => {} },
    { approvals: { 1: { headSha: A, reviewers: [alice.key] } } },
    { ciPollMs: 1, ciTimeoutMs: 3, sleep: async () => {} },
  );
  gate.recordVerdict(parseVerdictTag(`<!-- DUALDRIVE_VERDICT: {"pr": 1, "risk": "HIGH", "head_sha": "${A}"} -->`)!);
  await gate.handleApproval(1, bob);
  assert.deepEqual(github.merged, [A]);
  assert.match(github.messages[0], /Approved-by: @switch-user-a:local\nApproved-by: bob\n/);
});

test('nothing posted about base branches or revocations mentions anyone', async () => {
  const { gate, posts, verdict, github } = setup();
  verdict('HIGH');
  await gate.handleRevoke(1, alice);
  await gate.handleApproval(1, alice);
  await gate.handleRevoke(1, alice);
  github.pull.baseRef = 'gh-pages';
  await gate.handleApproval(1, alice);
  assert.deepEqual(
    posts.filter((post) => post.includes('@')),
    [],
  );
});
