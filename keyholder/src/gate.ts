// The merge gate's decisions. GitHub and the room are passed in, so the
// whole flow can be tested without either.

import {
  ciState,
  floorRisk,
  higherRisk,
  isSensitivePath,
  requiredApprovals,
  type CheckRun,
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
  auditorHandle: string;
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

  private get auditor(): string {
    return `@${this.options.auditorHandle}`;
  }

  private async approve(pr: number, reviewer: Reviewer): Promise<void> {
    try {
      await this.evaluate(pr, reviewer);
    } catch (error) {
      await this.room.post(`I couldn't check #${pr} on GitHub, so nothing was counted: ${describe(error)}`);
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
      await this.room.post(`No audit verdict yet for #${pr}. Waiting for ${this.auditor}; this approval wasn't counted.`);
      return;
    }
    if (verdict.kind === 'malformed') {
      if (verdict.headSha === null || verdict.headSha === pull.headSha) {
        await this.room.post(
          `${this.auditor}'s latest verdict for #${pr} can't be read (${verdict.reason}). ` +
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
          `push a fix and ask ${this.auditor} for a new verdict.`,
      );
      return;
    }
    let ratedAs = `rated ${risk}`;
    if (risk !== verdict.verdict.risk) {
      const reason = paths.find(isSensitivePath);
      ratedAs = `rated ${verdict.verdict.risk} by ${this.auditor}, raised to ${risk} because it changes ${reason}`;
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
      `The audit for #${pr} is stale: the pull request has moved since ${this.auditor}'s verdict. ` +
        `Waiting for a fresh audit before this approval counts.`,
    );
  }

  private async merge(pr: number, approvedSha: string, count: number, required: number): Promise<void> {
    const current = await this.github.getPull(pr);
    if (current.headSha !== approvedSha) {
      delete this.state.approvals[pr];
      this.saveState();
      await this.room.post(`#${pr} moved to ${short(current.headSha)} just before merging, so its approvals were reset.`);
      return;
    }

    let ci = ciState(await this.github.listCheckRuns(approvedSha));
    if (ci === 'pending') {
      await this.room.post(`Approvals recorded (${count} of ${required}). Waiting for CI to finish before merging #${pr}.`);
      const polls = Math.ceil(this.options.ciTimeoutMs / this.options.ciPollMs);
      for (let i = 0; i < polls && ci === 'pending'; i++) {
        await this.sleep(this.options.ciPollMs);
        ci = ciState(await this.github.listCheckRuns(approvedSha));
      }
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

  private saveState(): void {
    this.options.onStateChange?.(this.state);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
