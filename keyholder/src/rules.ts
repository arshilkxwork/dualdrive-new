// The parts of the merge gate that are plain functions of their input:
// reading commands and verdict tags out of message text, and working out how
// many approvals a pull request needs.

export const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Risk = (typeof RISKS)[number];

export interface Verdict {
  pr: number;
  risk: Risk;
  headSha: string;
  cwe: string[];
  // "owner/repo", for a pull request outside GITHUB_REPOSITORY. Absent means
  // GITHUB_REPOSITORY.
  repo?: string;
}

export type ParsedVerdict =
  | { kind: 'valid'; verdict: Verdict }
  // The tag is there but unusable. `pr`, `headSha` and `repo` are whatever
  // could be recovered from the raw text, so the gate can still tie it to a
  // commit.
  | { kind: 'malformed'; pr: number; headSha: string | null; reason: string; repo?: string };

// GitHub's own character sets: an owner is letters, digits and hyphens; a
// repo name adds dots and underscores.
const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isRepoName(text: string): boolean {
  return REPO_NAME.test(text);
}

const VERDICT_TAG = /<!--\s*DUALDRIVE_VERDICT:\s*([\s\S]*?)\s*-->/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function parseVerdictTag(body: string): ParsedVerdict | null {
  const tag = body.match(VERDICT_TAG);
  if (!tag) {
    return null;
  }
  const raw = tag[1];
  const prMatch = raw.match(/"pr"\s*:\s*(\d+)/);
  if (!prMatch) {
    return null;
  }
  const pr = Number(prMatch[1]);
  const shaMatch = raw.match(/"head_sha"\s*:\s*"([0-9a-fA-F]+)"/);
  const headSha = shaMatch ? shaMatch[1].toLowerCase() : null;
  const repoMatch = raw.match(/"repo"\s*:\s*"([^"]*)"/);
  const rawRepo = repoMatch?.[1];
  const malformed = (reason: string): ParsedVerdict =>
    rawRepo === undefined ? { kind: 'malformed', pr, headSha, reason } : { kind: 'malformed', pr, headSha, reason, repo: rawRepo };

  // The auditor's own tag opens its message. One further in is something it
  // quoted, such as a tag @builder planted in a pull request description, so
  // it can't stand as a verdict. Malformed rather than ignored, so it can't
  // leave an older, laxer verdict for the same commit in place either.
  if (body.slice(0, tag.index).trim() !== '') {
    return malformed('the tag does not open the message');
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return malformed('the tag is not valid JSON');
  }
  if (typeof data !== 'object' || data === null) {
    return malformed('the tag is not a JSON object');
  }
  const fields = data as Record<string, unknown>;
  if (!Number.isInteger(fields.pr)) {
    return malformed('"pr" is not an integer');
  }
  if (typeof fields.risk !== 'string' || !(RISKS as readonly string[]).includes(fields.risk)) {
    return malformed('"risk" is not one of LOW, MEDIUM, HIGH, CRITICAL');
  }
  if (typeof fields.head_sha !== 'string' || !FULL_SHA.test(fields.head_sha.toLowerCase())) {
    return malformed('"head_sha" is not a full 40-character commit hash');
  }
  const cwe = fields.cwe ?? [];
  if (!Array.isArray(cwe) || !cwe.every((item) => typeof item === 'string')) {
    return malformed('"cwe" is not a list of strings');
  }
  if (fields.repo !== undefined && (typeof fields.repo !== 'string' || !isRepoName(fields.repo))) {
    return malformed('"repo" is not an owner/repo name');
  }
  const verdict: Verdict = {
    pr: fields.pr as number,
    risk: fields.risk as Risk,
    headSha: fields.head_sha.toLowerCase(),
    cwe: cwe as string[],
  };
  if (typeof fields.repo === 'string') {
    verdict.repo = fields.repo;
  }
  return { kind: 'valid', verdict };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when the message opens by mentioning `handle`, as in "@keyholder ...".
// A message that only mentions it further in, like "@builder ask
// @keyholder to merge", is talking about it rather than to it.
export function opensWithMention(body: string, handle: string): boolean {
  return new RegExp(`^\\s*@${escapeRegExp(handle)}(?![\\w-])`, 'i').test(body);
}

// What a command points at: a pull request number, and the repo when the
// command named one ("owner/repo#12"). No repo means GITHUB_REPOSITORY.
export interface CommandTarget {
  repo: string | null;
  pr: number;
}

