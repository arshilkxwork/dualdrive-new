// Which repos one @keyholder governs, and which one a command or verdict
// means. GITHUB_REPOSITORY is the default: "#4" and a verdict with no "repo"
// are its pull requests. EXTRA_REPOSITORIES adds more, reached as
// "owner/repo#4". A repo on neither list is refused, whatever the token could
// reach.
//
// Each repo gets its own Gate, so approvals, verdicts and queues for
// org/a#1 and org/b#1 can't mix: they live in different objects.

import { isRepoName, normalizeSensitivePath, parseMergeMethod, parseRequireCi, type MergeMethod } from './rules.ts';

// One repo's own rules, where they differ from the global settings. Unset
// fields fall back to SENSITIVE_PATHS, BASE_BRANCH and REQUIRED_CHECKS.
export interface RepoSettings {
  baseBranch?: string;
  requiredChecks?: readonly string[];
  sensitivePaths?: readonly string[];
  mergeMethod?: MergeMethod;
  requireCi?: boolean;
}

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

// Reads REPO_SETTINGS, a JSON object keyed by owner/repo:
//
//   {"org/web": {"base_branch": "master", "required_checks": ["build"],
//                "sensitive_paths": ["src/session/", "package.json"],
//                "merge_method": "squash"}}
//
// Anything it can't use is refused, rather than leaving a repo on rules
// that were meant for another one: a repo that isn't configured, an unknown
// field, an empty list of sensitive paths.
export function parseRepoSettings(text: string | undefined, repos: readonly RepoName[]): Map<string, RepoSettings> {
  const settings = new Map<string, RepoSettings>();
  if (!text?.trim()) {
    return settings;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`REPO_SETTINGS is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('REPO_SETTINGS must be a JSON object keyed by owner/repo');
  }
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
  for (const [name, raw] of Object.entries(data)) {
    const key = repoKey(name);
    if (!repos.some((repo) => repoKey(repo.name) === key)) {
      throw new Error(`REPO_SETTINGS names ${name}, which isn't GITHUB_REPOSITORY or in EXTRA_REPOSITORIES`);
    }
    if (settings.has(key)) {
      throw new Error(`REPO_SETTINGS names ${name} twice`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`REPO_SETTINGS for ${name} must be an object`);
    }
    const fields = raw as Record<string, unknown>;
    const known = ['base_branch', 'required_checks', 'sensitive_paths', 'merge_method', 'require_ci'];
    const unknown = Object.keys(fields).filter((field) => !known.includes(field));
    if (unknown.length > 0) {
      throw new Error(`REPO_SETTINGS for ${name} has fields keyholder doesn't read: ${unknown.join(', ')}`);
    }
    const repo: RepoSettings = {};
    if (fields.base_branch !== undefined) {
      if (typeof fields.base_branch !== 'string' || !/^[^\s~^:?*[\\]+$/.test(fields.base_branch)) {
        throw new Error(`REPO_SETTINGS for ${name}: base_branch must be a branch name`);
      }
      repo.baseBranch = fields.base_branch;
    }
    if (fields.required_checks !== undefined) {
      if (!strings(fields.required_checks)) {
        throw new Error(`REPO_SETTINGS for ${name}: required_checks must be a list of check names`);
      }
      repo.requiredChecks = (fields.required_checks as string[]).map((check) => check.trim());
    }
    if (fields.sensitive_paths !== undefined) {
      if (!strings(fields.sensitive_paths) || (fields.sensitive_paths as string[]).length === 0) {
        throw new Error(
          `REPO_SETTINGS for ${name}: sensitive_paths must list at least one path ` +
            '(.github/, .env files and .dualdrive.json count without being listed)',
        );
      }
      repo.sensitivePaths = (fields.sensitive_paths as string[]).map((path) =>
        normalizeSensitivePath(path, `REPO_SETTINGS for ${name}: sensitive_paths`),
      );
    }
    if (fields.merge_method !== undefined) {
      repo.mergeMethod = parseMergeMethod(fields.merge_method, `REPO_SETTINGS for ${name}: merge_method`);
    }
    if (fields.require_ci !== undefined) {
      if (typeof fields.require_ci !== 'boolean') {
        throw new Error(`REPO_SETTINGS for ${name}: require_ci must be true or false`);
      }
      repo.requireCi = fields.require_ci;
    }
    settings.set(key, repo);
  }
  return settings;
}

// SENSITIVE_PATHS describes GITHUB_REPOSITORY. Another repo inheriting it
// would be protected by paths that may not exist in its codebase, so each
// extra repo has to name its own, and keyholder won't start until it does.
export function requireOwnSensitivePaths(repos: readonly RepoName[], settings: Map<string, RepoSettings>): void {
  const missing = repos.slice(1).filter((repo) => !settings.get(repoKey(repo.name))?.sensitivePaths);
  if (missing.length > 0) {
    throw new Error(
      `Set sensitive_paths in REPO_SETTINGS for ${missing.map((repo) => repo.name).join(', ')}: ` +
        'SENSITIVE_PATHS only describes GITHUB_REPOSITORY',
    );
  }
}

// Names no handle, like every other reply.
export function unknownRepoReply(name: string, known: readonly string[]): string {
  return `I only merge pull requests in ${known.join(', ')}, and ${name} isn't one of them.`;
}
