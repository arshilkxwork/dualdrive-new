import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDir, scanText, isEnvFile } from '../secrets.js';
import { summarizeTests, summarizeNpmAudit, changedPaths } from '../report.js';

test('scanText flags a hard-coded token and redacts it', () => {
  // Assembled at runtime so this repo doesn't trip its own scanner.
  const findings = scanText(`const token = '${'abcd'}${'1234efgh5678'}';`, 'src/x.js');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'hardcoded-credential');
  assert.equal(findings[0].line, 1);
  assert.ok(!findings[0].match.includes('1234'));
});

test('scanText leaves ordinary code alone', () => {
  assert.deepEqual(scanText("addUser('alice', 'correct horse battery staple');", 'test/a.js'), []);
});

test('scanDir finds a committed .env and skips .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'dualdrive-secrets-'));
  try {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'token = "ghp_' + 'a'.repeat(36) + '"');
    writeFileSync(join(root, '.env'), 'X=1\n');
    writeFileSync(join(root, 'ok.js'), 'export const n = 1;\n');
    const findings = scanDir(root);
    assert.deepEqual(findings.map((f) => f.rule), ['committed-env-file']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isEnvFile allows .env.example', () => {
  assert.equal(isEnvFile('.env'), true);
  assert.equal(isEnvFile('.env.local'), true);
  assert.equal(isEnvFile('.env.example'), false);
});

test('summarizeTests reads the TAP counts', () => {
  const summary = summarizeTests('ok 1 - a\n# pass 5\n# fail 1\n', 1);
  assert.equal(summary.passed, false);
  assert.equal(summary.pass, 5);
  assert.equal(summary.fail, 1);
});

test('summarizeNpmAudit passes a skip through', () => {
  assert.deepEqual(summarizeNpmAudit({ skipped: 'no package-lock.json' }), { skipped: 'no package-lock.json' });
  assert.deepEqual(
    summarizeNpmAudit({ metadata: { vulnerabilities: { high: 2, critical: 0, total: 3 } } }),
    { high: 2, critical: 0, total: 3 },
  );
});

test('changedPaths includes the old name of a renamed file', () => {
  const paths = changedPaths([
    { filename: 'src/login.js', previous_filename: 'src/auth.js' },
    { filename: 'test/auth.test.js' },
  ]);
  assert.deepEqual(paths, ['src/auth.js', 'src/login.js', 'test/auth.test.js']);
});
