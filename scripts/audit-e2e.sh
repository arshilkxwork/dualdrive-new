#!/usr/bin/env bash
# Runs audit/run.sh end to end, with Docker, against a throwaway copy of
# demo-service, the way @auditor does. Six pull requests:
#
#   1  adds a passing test                  tests pass, head_sha is its commit
#   2  adds a failing test                  tests fail
#   3  adds a test that calls the network   tests fail: the container has none
#   4  adds a lockfile and a .npmrc that    the stand-in registry sees no
#      sends an environment variable to a   request, and the audit still runs
#      stand-in registry as the token       against the real one
#   5  adds a failing test and a            tests still fail: the config is
#      .dualdrive.json whose test command   read from the default branch, not
#      is "true"                            from the pull request
#   6  on a second upstream whose default   the configured command runs
#      branch has a .dualdrive.json
#
# The upstreams are local bare repos with refs/pull/<n>/head, as GitHub has.
# The changed-files call still goes to GitHub, for GITHUB_REPOSITORY's pull
# requests 1 to 6, so that repo has to have them; only the reply's shape is
# checked here.
#
#   GITHUB_REPOSITORY=owner/repo bash scripts/audit-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY to a public repo that has pull requests 1 to 6}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/audit-e2e-XXXXXX")"
echo "working in $WORK"

# run.sh copied with nothing beside it, so a real .env in this checkout can't
# override the upstream below.
mkdir -p "$WORK/project"
cp -R "$ROOT/audit" "$WORK/project/audit"

git init -q --bare "$WORK/upstream.git"
# HEAD names the default branch, as on GitHub; run.sh reads .dualdrive.json
# from it.
git -C "$WORK/upstream.git" symbolic-ref HEAD refs/heads/main
SRC="$WORK/demo-service"
cp -R "$ROOT/demo-service" "$SRC"
git -C "$SRC" init -q
GIT=(git -C "$SRC" -c user.name=audit-e2e -c user.email=audit-e2e@example.invalid -c commit.gpgsign=false)
"${GIT[@]}" checkout -q -b main
"${GIT[@]}" add -A
"${GIT[@]}" commit -qm "demo-service"
"${GIT[@]}" push -q "$WORK/upstream.git" main

HEADS=()
open_pr() {
  "${GIT[@]}" checkout -q -B "pr-$1" main
}
push_pr() {
  "${GIT[@]}" add -A
  "${GIT[@]}" commit -qm "pull request $1"
  "${GIT[@]}" push -q "${2:-$WORK/upstream.git}" "HEAD:refs/pull/$1/head"
  HEADS[$1]="$("${GIT[@]}" rev-parse HEAD)"
}

open_pr 1
cat >"$SRC/test/e2e-pass.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('e2e: passes', () => assert.equal(1 + 1, 2));
EOF
push_pr 1

open_pr 2
cat >"$SRC/test/e2e-fail.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('e2e: fails', () => assert.equal(1 + 1, 3));
EOF
push_pr 2

open_pr 3
cat >"$SRC/test/e2e-network.test.js" <<'EOF'
import { test } from 'node:test';
test('e2e: calls the network', async () => {
  await fetch('https://example.com/');
});
EOF
push_pr 3

PORT=48731
open_pr 4
cat >"$SRC/package-lock.json" <<'EOF'
{
  "name": "demo-service",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "demo-service", "version": "0.1.0", "dependencies": { "left-pad": "1.3.0" } },
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"
    }
  }
}
EOF
cat >"$SRC/.npmrc" <<EOF
registry=http://127.0.0.1:$PORT/
//127.0.0.1:$PORT/:_authToken=\${AUDIT_E2E_PROBE}
EOF
push_pr 4

open_pr 5
cat >"$SRC/test/e2e-fail.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('e2e: fails', () => assert.equal(1 + 1, 3));
EOF
printf '{"image": "node:22", "test_command": "true"}\n' >"$SRC/.dualdrive.json"
push_pr 5

