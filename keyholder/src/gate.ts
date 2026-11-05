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
  url: string;
}

export interface GitHubPort {
  getPull(pr: number): Promise<PullRequest>;
  listChangedPaths(pr: number): Promise<string[]>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  // Passes `sha` to GitHub, which refuses the merge if the head has moved.
  merge(pr: number, sha: string): Promise<{ sha: string }>;
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

export interface GateState {
  approvals: Record<string, { headSha: string; reviewers: string[] }>;
}

export interface GateOptions {
  ciPollMs: number;
  ciTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  onStateChange?: (state: GateState) => void;
}

const short = (sha: string) => sha.slice(0, 7);

export class Gate {
  private readonly verdicts = new Map<number, ParsedVerdict>();
  private readonly queues = new Map<number, Promise<void>>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly github: GitHubPort,
    private readonly room: RoomPort,
    private readonly state: GateState,
    private readonly options: GateOptions,
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // Called for every verdict tag the auditor posts, in the order posted. Only
  // the latest one for each pull request counts.
  recordVerdict(parsed: ParsedVerdict): void {
    const pr = parsed.kind === 'valid' ? parsed.verdict.pr : parsed.pr;
    this.verdicts.set(pr, parsed);
  }

  // Approvals for the same pull request are handled one at a time, in order.
  handleApproval(pr: number, reviewer: Reviewer): Promise<void> {
    const previous = this.queues.get(pr) ?? Promise.resolve();
    const next = previous.then(() => this.approve(pr, reviewer));
    this.queues.set(pr, next.catch(() => {}));
    return next;
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
          ? `${reviewer.label}'s approval for #${pr} is recorded, but something failed after that: ${describe(error)}`
          : `I couldn't check #${pr} on GitHub, so nothing was counted: ${describe(error)}`,
      );
    }
  }

  private async evaluate(pr: number, reviewer: Reviewer): Promise<void> {
    const pull = await this.github.getPull(pr);
    if (pull.merged) {
      await this.room.post(`#${pr} is already merged.`);
      return;
    }
    if (pull.state !== 'open') {
      await this.room.post(`#${pr} is closed, so there's nothing to approve.`);
      return;
    }

    const verdict = this.verdicts.get(pr);
    if (!verdict) {
      await this.room.post(`No audit verdict yet for #${pr}. Waiting for the auditor; this approval wasn't counted.`);
      return;
    }
    if (verdict.kind === 'malformed') {
      if (verdict.headSha === null || verdict.headSha === pull.headSha) {
        await this.room.post(
          `The auditor's latest verdict for #${pr} can't be read (${verdict.reason}). ` +
            `Treating #${pr} as CRITICAL: nothing merges until a valid verdict for ${short(pull.headSha)} is posted.`,
        );
        await this.room.record(`#${pr} ${short(pull.headSha)}: unreadable verdict, treated as CRITICAL`);
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
    const floor = floorRisk(paths);
    const risk = higherRisk(verdict.verdict.risk, floor);
    const required = requiredApprovals(risk);
    if (!Number.isFinite(required)) {
      await this.room.post(
        `#${pr} is rated CRITICAL at ${short(pull.headSha)}. DualDrive won't merge it; ` +
          `push a fix and ask the auditor for a new verdict.`,
      );
      return;
    }
    let ratedAs = `rated ${risk}`;
    if (risk !== verdict.verdict.risk) {
      const reason = paths.find(isSensitivePath);
      ratedAs = `rated ${verdict.verdict.risk} by the auditor, raised to ${risk} because it changes ${reason}`;
    }

    let approvals: GateState['approvals'][string] | undefined = this.state.approvals[pr];
    if (approvals && approvals.headSha !== pull.headSha) {
      await this.room.post(`#${pr} has new commits since its earlier approvals, so the count starts again.`);
      approvals = undefined;
    }
    approvals ??= { headSha: pull.headSha, reviewers: [] };
    this.state.approvals[pr] = approvals;

    if (approvals.reviewers.includes(reviewer.key)) {
      await this.room.post(
        `Already counted ${reviewer.label}'s approval for #${pr} (${approvals.reviewers.length} of ${required}).`,
      );
    } else {
      approvals.reviewers.push(reviewer.key);
      this.saveState();
      await this.room.post(
        `Approval from ${reviewer.label} recorded for #${pr} (${approvals.reviewers.length} of ${required}, ${ratedAs}).`,
      );
      await this.room.record(`#${pr} ${short(pull.headSha)}: approved by ${reviewer.label} (${ratedAs})`);
    }

    if (approvals.reviewers.length >= required) {
      await this.merge(pr, pull.headSha, approvals.reviewers.length, required);
    }
  }

  private async postStale(pr: number): Promise<void> {
    await this.room.post(
      `The audit for #${pr} is stale: the pull request has moved since the auditor's verdict. ` +
        `Waiting for a fresh audit before this approval counts.`,
    );
  }

  // Runs only once the approvals are saved, so every failure here leaves them
  // standing. Approving again retries.
  private async merge(pr: number, approvedSha: string, count: number, required: number): Promise<void> {
    let current: PullRequest;
    let ci: CiState;
    try {
      current = await this.github.getPull(pr);
      if (current.headSha !== approvedSha) {
        delete this.state.approvals[pr];
        this.saveState();
        await this.room.post(`#${pr} moved to ${short(current.headSha)} just before merging, so its approvals were reset.`);
        return;
      }
      ci = await this.waitForCi(pr, approvedSha, count, required);
    } catch (error) {
      await this.room.post(
        `The approvals for #${pr} stand (${count} of ${required}), but checking it on GitHub before merging failed: ` +
          `${describe(error)}. Approve again to retry.`,
      );
      return;
    }

    if (ci === 'failed') {
      await this.room.post(`CI failed on ${short(approvedSha)}, so #${pr} isn't being merged.`);
      await this.room.record(`#${pr} ${short(approvedSha)}: not merged, CI failed`);
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

    try {
      const result = await this.github.merge(pr, approvedSha);
      delete this.state.approvals[pr];
      this.saveState();
      await this.room.post(`Merged #${pr} as ${short(result.sha)}: ${current.url}`);
      await this.room.record(`#${pr} ${short(approvedSha)}: merged as ${result.sha}`);
    } catch (error) {
      await this.room.post(`GitHub refused to merge #${pr}: ${describe(error)}`);
      await this.room.record(`#${pr} ${short(approvedSha)}: merge refused by GitHub`);
    }
  }

  private async waitForCi(pr: number, sha: string, count: number, required: number): Promise<CiState> {
    let ci = ciState(await this.github.listCheckRuns(sha));
    if (ci === 'pending') {
      await this.room.post(`Approvals recorded (${count} of ${required}). Waiting for CI to finish before merging #${pr}.`);
      const polls = Math.ceil(this.options.ciTimeoutMs / this.options.ciPollMs);
      for (let i = 0; i < polls && ci === 'pending'; i++) {
        await this.sleep(this.options.ciPollMs);
        ci = ciState(await this.github.listCheckRuns(sha));
      }
    }
    return ci;
  }

  private saveState(): void {
    this.options.onStateChange?.(this.state);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
