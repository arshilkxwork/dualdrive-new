// The merge gate's decisions. GitHub and the room are passed in, so the
// whole flow can be tested without either.
//
// Nothing posted here contains an @handle. A mention from @keyholder would
// address that participant: the auditor would be woken for nothing, and a
// mention of @keyholder itself would be refused by Switch on its behalf.

import {
  ciState,
  floorRisk,
  higherRisk,
  isSensitivePath,
  requiredApprovals,
  type CheckRun,
  type CiState,
  type ParsedVerdict,
} from './rules.ts';

export interface PullRequest {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  // The branch it would merge into. Its author can change this at any time
  // without moving the head.
  baseRef: string;
  title: string;
  url: string;
}

export interface GitHubPort {
  getPull(pr: number): Promise<PullRequest>;
  listChangedPaths(pr: number): Promise<string[]>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  // Passes `sha` to GitHub, which refuses the merge if the head has moved.
  // `message` becomes the body of the merge commit.
  merge(pr: number, sha: string, message: string): Promise<{ sha: string }>;
}

export interface RoomPort {
  post(body: string): Promise<void>;
  // Appends a line to the ledger document. Failures are the port's to absorb.
  record(line: string): Promise<void>;
}

export interface Reviewer {
  key: string;
  label: string;
}

export interface Approvals {
  headSha: string;
  reviewers: string[];
  // Display names by reviewer key, for the merge commit. Missing in state
  // files written before it existed, so readers fall back to the key.
  labels?: Record<string, string>;
}

export interface GateState {
  approvals: Record<string, Approvals>;
  // The latest verdict for each pull request, saved so a restart doesn't
  // depend on the verdict still being in the room history it re-reads.
  // Missing in state files written before it existed.
  verdicts?: Record<string, ParsedVerdict>;
}

export interface GateOptions {
  // Replaces DEFAULT_SENSITIVE_PATHS in the floor check when given.
  sensitivePaths?: readonly string[];
  // The only branch the gate merges into. Defaults to main.
  baseBranch?: string;
  // Check runs that must exist and pass before a merge, by name.
  requiredChecks?: readonly string[];
  ciPollMs: number;
  ciTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  onStateChange?: (state: GateState) => void;
  // How messages name this gate's repo, as in "owner/repo#4". Unset for the
  // default repo, whose pull requests are plain "#4".
  repoLabel?: string;
}

const short = (sha: string) => sha.slice(0, 7);

// Verdicts kept in the state file. Past this, the lowest pull request
// numbers go first; a pull request that loses its verdict this way just
// needs a fresh audit.
export const MAX_SAVED_VERDICTS = 500;

export class Gate {
  private readonly verdicts = new Map<number, ParsedVerdict>();
  private readonly queues = new Map<number, Promise<void>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseBranch: string;

  constructor(
    private readonly github: GitHubPort,
    private readonly room: RoomPort,
    private readonly state: GateState,
    private readonly options: GateOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseBranch = options.baseBranch ?? 'main';
    for (const [pr, verdict] of Object.entries(state.verdicts ?? {})) {
      this.verdicts.set(Number(pr), verdict);
    }
  }

  // Called for every verdict tag the auditor posts, in the order posted. Only
  // the latest one for each pull request counts. Replaying the room's history
  // after a restart keeps that order: anything still in the history is newer
  // than a saved verdict that has dropped out of it.
  recordVerdict(parsed: ParsedVerdict): void {
    const pr = parsed.kind === 'valid' ? parsed.verdict.pr : parsed.pr;
    this.verdicts.set(pr, parsed);
    const saved = this.state.verdicts?.[pr];
    if (!saved || JSON.stringify(saved) !== JSON.stringify(parsed)) {
      this.state.verdicts = { ...this.state.verdicts, [pr]: parsed };
      const numbers = Object.keys(this.state.verdicts)
        .map(Number)
        .sort((a, b) => a - b);
      for (const old of numbers.slice(0, Math.max(0, numbers.length - MAX_SAVED_VERDICTS))) {
        delete this.state.verdicts[old];
        this.verdicts.delete(old);
      }
      this.saveState();
    }
  }