# A second upstream whose default branch names its own test command, and a
# pull request on it that adds a passing test.
git init -q --bare "$WORK/configured.git"
git -C "$WORK/configured.git" symbolic-ref HEAD refs/heads/main
"${GIT[@]}" checkout -q -B configured main
printf '{"image": "node:22", "test_command": "node --test && echo dualdrive-config-in-use"}\n' >"$SRC/.dualdrive.json"
"${GIT[@]}" add -A
"${GIT[@]}" commit -qm "configured"
"${GIT[@]}" push -q "$WORK/configured.git" HEAD:main
"${GIT[@]}" checkout -q -B pr-6 configured
cat >"$SRC/test/e2e-pass.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('e2e: passes', () => assert.equal(1 + 1, 2));
EOF
push_pr 6 "$WORK/configured.git"

# Stands in for a registry the pull request controls: logs every request.
HITS="$WORK/registry-hits.log"
: >"$HITS"
# shellcheck disable=SC2016 # the ${...} is JavaScript, for node
node -e '
  const [port, log] = process.argv.slice(1);
  require("node:http").createServer((req, res) => {
    require("node:fs").appendFileSync(log, `${req.method} ${req.url} ${req.headers.authorization ?? "-"}\n`);
    res.end("{}");
  }).listen(Number(port), "127.0.0.1");
' "$PORT" "$HITS" &
REGISTRY_PID=$!
trap 'kill "$REGISTRY_PID" 2>/dev/null || true' EXIT

for n in 1 2 3 4 5 6; do
  upstream="$WORK/upstream.git"
  if [ "$n" -eq 6 ]; then
    upstream="$WORK/configured.git"
  fi
  echo "auditing pull request $n"
  (cd "$WORK/project" && UPSTREAM_REPO_URL="file://$upstream" AUDIT_E2E_PROBE=e2e-probe-value \
    bash audit/run.sh "$n") >"$WORK/report-$n.json"
done

node - "$WORK" "${HEADS[1]}" "${HEADS[2]}" "${HEADS[3]}" "${HEADS[4]}" "${HEADS[5]}" "${HEADS[6]}" <<'EOF'
const { readFileSync } = require('node:fs');
const [work, ...heads] = process.argv.slice(2);
const report = (n) => JSON.parse(readFileSync(`${work}/report-${n}.json`, 'utf8'));
const failures = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

for (const n of [1, 2, 3, 4, 5, 6]) {
  const r = report(n);
  expect(r.pr === n, `#${n}: the report names pull request ${n}`);
  expect(r.repo === process.env.GITHUB_REPOSITORY, `#${n}: the report names the repo`);
  expect(r.head_sha === heads[n - 1], `#${n}: head_sha is the pull request's commit`);
  expect(Array.isArray(r.changedPaths), `#${n}: changedPaths came back from GitHub`);
  expect(Array.isArray(r.secrets?.findings), `#${n}: the secret scan ran`);
}
expect(report(1).tests.passed === true, '#1: a passing test passes');
expect(report(2).tests.passed === false && report(2).tests.fail >= 1, '#2: a failing test fails');
const network = report(3).tests;
expect(network.passed === false && /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH/.test(network.tail), '#3: the network is out of reach inside the test container');
expect(report(1).vulns.skipped === 'no package-lock.json', '#1: no lockfile, so no dependency audit');
expect(typeof report(4).vulns.total === 'number', '#4: the dependency audit ran against the real registry');
expect(report(4).tests.passed === true, '#4: its tests still pass');
expect(report(5).tests.passed === false && report(5).tests.fail >= 1, "#5: the pull request's own .dualdrive.json doesn't pick its test command");
expect(
  report(6).tests.passed === true && report(6).tests.tail.includes('dualdrive-config-in-use'),
  "#6: the default branch's .dualdrive.json picks the test command",
);

const hits = readFileSync(`${work}/registry-hits.log`, 'utf8').trim();
expect(hits === '', `#4: the pull request's registry saw no request${hits ? ` (got: ${hits})` : ''}`);

if (failures.length > 0) {
  process.exit(1);
}
EOF
