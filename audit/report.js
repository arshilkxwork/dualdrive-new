// Combines the files audit/run.sh wrote into the one JSON line @auditor reads.
//
//   node audit/report.js <out-dir> <pr-number> <head-sha> <test-exit-code>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeTests(log, exitCode) {
  const count = (label) => {
    const found = log.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return found ? Number(found[1]) : null;
  };
  return {
    passed: exitCode === 0,
    exit_code: exitCode,
    pass: count('pass'),
    fail: count('fail'),
    tail: log.trimEnd().split('\n').slice(-20).join('\n'),
  };
}

export function summarizeNpmAudit(raw) {
  if (raw.skipped) {
    return { skipped: raw.skipped };
  }
  const counts = raw.metadata?.vulnerabilities ?? {};
  return {
    high: counts.high ?? 0,
    critical: counts.critical ?? 0,
    total: counts.total ?? 0,
  };
}

export function changedPaths(files) {
  const paths = new Set();
  for (const file of files) {
    paths.add(file.filename);
    if (file.previous_filename) {
      paths.add(file.previous_filename);
    }
  }
  return [...paths].sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outDir, pr, headSha, testExit] = process.argv.slice(2);
  const report = {
    pr: Number(pr),
    head_sha: headSha,
    tests: summarizeTests(readFileSync(join(outDir, 'tests.log'), 'utf8'), Number(testExit)),
    secrets: readJson(join(outDir, 'secrets.json')),
    vulns: summarizeNpmAudit(readJson(join(outDir, 'npm-audit.json'))),
    changedPaths: changedPaths(readJson(join(outDir, 'files.json'))),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
