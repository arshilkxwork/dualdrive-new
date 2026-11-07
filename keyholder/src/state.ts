// Reading the state file's per-repo entries, which have had two shapes:
//
//   older:  repos["org/web"] = { "4": {headSha, reviewers, ...}, ... }
//   now:    repos["org/web"] = { approvals: {...}, verdicts: {...} }
//
// Pull request numbers are digits, so an entry with any other key is the
// newer shape. Reading the older one as the newer would find no approvals
// and the next save would write that emptiness over them.

import type { GateState } from './gate.ts';

export function restoreRepoState(entry: unknown): GateState {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { approvals: {}, verdicts: {} };
  }
  const fields = entry as Record<string, unknown>;
  if ('approvals' in fields || 'verdicts' in fields) {
    return {
      approvals: (fields.approvals as GateState['approvals'] | undefined) ?? {},
      verdicts: (fields.verdicts as GateState['verdicts'] | undefined) ?? {},
    };
  }
  const approvals = Object.fromEntries(Object.entries(fields).filter(([pr]) => /^\d+$/.test(pr))) as GateState['approvals'];
  return { approvals, verdicts: {} };
}
