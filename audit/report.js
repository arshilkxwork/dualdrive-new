// Combines the files audit/run.sh wrote into the one JSON line @auditor reads.
//
//   node audit/report.js <out-dir> <pr-number> <head-sha> <test-exit-code> [owner/repo] [tested-ref tested-sha]
//
// `repo` is the repo the pull request is on. @auditor copies it into its
// verdict tag, so @keyholder knows which repo's #N the verdict is for.
// `tested` says what the checks ran on: "merge", GitHub's test merge of the
// head into the base branch, or "head" when there wasn't a current one.
// head_sha is the pull request's head either way; that is what a verdict
// pins.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntryPoint } from './entry.js';

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

// osv-scanner's JSON for lockfiles other than package-lock.json. Its exit
// code says what happened: 0 nothing found, 1 vulnerabilities, 128 no
// packages it could read. Severity is each vulnerability group's highest
// CVSS score: 7 and up is high, 9 and up critical, as npm counts them.
export function summarizeOsv(raw, exit) {
  if (exit === 'skipped') {
    return { skipped: 'no lockfile osv-scanner reads' };
  }
  if (exit === '128') {
    return { skipped: 'osv-scanner found no packages in the lockfiles' };
  }
  if (exit === '124') {
    return { error: 'osv-scanner was stopped at the time limit (AUDIT_SCAN_TIMEOUT)' };
  }
  if (exit === '125') {
    return { error: 'docker could not start osv-scanner (exit 125); is OSV_IMAGE reachable from this machine?' };
  }
  if ((exit !== '0' && exit !== '1') || raw === null) {
    return { error: `osv-scanner exited with ${exit}` };
  }
  let high = 0;
  let critical = 0;
  let total = 0;
  const packages = [];
  for (const result of raw.results ?? []) {
    for (const entry of result.packages ?? []) {
      const groups = entry.groups ?? [];
      total += groups.length;
      for (const group of groups) {
        const score = Number(group.max_severity);
        if (score >= 9) {
          critical += 1;
        } else if (score >= 7) {
          high += 1;
        }
      }
      if (groups.length > 0) {
        packages.push({
          name: entry.package?.name,
          version: entry.package?.version,
          ecosystem: entry.package?.ecosystem,
          vulnerabilities: groups.length,
        });
      }
    }
  }
  packages.sort((a, b) => b.vulnerabilities - a.vulnerabilities);
  return { scanner: 'osv-scanner', high, critical, total, packages: packages.slice(0, 10) };
}

// GitHub's files API stops at 3000 files.
export const GITHUB_FILES_LIMIT = 3000;

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

function readJsonIfThere(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

if (isEntryPoint(import.meta.url)) {
  const [outDir, pr, headSha, testExit, repo, testedRef, testedSha] = process.argv.slice(2);
  const files = readJson(join(outDir, 'files.json'));
  const report = {
    ...(repo ? { repo } : {}),
    pr: Number(pr),
    head_sha: headSha,
    ...(testedRef ? { tested: { ref: testedRef, sha: testedSha } } : {}),
    tests: summarizeTests(readFileSync(join(outDir, 'tests.log'), 'utf8'), Number(testExit)),
    secrets: readJson(join(outDir, 'secrets.json')),
    vulns: summarizeNpmAudit(readJson(join(outDir, 'npm-audit.json'))),
    ...(existsSync(join(outDir, 'osv-exit'))
      ? {
          osv: summarizeOsv(
            readJsonIfThere(join(outDir, 'osv.json')),
            readFileSync(join(outDir, 'osv-exit'), 'utf8').trim(),
          ),
        }
      : {}),
    ...(existsSync(join(outDir, 'config.json')) ? { test_config: readJson(join(outDir, 'config.json')) } : {}),
    ...(existsSync(join(outDir, 'proposed-config.json'))
      ? { proposed_test_config: readJson(join(outDir, 'proposed-config.json')) }
      : {}),
    changedPaths: changedPaths(files),
    ...(files.length >= GITHUB_FILES_LIMIT ? { changedPathsTruncated: true } : {}),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
