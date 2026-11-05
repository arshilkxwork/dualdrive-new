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

// "@keyholder approve #12", "@keyholder: approve 12", "@keyholder approve PR 12 - lgtm".
export function parseApproval(body: string, handle: string): number | null {
  const pattern = new RegExp(`@${escapeRegExp(handle)}:?\\s+approve\\s+(?:pr\\s*)?#?(\\d+)`, 'i');
  const found = body.match(pattern);
  return found ? Number(found[1]) : null;
}

// Paths that raise a pull request to at least HIGH whatever the auditor says.
// src/auth.js is matched by name: a prefix check on "src/auth/" alone misses it.
export function isSensitivePath(path: string): boolean {
  return (
    path === 'src/auth.js' ||
    path.startsWith('src/auth/') ||
    path === 'package.json' ||
    path === 'package-lock.json' ||
    path.startsWith('.github/') ||
    /(^|\/)\.env/i.test(path)
  );
}

export function floorRisk(paths: string[]): Risk {
  return paths.some(isSensitivePath) ? 'HIGH' : 'LOW';
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