// "@keyholder approve #12", "@keyholder: approve 12", "@keyholder, approve 12", "@keyholder approve PR 12 - lgtm",
// and "@keyholder approve owner/repo#12" for another repo.
// The command has to open the message. Anywhere else it is being talked
// about or quoted ("don't let @keyholder approve #1 yet", "> @keyholder
// approve #1"), and counting that would approve on the reviewer's behalf.
export function parseApprovalTarget(body: string, handle: string): CommandTarget | null {
  return parseCommand(body, handle, 'approve');
}

// "@keyholder revoke #12" or "@keyholder revoke owner/repo#12": a reviewer
// takes back their own approval. Same shape and the same rule about opening
// the message.
export function parseRevokeTarget(body: string, handle: string): CommandTarget | null {
  return parseCommand(body, handle, 'revoke');
}

// The number alone, for a command that names no repo. Kept for callers that
// only know GITHUB_REPOSITORY.
export function parseApproval(body: string, handle: string): number | null {
  const target = parseApprovalTarget(body, handle);
  return target && target.repo === null ? target.pr : null;
}

export function parseRevoke(body: string, handle: string): number | null {
  const target = parseRevokeTarget(body, handle);
  return target && target.repo === null ? target.pr : null;
}

function parseCommand(body: string, handle: string, verb: string): CommandTarget | null {
  const pattern = new RegExp(
    `^\\s*@${escapeRegExp(handle)}(?:\\s*[:,]\\s*|\\s+)${verb}\\s+(?:pr\\s*)?(?:([A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+)#|#?)(\\d+)(?!\\w)`,
    'i',
  );
  const found = body.match(pattern);
  if (!found) {
    return null;
  }
  const repo = found[1] ?? null;
  if (repo !== null && !isRepoName(repo)) {
    return null;
  }
  return { repo, pr: Number(found[2]) };
}

// demo-service's own sensitive paths. SENSITIVE_PATHS replaces this list for
// a repo laid out differently. An entry covers that exact path and, whether
// or not it ends in "/", everything under it: "src/auth" and "src/auth/"
// both cover src/auth/login.ts, and neither covers src/authority.js. So
// src/auth.js is listed by name because "src/auth/" alone would miss it.
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = ['src/auth.js', 'src/auth/', 'package.json', 'package-lock.json'];

// Paths that raise a pull request to at least HIGH whatever the auditor says.
// CI config and env files count in every repo, so no setting can drop them,
// and so does .dualdrive.json, which decides how audit/run.sh tests the repo.
export function isSensitivePath(path: string, projectPaths: readonly string[] = DEFAULT_SENSITIVE_PATHS): boolean {
  return (
    path.startsWith('.github/') ||
    path === '.dualdrive.json' ||
    // .env, .env.local and the like, and direnv's .envrc; not .environment.
    /(^|\/)\.env(rc)?(\.|\/|$)/i.test(path) ||
    projectPaths.some((entry) => {
      const folder = entry.endsWith('/') ? entry : `${entry}/`;
      return path === entry || path.startsWith(folder);
    })
  );
}

export function floorRisk(paths: string[], projectPaths: readonly string[] = DEFAULT_SENSITIVE_PATHS): Risk {
  return paths.some((path) => isSensitivePath(path, projectPaths)) ? 'HIGH' : 'LOW';
}

// Reads a comma-separated SENSITIVE_PATHS value. Unset or empty means the
// defaults; a leading "./" or "/" is dropped, since GitHub reports paths
// relative to the repo root.
export function parseSensitivePaths(value: string | undefined): readonly string[] {
  const entries = (value ?? '')
    .split(',')
    .filter((entry) => entry.trim() !== '')
    .map((entry) => normalizeSensitivePath(entry, 'SENSITIVE_PATHS'));
  return entries.length > 0 ? entries : DEFAULT_SENSITIVE_PATHS;
}

// One sensitive path entry, relative to the repo root. An entry that would
// match nothing is refused rather than kept as a silent no-op: "/" or "./"
// (the root, which no changed path equals), and glob patterns, which are
// matched as literal text.
export function normalizeSensitivePath(entry: string, setting: string): string {
  const path = entry.trim().replace(/^\.?\/+/, '');
  if (path === '' || path === '.') {
    throw new Error(`${setting}: "${entry.trim()}" names the repo root, which no changed file matches; list folders or files`);
  }
  if (/[*?[\]{}]/.test(path)) {
    throw new Error(`${setting}: "${path}" looks like a glob pattern; list folders (src/auth/) or files, which match literally`);
  }
  return path;
}

