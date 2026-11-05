import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  auditorHandle: string;
  auditors: string[];
  reviewers: string[];
  githubToken: string;
  owner: string;
  repo: string;
  stateFile: string;
}

export function loadConfig(): Config {
  loadEnv();
  const [owner, repo, ...rest] = required('GITHUB_REPOSITORY').split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error('GITHUB_REPOSITORY must look like owner/repo');
  }
  return {
    bridgeUrl: required('SWITCH_BRIDGE_URL').replace(/\/+$/, ''),
    agentId: required('KEYHOLDER_AGENT_ID'),
    apiKey: required('KEYHOLDER_API_KEY'),
    roomId: required('DUALDRIVE_ROOM_ID'),
    handle: process.env.KEYHOLDER_HANDLE?.trim() || 'keyholder',
    auditorHandle: process.env.AUDITOR_HANDLE?.trim() || 'auditor',
    auditors: list('AUDITOR_SENDERS'),
    reviewers: list('REVIEWER_SENDERS'),
    githubToken: required('GITHUB_TOKEN'),
    owner,
    repo,
    stateFile: process.env.KEYHOLDER_STATE_FILE ?? resolve(keyholderDir, '.state.json'),
  };
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