  // Drops what the gate kept for a pull request that is merged or closed. A
  // closed one that is reopened starts again from a fresh verdict and fresh
  // approvals.
  private forget(pr: number): void {
    const had = pr in this.state.approvals || pr in (this.state.verdicts ?? {});
    this.verdicts.delete(pr);
    delete this.state.approvals[pr];
    delete this.state.verdicts?.[pr];
    if (had) {
      this.saveState();
    }
  }

  // Approvals for the same pull request are handled one at a time, in order.
  handleApproval(pr: number, reviewer: Reviewer): Promise<void> {
    const previous = this.queues.get(pr) ?? Promise.resolve();
    const next = previous.then(() => this.approve(pr, reviewer));
    this.queues.set(pr, next.catch(() => {}));
    return next;
  }

  // A revocation isn't queued behind approvals. It changes the saved
  // approvals straight away, so one sent while a merge waits for CI still
  // counts: merge() reads the approvals again before it calls GitHub.
  async handleRevoke(pr: number, reviewer: Reviewer): Promise<void> {
    const approvals = this.state.approvals[pr];
    if (!approvals?.reviewers.includes(reviewer.key)) {
      await this.room.post(`${reviewer.label} hasn't approved ${this.ref(pr)}, so there's nothing to take back.`);
      return;
    }
    approvals.reviewers = approvals.reviewers.filter((key) => key !== reviewer.key);
    delete approvals.labels?.[reviewer.key];
    if (approvals.reviewers.length === 0) {
      delete this.state.approvals[pr];
    }
    this.saveState();
    const left = approvals.reviewers.length;
    await this.room.post(
      `Took back ${reviewer.label}'s approval for ${this.ref(pr)}. ${left === 1 ? '1 approval is' : `${left} approvals are`} left.`,
    );
    await this.room.record(`${this.ref(pr)} ${short(approvals.headSha)}: approval withdrawn by ${reviewer.label}`);
  }

  private async approve(pr: number, reviewer: Reviewer): Promise<void> {
    try {
      await this.evaluate(pr, reviewer);
    } catch (error) {
      // Say whether the approval was saved: the failure can come before or
      // after it was counted.
      const counted = this.state.approvals[pr]?.reviewers.includes(reviewer.key) ?? false;
      await this.room.post(
        counted
          ? `${reviewer.label}'s approval for ${this.ref(pr)} is recorded, but something failed after that: ${describe(error)}`
          : `I couldn't check ${this.ref(pr)} on GitHub, so nothing was counted: ${describe(error)}`,
      );
    }
  }

