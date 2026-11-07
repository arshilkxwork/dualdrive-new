import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepoRouter, parseRepositories, unknownRepoReply } from '../src/repos.ts';

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
