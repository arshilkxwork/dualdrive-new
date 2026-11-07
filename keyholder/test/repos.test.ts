import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepoRouter, parseRepoSettings, parseRepositories, requireOwnSensitivePaths, unknownRepoReply } from '../src/repos.ts';

test('GITHUB_REPOSITORY comes first, then EXTRA_REPOSITORIES without repeats', () => {
  const repos = parseRepositories('org/backend', ' org/frontend, ORG/Backend ,org/infra,, ');
  assert.deepEqual(
    repos.map((repo) => repo.name),
    ['org/backend', 'org/frontend', 'org/infra'],
  );
  assert.deepEqual(repos[1], { owner: 'org', repo: 'frontend', name: 'org/frontend' });
  assert.deepEqual(parseRepositories('o/r', undefined).length, 1);
});

test('a repo setting that is not owner/repo is refused', () => {
  assert.throws(() => parseRepositories('just-a-name', undefined), /GITHUB_REPOSITORY must look like owner\/repo/);
  assert.throws(() => parseRepositories('o/r/x', undefined), /GITHUB_REPOSITORY/);
  assert.throws(() => parseRepositories('o/r', 'o/ok,bad name/x'), /EXTRA_REPOSITORIES/);
});

test('the router sends no repo to the default, matches names case-insensitively, and refuses the rest', () => {
  const made: string[] = [];
  const router = new RepoRouter(parseRepositories('org/repo-a', 'org/repo-b'), (repo, isDefault) => {
    made.push(`${repo.name}${isDefault ? ' (default)' : ''}`);
    return repo.name;
  });
  assert.deepEqual(made, ['org/repo-a (default)', 'org/repo-b']);
  assert.equal(router.route(undefined), 'org/repo-a');
  assert.equal(router.route(null), 'org/repo-a');
  assert.equal(router.route('ORG/Repo-A'), 'org/repo-a');
  assert.equal(router.route('org/repo-b'), 'org/repo-b');
  assert.equal(router.route('org/repo-c'), null);
  assert.equal(router.route('evil/repo-a'), null);
});

test('the unknown-repo reply lists the governed repos and mentions no one', () => {
  const reply = unknownRepoReply('org/repo-c', ['org/repo-a', 'org/repo-b']);
  assert.match(reply, /org\/repo-a, org\/repo-b, and org\/repo-c isn't one of them/);
  assert.ok(!reply.includes('@'));
});

test('REPO_SETTINGS gives a repo its own branch, checks and sensitive paths', () => {
  const repos = parseRepositories('org/api', 'org/web');
  const settings = parseRepoSettings(
    '{"Org/Web": {"base_branch": "master", "required_checks": ["build", " lint "], "sensitive_paths": ["./src/session/", "package.json"]}}',
    repos,
  );
  assert.deepEqual(settings.get('org/web'), {
    baseBranch: 'master',
    requiredChecks: ['build', 'lint'],
    sensitivePaths: ['src/session/', 'package.json'],
  });
  assert.equal(settings.get('org/api'), undefined);
  assert.equal(parseRepoSettings(undefined, repos).size, 0);
  assert.equal(parseRepoSettings('  ', repos).size, 0);
});

test('REPO_SETTINGS refuses anything it would have to guess at', () => {
  const repos = parseRepositories('org/api', 'org/web');
  const refused: Record<string, RegExp> = {
    'nope': /not valid JSON/,
    '[]': /JSON object/,
    '{"org/other": {}}': /org\/other, which isn't GITHUB_REPOSITORY/,
    '{"org/web": {"base_branch": "master", "reviewers": ["eve"]}}': /fields keyholder doesn't read: reviewers/,
    '{"org/web": {"sensitive_paths": []}}': /at least one path/,
    '{"org/web": {"required_checks": "build"}}': /list of check names/,
    '{"org/web": {"base_branch": "a branch"}}': /branch name/,
    '{"org/web": {}, "ORG/WEB": {}}': /twice/,
  };
  for (const [text, reason] of Object.entries(refused)) {
    assert.throws(() => parseRepoSettings(text, repos), reason, text);
  }
});

test('every extra repo has to name its own sensitive paths', () => {
  const repos = parseRepositories('org/api', 'org/web,org/infra');
  assert.throws(
    () => requireOwnSensitivePaths(repos, parseRepoSettings('{"org/web": {"base_branch": "master"}}', repos)),
    /Set sensitive_paths in REPO_SETTINGS for org\/web, org\/infra/,
  );
  const both = parseRepoSettings(
    '{"org/web": {"sensitive_paths": ["auth/"]}, "org/infra": {"sensitive_paths": ["terraform/"]}}',
    repos,
  );
  assert.doesNotThrow(() => requireOwnSensitivePaths(repos, both));
  // The default repo is covered by SENSITIVE_PATHS.
  assert.doesNotThrow(() => requireOwnSensitivePaths(parseRepositories('org/api', undefined), new Map()));
});

test('REPO_SETTINGS takes a merge_method and refuses paths that match nothing', () => {
  const repos = parseRepositories('org/api', 'org/web');
  const settings = parseRepoSettings('{"org/web": {"sensitive_paths": ["auth/"], "merge_method": "squash"}}', repos);
  assert.equal(settings.get('org/web')?.mergeMethod, 'squash');
  assert.throws(() => parseRepoSettings('{"org/web": {"merge_method": "ff"}}', repos), /merge_method must be merge, squash or rebase/);
  assert.throws(() => parseRepoSettings('{"org/web": {"sensitive_paths": ["/"]}}', repos), /repo root/);
  assert.throws(() => parseRepoSettings('{"org/web": {"sensitive_paths": ["auth/*.py"]}}', repos), /glob pattern/);
});

test('REPO_SETTINGS takes require_ci as a boolean', () => {
  const repos = parseRepositories('org/api', 'org/docs');
  const settings = parseRepoSettings('{"org/docs": {"sensitive_paths": ["CODEOWNERS"], "require_ci": false}}', repos);
  assert.equal(settings.get('org/docs')?.requireCi, false);
  assert.throws(() => parseRepoSettings('{"org/docs": {"require_ci": "no"}}', repos), /require_ci must be true or false/);
});