  private async evaluate(pr: number, reviewer: Reviewer): Promise<void> {
    const pull = await this.github.getPull(pr);
    if (pull.merged) {
      this.forget(pr);
      await this.room.post(`${this.ref(pr)} is already merged.`);
      return;
    }
    if (pull.state !== 'open') {
      this.forget(pr);
      await this.room.post(`${this.ref(pr)} is closed, so there's nothing to approve.`);
      return;
    }
    if (pull.baseRef !== this.baseBranch) {
      await this.postWrongBase(pr, pull.baseRef, 'this approval wasn\'t counted');
      return;
    }

    const verdict = this.verdicts.get(pr);
    if (!verdict) {
      await this.room.post(`No audit verdict yet for ${this.ref(pr)}. Waiting for the auditor; this approval wasn't counted.`);
      return;
    }
    if (verdict.kind === 'malformed') {
      if (verdict.headSha === null || verdict.headSha === pull.headSha) {
        await this.room.post(
          `The auditor's latest verdict for ${this.ref(pr)} can't be read (${verdict.reason}). ` +
            `Treating ${this.ref(pr)} as CRITICAL: nothing merges until a valid verdict for ${short(pull.headSha)} is posted.`,
        );
        await this.room.record(`${this.ref(pr)} ${short(pull.headSha)}: unreadable verdict, treated as CRITICAL`);
        return;
      }
      await this.postStale(pr);
      return;
    }
    if (verdict.verdict.headSha !== pull.headSha) {
      await this.postStale(pr);
      return;
    }

    const paths = await this.github.listChangedPaths(pr);
    const floor = floorRisk(paths, this.options.sensitivePaths);
    const risk = higherRisk(verdict.verdict.risk, floor);
    const required = requiredApprovals(risk);
    if (!Number.isFinite(required)) {
      await this.room.post(
        `${this.ref(pr)} is rated CRITICAL at ${short(pull.headSha)}. DualDrive won't merge it; ` +
          `push a fix and ask the auditor for a new verdict.`,
      );
      return;
    }
    let ratedAs = `rated ${risk}`;
    if (risk !== verdict.verdict.risk) {
      const reason = paths.find((path) => isSensitivePath(path, this.options.sensitivePaths));
      ratedAs = `rated ${verdict.verdict.risk} by the auditor, raised to ${risk} because it changes ${reason}`;
    }

    let approvals: Approvals | undefined = this.state.approvals[pr];
    if (approvals && approvals.headSha !== pull.headSha) {
      await this.room.post(`${this.ref(pr)} has new commits since its earlier approvals, so the count starts again.`);
      approvals = undefined;
    }
    approvals ??= { headSha: pull.headSha, reviewers: [], labels: {} };
    this.state.approvals[pr] = approvals;

    if (approvals.reviewers.includes(reviewer.key)) {
      await this.room.post(
        `Already counted ${reviewer.label}'s approval for ${this.ref(pr)} (${approvals.reviewers.length} of ${required}).`,
      );
    } else {
      approvals.reviewers.push(reviewer.key);
      approvals.labels = { ...approvals.labels, [reviewer.key]: reviewer.label };
      this.saveState();
      await this.room.post(
        `Approval from ${reviewer.label} recorded for ${this.ref(pr)} (${approvals.reviewers.length} of ${required}, ${ratedAs}).`,
      );
      await this.room.record(`${this.ref(pr)} ${short(pull.headSha)}: approved by ${reviewer.label} (${ratedAs})`);
    }

    if (approvals.reviewers.length >= required) {
      await this.merge(pr, pull.headSha, required, ratedAs);
    }
  }

  private async postStale(pr: number): Promise<void> {
    await this.room.post(
      `The audit for ${this.ref(pr)} is stale: the pull request has moved since the auditor's verdict. ` +
        `Waiting for a fresh audit before this approval counts.`,
    );
  }

  private async postWrongBase(pr: number, baseRef: string, outcome: string): Promise<void> {
    await this.room.post(`${this.ref(pr)} targets ${baseRef}, and DualDrive only merges into ${this.baseBranch}, so ${outcome}.`);
    await this.room.record(`${this.ref(pr)}: targets ${baseRef}, not ${this.baseBranch}; ${outcome}`);
  }

