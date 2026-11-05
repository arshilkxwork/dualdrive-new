import { Octokit } from '@octokit/rest';
import type { GitHubPort, PullRequest } from './gate.ts';
import type { CheckRun } from './rules.ts';

export function createGitHub(token: string, owner: string, repo: string): GitHubPort {
  const octokit = new Octokit({ auth: token, userAgent: 'dualdrive-keyholder' });

  return {
    async getPull(pr: number): Promise<PullRequest> {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
      return {
        state: data.state === 'open' ? 'open' : 'closed',
        merged: data.merged,
        headSha: data.head.sha,
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
      return files.flatMap((file) => (file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]));
    },

    async listCheckRuns(sha: string): Promise<CheckRun[]> {
      const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
        owner,
        repo,
        ref: sha,
        per_page: 100,
      });
      return runs.map((run) => ({ status: run.status, conclusion: run.conclusion }));
    },

    async merge(pr: number, sha: string): Promise<{ sha: string }> {
      const { data } = await octokit.rest.pulls.merge({ owner, repo, pull_number: pr, sha });
      return { sha: data.sha };
    },
  };
}
