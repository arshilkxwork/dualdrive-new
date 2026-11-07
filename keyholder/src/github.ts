import { Octokit } from '@octokit/rest';
import type { GitHubPort, PullRequest } from './gate.ts';
import { GITHUB_FILES_LIMIT, latestStatuses, statusAsCheckRun, type CheckRun, type MergeMethod } from './rules.ts';

// `baseUrl` is GITHUB_API_URL: GitHub Enterprise's API, or the sandbox's mock.
export function createGitHub(
  token: string,
  owner: string,
  repo: string,
  baseUrl?: string,
  mergeMethod: MergeMethod = 'merge',
): GitHubPort {
  const octokit = new Octokit({ auth: token, userAgent: 'dualdrive-keyholder', ...(baseUrl ? { baseUrl } : {}) });

  return {
    async getPull(pr: number): Promise<PullRequest> {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
      return {
        state: data.state === 'open' ? 'open' : 'closed',
        merged: data.merged,
        headSha: data.head.sha,
        baseRef: data.base.ref,
        title: data.title,
        url: data.html_url,
      };
    },

    // A renamed file counts under both names, so moving src/auth.js elsewhere
    // still trips the floor.
    async listChangedPaths(pr: number): Promise<string[]> {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pr,
        per_page: 100,
      });
      // GitHub stops listing at 3000 files. Refuse rather than judge the
      // floor on part of the change; the approval isn't counted.
      if (files.length >= GITHUB_FILES_LIMIT) {
        throw new Error(
          `GitHub lists only the first ${GITHUB_FILES_LIMIT} files of a pull request, so the sensitive-path check can't see all of #${pr}. Split it up`,
        );
      }
      return files.flatMap((file) => (file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]));
    },

    // Check runs (GitHub Actions and other apps) and commit statuses (Jenkins,
    // CircleCI and anything else on the Statuses API) together. A required
    // check can be either.
    async listCheckRuns(sha: string): Promise<CheckRun[]> {
      const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
        owner,
        repo,
        ref: sha,
        per_page: 100,
      });
      // Every page: the combined-status call stops at 100 contexts.
      const statuses = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, {
        owner,
        repo,
        ref: sha,
        per_page: 100,
      });
      return [
        ...runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion })),
        ...latestStatuses(statuses).map((status) => statusAsCheckRun(status)),
      ];
    },

    // GitHub keeps its own title ("Merge pull request #N from ..." or, for a
    // squash, the pull request's) and uses `message` as the body. A rebase
    // has no commit of its own, so it drops `message`.
    async merge(pr: number, sha: string, message: string): Promise<{ sha: string }> {
      const { data } = await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: pr,
        sha,
        commit_message: message,
        merge_method: mergeMethod,
      });
      return { sha: data.sha };
    },
  };
}
