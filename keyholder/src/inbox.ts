// What a room message asks @keyholder to do. Kept apart from main.ts so it
// can be tested without a Switch connection.

import { senderMatches } from './config.ts';
import type { Reviewer } from './gate.ts';
import { opensWithMention, parseApproval, parseRevoke, parseVerdictTag, type ParsedVerdict } from './rules.ts';

export interface MessagePayload {
  message_id?: string;
  sender?: string;
  sender_name?: string;
  body?: string;
  addressed?: boolean;
}

export interface InboxConfig {
  handle: string;
  auditors: string[];
  reviewers: string[];
}

export type Action =
  | { kind: 'verdict'; verdict: ParsedVerdict }
  | { kind: 'approve'; pr: number; reviewer: Reviewer }
  | { kind: 'revoke'; pr: number; reviewer: Reviewer }
  | { kind: 'reply'; body: string };

// Neither reply names a handle with "@": that would address someone.
export const NOT_A_REVIEWER = "I only act on approvals from this room's named reviewers.";
export const USAGE =
  'I take two commands after mentioning me: "approve #<number>", and "revoke #<number>" to take your approval back.';

export function readMessage(payload: MessagePayload, live: boolean, config: InboxConfig): Action[] {
  const sender = payload.sender ?? '';
  const senderName = payload.sender_name ?? '';
  const body = payload.body ?? '';
  const actions: Action[] = [];

  // Verdicts count only from the auditor. A tag from anyone else, @builder
  // included, is ignored.
  if (senderMatches(config.auditors, sender, senderName)) {
    const verdict = parseVerdictTag(body);
    if (verdict) {
      actions.push({ kind: 'verdict', verdict });
    }
  }

  // Commands are acted on only as they happen, never replayed from history,
  // and only when Switch says the message addressed @keyholder: that is
  // where its addressing policy has already let the sender through.
  if (!live || payload.addressed !== true) {
    return actions;
  }

  const approve = parseApproval(body, config.handle);
  const revoke = parseRevoke(body, config.handle);
  const spokenTo = approve !== null || revoke !== null || opensWithMention(body, config.handle);
  if (!spokenTo) {
    // Mentioned in passing, e.g. "@builder please notify @keyholder to merge
    // PR #1". Answering would talk over the exchange it's part of.
    return actions;
  }
  // A backstop for a misconfigured addressing policy.
  if (!senderMatches(config.reviewers, sender, senderName)) {
    actions.push({ kind: 'reply', body: NOT_A_REVIEWER });
    return actions;
  }
  const reviewer = { key: sender || senderName, label: senderName || sender };
  if (approve !== null) {
    actions.push({ kind: 'approve', pr: approve, reviewer });
  } else if (revoke !== null) {
    actions.push({ kind: 'revoke', pr: revoke, reviewer });
  } else {
    actions.push({ kind: 'reply', body: USAGE });
  }
  return actions;
}
