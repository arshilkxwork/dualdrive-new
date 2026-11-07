import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepoSettings, parseRepositories, requireOwnSensitivePaths, type RepoName, type RepoSettings } from './repos.ts';
import { parseCiTimeoutMs, parseMergeMethod, parseRequiredChecks, parseSensitivePaths, type MergeMethod } from './rules.ts';

const keyholderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The same .env audit/run.sh reads, at the project root.
export function loadEnv(): void {
  const path = process.env.DUALDRIVE_ENV ?? resolve(keyholderDir, '..', '.env');
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name} in .env`);
  }
  return value;
}

function list(name: string): string[] {
  return required(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface Config {
  bridgeUrl: string;
  agentId: string;
  apiKey: string;
  roomId: string;
  handle: string;
  auditors: string[];
  reviewers: string[];
  sensitivePaths: readonly string[];
  baseBranch: string;
  requiredChecks: readonly string[];
  ciTimeoutMs: number;
  githubToken: string;
  // Unset means api.github.com, or GITHUB_SERVER_URL's /api/v3.
  githubApiUrl: string | undefined;
  mergeMethod: MergeMethod;
  owner: string;
  repo: string;
  // GITHUB_REPOSITORY first, then EXTRA_REPOSITORIES.
  repositories: RepoName[];
  // REPO_SETTINGS, by lowercase owner/repo.
  repoSettings: Map<string, RepoSettings>;
  stateFile: string;
}

export function loadConfig(): Config {
  loadEnv();
  const repositories = parseRepositories(required('GITHUB_REPOSITORY'), process.env.EXTRA_REPOSITORIES);
  const { owner, repo } = repositories[0];
  const repoSettings = parseRepoSettings(process.env.REPO_SETTINGS, repositories);
  requireOwnSensitivePaths(repositories, repoSettings);
  return {
    bridgeUrl: required('SWITCH_BRIDGE_URL').replace(/\/+$/, ''),
    agentId: required('KEYHOLDER_AGENT_ID'),
    apiKey: required('KEYHOLDER_API_KEY'),
    roomId: required('DUALDRIVE_ROOM_ID'),
    handle: process.env.KEYHOLDER_HANDLE?.trim() || 'keyholder',
    auditors: list('AUDITOR_SENDERS'),
    reviewers: list('REVIEWER_SENDERS'),
    sensitivePaths: parseSensitivePaths(process.env.SENSITIVE_PATHS),
    baseBranch: process.env.BASE_BRANCH?.trim() || 'main',
    requiredChecks: parseRequiredChecks(process.env.REQUIRED_CHECKS),
    ciTimeoutMs: parseCiTimeoutMs(process.env.CI_TIMEOUT_MS),
    githubToken: required('GITHUB_TOKEN'),
    githubApiUrl: githubApiUrl(process.env.GITHUB_API_URL, process.env.GITHUB_SERVER_URL),
    mergeMethod: parseMergeMethod(process.env.MERGE_METHOD?.trim(), 'MERGE_METHOD'),
    owner,
    repo,
    repositories,
    repoSettings,
    stateFile: process.env.KEYHOLDER_STATE_FILE ?? resolve(keyholderDir, '.state.json'),
  };
}

// GitHub Enterprise Server serves its API under /api/v3 of its own address,
// so setting GITHUB_SERVER_URL alone is enough; GITHUB_API_URL still wins.
// audit/run.sh works out the same address the same way.
export function githubApiUrl(apiUrl: string | undefined, serverUrl: string | undefined): string | undefined {
  const api = apiUrl?.trim().replace(/\/+$/, '');
  if (api) {
    return api;
  }
  const server = serverUrl?.trim().replace(/\/+$/, '');
  return server && server !== 'https://github.com' ? `${server}/api/v3` : undefined;
}

// A sender matches an entry by its participant id ("@switch-user-…:server"),
// which is exact, or by its display name, case-insensitively.
export function senderMatches(entries: string[], sender: string, senderName: string): boolean {
  return entries.some((entry) =>
    entry.startsWith('@') && entry.includes(':')
      ? entry === sender
      : entry.toLowerCase() === senderName.toLowerCase(),
  );
}
