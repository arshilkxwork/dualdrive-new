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
}

export type ParsedVerdict =
  | { kind: 'valid'; verdict: Verdict }
  // The tag is there but unusable. `pr` and `headSha` are whatever could be
  // recovered from the raw text, so the gate can still tie it to a commit.
  | { kind: 'malformed'; pr: number; headSha: string | null; reason: string };

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
  const malformed = (reason: string): ParsedVerdict => ({ kind: 'malformed', pr, headSha, reason });

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
  return {
    kind: 'valid',
    verdict: {
      pr: fields.pr as number,
      risk: fields.risk as Risk,
      headSha: fields.head_sha.toLowerCase(),
      cwe: cwe as string[],
    },
  };
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

// "@keyholder approve #12", "@keyholder: approve 12", "@keyholder approve PR 12 - lgtm".
// The command has to open the message. Anywhere else it is being talked
// about or quoted ("don't let @keyholder approve #1 yet", "> @keyholder
// approve #1"), and counting that would approve on the reviewer's behalf.
export function parseApproval(body: string, handle: string): number | null {
  const pattern = new RegExp(`^\\s*@${escapeRegExp(handle)}:?\\s+approve\\s+(?:pr\\s*)?#?(\\d+)(?!\\w)`, 'i');
  const found = body.match(pattern);
  return found ? Number(found[1]) : null;
}

// demo-service's own sensitive paths. SENSITIVE_PATHS replaces this list for
// a repo laid out differently. An entry ending in "/" covers everything
// under that folder; any other entry is one file, so src/auth.js is listed
// by name because "src/auth/" alone would miss it.
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = ['src/auth.js', 'src/auth/', 'package.json', 'package-lock.json'];

// Paths that raise a pull request to at least HIGH whatever the auditor says.
// CI config and env files count in every repo, so no setting can drop them.
export function isSensitivePath(path: string, projectPaths: readonly string[] = DEFAULT_SENSITIVE_PATHS): boolean {
  return (
    path.startsWith('.github/') ||
    // .env, .env.local and the like, and direnv's .envrc; not .environment.
    /(^|\/)\.env(rc)?(\.|\/|$)/i.test(path) ||
    projectPaths.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
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
    .map((entry) => entry.trim().replace(/^\.?\/+/, ''))
    .filter(Boolean);
  return entries.length > 0 ? entries : DEFAULT_SENSITIVE_PATHS;
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
  status: string;
  conclusion: string | null;
}

export type CiState = 'pending' | 'passed' | 'failed';

// An empty list means GitHub hasn't registered the workflow yet. It is not a
// pass, and [].every(...) would say it was.
export function ciState(runs: CheckRun[]): CiState {
  if (runs.length === 0) {
    return 'pending';
  }
  const finished = runs.filter((run) => run.status === 'completed');
  const passing = new Set(['success', 'neutral', 'skipped']);
  if (finished.some((run) => !passing.has(run.conclusion ?? ''))) {
    return 'failed';
  }
  return finished.length === runs.length ? 'passed' : 'pending';
}
