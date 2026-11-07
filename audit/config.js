// Reads the optional .dualdrive.json that tells audit/run.sh how to run a
// repo's tests: which container image, and which command inside it.
//
//   { "image": "python:3.12-slim", "test_command": "pytest -q" }
//
// run.sh reads this file from the upstream's default branch, never from the
// pull request: a pull request that could choose its own test command could
// set it to "true" and pass. A change to the file is a sensitive path for
// @keyholder, so it needs two approvals before it lands.
//
//   node audit/config.js [path]          prints the image, the command and the
//                                        mode, one per line; no path or no file
//                                        means the demo-service defaults
//   node audit/config.js --json [path]   the same as one JSON object, or
//                                        {"error": ...} for a file it refuses,
//                                        for the report; always exits 0

import { existsSync, readFileSync } from 'node:fs';
import { isEntryPoint } from './entry.js';

// What run.sh did before the file existed, so a repo without one is audited
// as before: Node 22 and `node --test`.
export const DEFAULT_AUDIT_CONFIG = Object.freeze({ image: 'node:22', testCommand: 'node --test', mode: 'default' });

// A Docker reference: registry/name:tag or name@sha256:digest. It can't start
// with "-", which docker would read as a flag.
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/;
const KNOWN_KEYS = new Set(['image', 'test_command']);

export function parseAuditConfig(text) {
  let data;
  try {
    // Some editors save JSON with a byte order mark, which JSON.parse refuses.
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`.dualdrive.json is not valid JSON: ${error.message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('.dualdrive.json must be a JSON object');
  }
  // Refused rather than ignored: whoever wrote it would think it counted.
  // The floor is keyholder's, set in its own .env where no agent can reach.
  if ('sensitive_paths' in data) {
    throw new Error('.dualdrive.json can\'t set sensitive_paths; set SENSITIVE_PATHS in keyholder\'s .env instead');
  }
  const unknown = Object.keys(data).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`.dualdrive.json has keys run.sh doesn't read: ${unknown.join(', ')}`);
  }
  const { image, test_command: testCommand } = data;
  if (typeof image !== 'string' || !IMAGE.test(image)) {
    throw new Error('.dualdrive.json "image" must be a container image name such as "python:3.12-slim"');
  }
  if (typeof testCommand !== 'string' || testCommand.trim() === '' || testCommand.length > 1000) {
    throw new Error('.dualdrive.json "test_command" must be a non-empty string of at most 1000 characters');
  }
  // run.sh reads the result line by line.
  if (/[\r\n\0]/.test(testCommand)) {
    throw new Error('.dualdrive.json "test_command" must be one line; chain steps with && instead');
  }
  return { image, testCommand, mode: 'custom' };
}

export function loadAuditConfig(path) {
  if (!path || !existsSync(path)) {
    return DEFAULT_AUDIT_CONFIG;
  }
  return parseAuditConfig(readFileSync(path, 'utf8'));
}

if (isEntryPoint(import.meta.url)) {
  const json = process.argv[2] === '--json';
  const path = process.argv[json ? 3 : 2];
  try {
    const config = loadAuditConfig(path);
    process.stdout.write(
      json
        ? `${JSON.stringify({ image: config.image, test_command: config.testCommand, mode: config.mode })}\n`
        : `${config.image}\n${config.testCommand}\n${config.mode}\n`,
    );
  } catch (error) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    } else {
      console.error(`audit/run.sh: ${error.message}`);
      process.exit(2);
    }
  }
}