// GitHub's pull request files API lists at most this many files. Past it,
// a sensitive file could be in the part nobody sees.
export const GITHUB_FILES_LIMIT = 3000;

// The latest status per context. The Statuses API returns every status ever
// posted for the commit, newest first, so a context that went from pending
// to success appears twice.
export function latestStatuses<T extends { context: string }>(statuses: readonly T[]): T[] {
  const seen = new Set<string>();
  return statuses.filter((status) => !seen.has(status.context) && seen.add(status.context));
}

// REQUIRE_CI, or a repo's require_ci: false for a repo with no CI, which
// would otherwise wait out the timeout on every merge and never merge.
export function parseRequireCi(value: unknown, setting: string): boolean {
  if (value === undefined || value === '' || value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`${setting} must be true or false; got ${JSON.stringify(value)}`);
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

// MERGE_METHOD, or a repo's merge_method: how GitHub merges, which has to be
// one the repo allows. With rebase GitHub keeps the pull request's own
// commits, so the Approved-by trailers exist only in the ledger.
export function parseMergeMethod(value: unknown, setting: string): MergeMethod {
  if (value === undefined || value === '') {
    return 'merge';
  }
  if (value === 'merge' || value === 'squash' || value === 'rebase') {
    return value;
  }
  throw new Error(`${setting} must be merge, squash or rebase; got ${JSON.stringify(value)}`);
}

export function higherRisk(a: Risk, b: Risk): Risk {
  return RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b;
}

// Infinity means the gate never merges it.
export function requiredApprovals(risk: Risk): number {
  switch (risk) {
    case 'LOW':
    case 'MEDIUM':
      return 1;
    case 'HIGH':
      return 2;
    case 'CRITICAL':
      return Infinity;
  }
}

export interface CheckRun {
  // GitHub always sends it; REQUIRED_CHECKS matches on it.
  name?: string;
  status: string;
  conclusion: string | null;
}

export type CiState = 'pending' | 'passed' | 'failed';

// An empty list means GitHub hasn't registered the workflow yet. It is not a
// pass, and [].every(...) would say it was, unless `requireCi` is false: a
// repo set up with no CI at all, where nothing will ever register. Required
// checks are still waited for either way. For the same reason a required
// check with no run yet is pending, even when every other run is green: it
// may simply not have registered. Any failed run fails, required or not.
export function ciState(runs: CheckRun[], requiredChecks: readonly string[] = [], requireCi = true): CiState {
  if (runs.length === 0) {
    return requireCi || requiredChecks.length > 0 ? 'pending' : 'passed';
  }
  const finished = runs.filter((run) => run.status === 'completed');
  const passing = new Set(['success', 'neutral', 'skipped']);
  if (finished.some((run) => !passing.has(run.conclusion ?? ''))) {
    return 'failed';
  }
  if (requiredChecks.some((name) => !runs.some((run) => run.name === name))) {
    return 'pending';
  }
  return finished.length === runs.length ? 'passed' : 'pending';
}

// A commit status (the older Statuses API that Jenkins, CircleCI and others
// report through) as a check run, so ciState weighs both the same way.
// "error" fails like "failure"; anything unknown is still pending.
export function statusAsCheckRun(status: { context: string; state: string }): CheckRun {
  switch (status.state) {
    case 'success':
      return { name: status.context, status: 'completed', conclusion: 'success' };
    case 'failure':
    case 'error':
      return { name: status.context, status: 'completed', conclusion: 'failure' };
    default:
      return { name: status.context, status: 'in_progress', conclusion: null };
  }
}

// Reads a comma-separated REQUIRED_CHECKS value. Unset or empty means none,
// which keeps the older behaviour: every run that exists has to pass.
export function parseRequiredChecks(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

// Reads CI_TIMEOUT_MS: how long a merge waits for check runs to finish.
// Unset or empty means two minutes, which covers a cold runner booting its
// container. Anything that isn't a whole number of milliseconds of at least
// one second is refused rather than guessed at.
export const DEFAULT_CI_TIMEOUT_MS = 120_000;

export function parseCiTimeoutMs(value: string | undefined): number {
  const text = (value ?? '').trim();
  if (text === '') {
    return DEFAULT_CI_TIMEOUT_MS;
  }
  const ms = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1000) {
    throw new Error(`CI_TIMEOUT_MS must be a whole number of milliseconds, at least 1000; got "${text}"`);
  }
  return ms;
}
