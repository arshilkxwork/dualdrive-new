// Which repos one @keyholder governs, and which one a command or verdict
// means. GITHUB_REPOSITORY is the default: "#4" and a verdict with no "repo"
// are its pull requests. EXTRA_REPOSITORIES adds more, reached as
// "owner/repo#4". A repo on neither list is refused, whatever the token could
// reach.
//
// Each repo gets its own Gate, so approvals, verdicts and queues for
// org/a#1 and org/b#1 can't mix: they live in different objects.

import { isRepoName } from './rules.ts';

export interface RepoName {
  owner: string;
  repo: string;
  // "owner/repo" as configured, for messages.
  name: string;
}

// GitHub treats owner and repo names case-insensitively.
export function repoKey(name: string): string {
  return name.toLowerCase();
}

export function parseRepoName(text: string, setting: string): RepoName {
  const name = text.trim();
  if (!isRepoName(name)) {
    throw new Error(`${setting} must look like owner/repo; got "${name}"`);
  }
  const [owner, repo] = name.split('/');
  return { owner, repo, name };
}

// GITHUB_REPOSITORY first, then EXTRA_REPOSITORIES (comma-separated) without
// repeats.
export function parseRepositories(defaultRepo: string, extra: string | undefined): RepoName[] {
  const repos = [parseRepoName(defaultRepo, 'GITHUB_REPOSITORY')];
  for (const entry of (extra ?? '').split(',')) {
    if (entry.trim() === '') {
      continue;
    }
    const parsed = parseRepoName(entry, 'EXTRA_REPOSITORIES');
    if (!repos.some((known) => repoKey(known.name) === repoKey(parsed.name))) {
      repos.push(parsed);
    }
  }
  return repos;
}

export class RepoRouter<G> {
  private readonly byKey = new Map<string, G>();

  constructor(
    private readonly repos: readonly RepoName[],
    make: (repo: RepoName, isDefault: boolean) => G,
  ) {
    if (repos.length === 0) {
      throw new Error('RepoRouter needs at least the default repo');
    }
    repos.forEach((repo, index) => this.byKey.set(repoKey(repo.name), make(repo, index === 0)));
  }

  // No name, or the default repo's own name, is the default repo. A name
  // that isn't configured is null.
  route(name: string | null | undefined): G | null {
    const key = name ? repoKey(name) : repoKey(this.repos[0].name);
    return this.byKey.get(key) ?? null;
  }

  names(): string[] {
    return this.repos.map((repo) => repo.name);
  }
}

// Names no handle, like every other reply.
export function unknownRepoReply(name: string, known: readonly string[]): string {
  return `I only merge pull requests in ${known.join(', ')}, and ${name} isn't one of them.`;
}