  // Runs only once the approvals are saved, so every failure here leaves them
  // standing. Approving again retries.
  private async merge(pr: number, approvedSha: string, required: number, ratedAs: string): Promise<void> {
    let current: PullRequest;
    let ci: CiState;
    try {
      current = await this.github.getPull(pr);
      if (!(await this.stillTheSame(pr, current, approvedSha))) {
        return;
      }
      ci = await this.waitForCi(pr, approvedSha, this.state.approvals[pr]?.reviewers.length ?? 0, required);
      // The wait can take a while, and the author can retarget the pull
      // request without moving its head, which the sha passed to GitHub
      // wouldn't catch. Look once more.
      if (ci === 'passed') {
        current = await this.github.getPull(pr);
        if (!(await this.stillTheSame(pr, current, approvedSha))) {
          return;
        }
      }
    } catch (error) {
      const count = this.state.approvals[pr]?.reviewers.length ?? 0;
      await this.room.post(
        `The approvals for ${this.ref(pr)} stand (${count} of ${required}), but checking it on GitHub before merging failed: ` +
          `${describe(error)}. Approve again to retry.`,
      );
      return;
    }

    if (ci === 'failed') {
      await this.room.post(`CI failed on ${short(approvedSha)}, so ${this.ref(pr)} isn't being merged.`);
      await this.room.record(`${this.ref(pr)} ${short(approvedSha)}: not merged, CI failed`);
      return;
    }
    if (ci === 'pending') {
      const seconds = Math.round(this.options.ciTimeoutMs / 1000);
      await this.room.post(
        `CI still hasn't finished on ${short(approvedSha)} after ${seconds} seconds. ` +
          `The approvals stand; approve again once it's green and I'll retry the merge.`,
      );
      return;
    }

    // A reviewer may have taken an approval back while CI ran.
    const approvals = this.state.approvals[pr];
    const count = approvals?.headSha === approvedSha ? approvals.reviewers.length : 0;
    if (!approvals || count < required) {
      await this.room.post(`An approval for ${this.ref(pr)} was taken back while CI ran (${count} of ${required}), so it isn't being merged.`);
      return;
    }

    try {
      const result = await this.github.merge(pr, approvedSha, mergeMessage(current, approvals, ratedAs));
      // Merged, so neither will be read again.
      this.forget(pr);
      await this.room.post(`Merged ${this.ref(pr)} as ${short(result.sha)}: ${current.url}`);
      await this.room.record(`${this.ref(pr)} ${short(approvedSha)}: merged as ${result.sha}`);
    } catch (error) {
      await this.room.post(`GitHub refused to merge ${this.ref(pr)}: ${describe(error)}`);
      await this.room.record(`${this.ref(pr)} ${short(approvedSha)}: merge refused by GitHub`);
    }
  }

  // False, after saying why, when the pull request no longer has the approved
  // head or no longer targets the base branch.
  private async stillTheSame(pr: number, current: PullRequest, approvedSha: string): Promise<boolean> {
    if (current.headSha !== approvedSha) {
      delete this.state.approvals[pr];
      this.saveState();
      await this.room.post(`${this.ref(pr)} moved to ${short(current.headSha)} just before merging, so its approvals were reset.`);
      return false;
    }
    if (current.baseRef !== this.baseBranch) {
      await this.postWrongBase(pr, current.baseRef, "it isn't being merged");
      return false;
    }
    return true;
  }

  private async waitForCi(pr: number, sha: string, count: number, required: number): Promise<CiState> {
    const checks = this.options.requiredChecks ?? [];
    let ci = ciState(await this.github.listCheckRuns(sha), checks);
    if (ci === 'pending') {
      await this.room.post(`Approvals recorded (${count} of ${required}). Waiting for CI to finish before merging ${this.ref(pr)}.`);
      const polls = Math.ceil(this.options.ciTimeoutMs / this.options.ciPollMs);
      for (let i = 0; i < polls && ci === 'pending'; i++) {
        await this.sleep(this.options.ciPollMs);
        ci = ciState(await this.github.listCheckRuns(sha), checks);
      }
    }
    return ci;
  }

  private ref(pr: number): string {
    return this.options.repoLabel ? `${this.options.repoLabel}#${pr}` : `#${pr}`;
  }

  private saveState(): void {
    this.options.onStateChange?.(this.state);
  }
}

// The merge commit's body: the pull request's title, then trailers naming
// who approved which commit, so the record survives in git history even if
// the ledger document is deleted. `git log --format=%(trailers)` reads them.
export function mergeMessage(pull: PullRequest, approvals: Approvals, ratedAs: string): string {
  const trailers = approvals.reviewers.map((key) => `Approved-by: ${approvals.labels?.[key] ?? key}`);
  trailers.push(`Approved-commit: ${approvals.headSha}`, `Risk: ${ratedAs}`);
  return `${pull.title}\n\n${trailers.join('\n')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
