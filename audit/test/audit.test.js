import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDir, scanText, isEnvFile } from '../secrets.js';
import { summarizeTests, summarizeNpmAudit, changedPaths } from '../report.js';
import { DEFAULT_AUDIT_CONFIG, loadAuditConfig, parseAuditConfig } from '../config.js';

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
  assert.equal(isEnvFile('.envrc'), true);
  assert.equal(isEnvFile('.environment'), false);
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

test('the scripts still run when called through a symlinked path', () => {
  const auditDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const root = mkdtempSync(join(tmpdir(), 'dualdrive-link-'));
  try {
    const linked = join(root, 'audit');
    symlinkSync(auditDir, linked);
    const scanned = execFileSync(process.execPath, [join(linked, 'secrets.js'), join(root, 'audit', 'test')], {
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(scanned).scanner, 'builtin');

    const out = join(root, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'tests.log'), '# pass 1\n# fail 0\n');
    writeFileSync(join(out, 'secrets.json'), '{"scanner":"builtin","findings":[]}');
    writeFileSync(join(out, 'npm-audit.json'), '{"skipped":"no package-lock.json"}');
    writeFileSync(join(out, 'files.json'), '[{"filename":"src/auth.js"}]');
    const report = execFileSync(process.execPath, [join(linked, 'report.js'), out, '4', 'a'.repeat(40), '0'], {
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(report).changedPaths, ['src/auth.js']);
    assert.equal(JSON.parse(report).repo, undefined);

    const withRepo = execFileSync(
      process.execPath,
      [join(linked, 'report.js'), out, '4', 'a'.repeat(40), '0', 'org/repo-b'],
      { encoding: 'utf8' },
    );
    assert.equal(JSON.parse(withRepo).repo, 'org/repo-b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.dualdrive.json picks the image and test command', () => {
  assert.deepEqual(parseAuditConfig('{"image": "python:3.12-slim", "test_command": "pytest -q"}'), {
    image: 'python:3.12-slim',
    testCommand: 'pytest -q',
    mode: 'custom',
  });
  assert.equal(
    parseAuditConfig('{"image": "ghcr.io/org/go@sha256:abc123", "test_command": "go test ./... && go vet ./..."}').image,
    'ghcr.io/org/go@sha256:abc123',
  );
});

test('.dualdrive.json is refused when it is wrong, never half-read', () => {
  const refused = {
    'not json': /not valid JSON/,
    '[]': /JSON object/,
    '{"test_command": "pytest"}': /"image"/,
    '{"image": "--privileged", "test_command": "pytest"}': /"image"/,
    '{"image": "python:3.12", "test_command": ""}': /"test_command"/,
    '{"image": "python:3.12", "test_command": "pytest\\nrm -rf /"}': /one line/,
    '{"image": "python:3.12", "test_command": "pytest", "sensitive_paths": ["src/"]}': /SENSITIVE_PATHS/,
    '{"image": "python:3.12", "test_command": "pytest", "network": true}': /network/,
  };
  for (const [text, reason] of Object.entries(refused)) {
    assert.throws(() => parseAuditConfig(text), reason, text);
  }
});

test('no .dualdrive.json means the demo-service defaults', () => {
  assert.deepEqual(loadAuditConfig(undefined), DEFAULT_AUDIT_CONFIG);
  assert.deepEqual(loadAuditConfig(join(tmpdir(), 'dualdrive-no-such-config.json')), DEFAULT_AUDIT_CONFIG);
  assert.deepEqual(DEFAULT_AUDIT_CONFIG, { image: 'node:22', testCommand: 'node --test', mode: 'default' });
});

test('config.js prints one setting per line for run.sh, and exits 2 on a bad file', () => {
  const auditDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const root = mkdtempSync(join(tmpdir(), 'dualdrive-config-'));
  try {
    const good = join(root, 'good.json');
    writeFileSync(good, '{"image": "rust:1.82", "test_command": "cargo test --offline"}');
    const out = execFileSync(process.execPath, [join(auditDir, 'config.js'), good], { encoding: 'utf8' });
    assert.equal(out, 'rust:1.82\ncargo test --offline\ncustom\n');
    assert.equal(
      execFileSync(process.execPath, [join(auditDir, 'config.js'), join(root, 'missing.json')], { encoding: 'utf8' }),
      'node:22\nnode --test\ndefault\n',
    );
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{"image": "-it"}');
    assert.throws(
      () => execFileSync(process.execPath, [join(auditDir, 'config.js'), bad], { stdio: 'pipe' }),
      (error) => error.status === 2 && /"image"/.test(String(error.stderr)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
