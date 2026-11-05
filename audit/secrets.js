// Secret scanner used by audit/run.sh when gitleaks isn't installed. Walks a
// directory, prints {"scanner", "findings": [{file, line, rule, match}]} as
// JSON. Matches are redacted to their first four characters.
//
//   node audit/secrets.js <dir>
//   node audit/secrets.js --from-gitleaks <gitleaks-report.json> <dir>

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export const RULES = [
  { rule: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { rule: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { rule: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  {
    rule: 'hardcoded-credential',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
];

export function scanText(text, file) {
  const findings = [];
  text.split('\n').forEach((lineText, index) => {
    for (const { rule, pattern } of RULES) {
      const found = lineText.match(pattern);
      if (found) {
        findings.push({ file, line: index + 1, rule, match: redact(found[0]) });
      }
    }
  });
  return findings;
}

export function scanDir(root) {
  const findings = [];
  for (const path of walk(root)) {
    const file = relative(root, path);
    if (isEnvFile(basename(path))) {
      findings.push({ file, line: 0, rule: 'committed-env-file', match: '' });
    }
    if (statSync(path).size > MAX_FILE_BYTES) {
      continue;
    }
    const text = readFileSync(path, 'utf8');
    if (text.includes('\u0000')) {
      continue;
    }
    findings.push(...scanText(text, file));
  }
  return findings;
}

export function isEnvFile(name) {
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(path);
      }
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function redact(value) {
  return value.length <= 4 ? '****' : `${value.slice(0, 4)}****`;
}

function fromGitleaks(reportPath, root) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = [];
  }
  return report.map((leak) => ({
    file: relative(root, leak.File ?? ''),
    line: leak.StartLine ?? 0,
    rule: leak.RuleID ?? 'gitleaks',
    match: '****',
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let output;
  if (args[0] === '--from-gitleaks') {
    const [, reportPath, root] = args;
    const envFiles = [...walk(root)]
      .filter((path) => isEnvFile(basename(path)))
      .map((path) => ({ file: relative(root, path), line: 0, rule: 'committed-env-file', match: '' }));
    output = { scanner: 'gitleaks', findings: [...fromGitleaks(reportPath, root), ...envFiles] };
  } else {
    output = { scanner: 'builtin', findings: scanDir(args[0]) };
  }
  process.stdout.write(JSON.stringify(output));
}
