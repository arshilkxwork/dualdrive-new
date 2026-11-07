#!/usr/bin/env bash
# Runs audit/run.sh end to end, with Docker, against a throwaway copy of
# demo-service, the way @auditor does. Ten pull requests:
#
#   1  adds a passing test that imports     tests pass: the whole checkout is
#      from a new lib/ folder               mounted, head_sha is its commit
#   2  adds a failing test                  tests fail
#   3  adds a test that calls the network   tests fail: the container has none
#   4  adds a lockfile and a .npmrc that    the stand-in registry sees no
#      sends an environment variable to a   request, and the audit still runs
#      stand-in registry as the token       against the real one
#   5  adds a failing test and a            tests still fail: the config is
#      .dualdrive.json whose test command   read from the default branch, not
#      is "true"                            from the pull request
#   6  on a second upstream whose default   the configured command runs, with
#      branch has a .dualdrive.json         the memory the file asks for
#   7  adds a requirements.txt pinning a    osv-scanner reports critical
#      vulnerable Django                    vulnerabilities
#   8  on a third upstream with neither     tests fail with a message saying
#      package.json nor .dualdrive.json     what to add
#   9  adds a test that never ends          stopped at a 15s time limit
#  10  adds client/package-lock.json with   osv-scanner reads the nested npm
#      a vulnerable minimist                lockfile
#
# Then three settings on this machine, on pull requests already audited:
# #7 with OSV_MODE=off (skipped, and the report says so), #7 with
# OSV_MODE=offline against a database downloaded here (found, with no
# network), and #4 with an npm registry nobody answers (reported as not
# run, never as zero vulnerabilities).
#
# Pull request 1 also adds 120 notes, so its changed files take two pages of
# the files API.
#
# The upstreams are local bare repos with refs/pull/<n>/head, as GitHub has.
# The changed-files call goes to a stand-in for GitHub's files API (through
# GITHUB_API_URL) that answers from the same git history, so nothing here
# depends on which repo, fork or pull requests the script runs from.
#
#   bash scripts/audit-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=e2e/demo-service

# This script runs docker itself too, not only through run.sh, so it needs
# the same lookup run.sh does when Docker Desktop's CLI isn't on PATH.
if ! command -v docker >/dev/null 2>&1; then
  for dir in "$HOME/.docker/bin" /Applications/Docker.app/Contents/Resources/bin /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$dir/docker" ]; then
      PATH="$dir:$PATH"
      break
    fi
  done
fi
command -v docker >/dev/null 2>&1 || { echo "audit-e2e.sh: can't find docker" >&2; exit 2; }

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
mkdir -p "$SRC/lib"
echo 'export const two = 1 + 1;' >"$SRC/lib/e2e-two.js"
cat >"$SRC/test/e2e-pass.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { two } from '../lib/e2e-two.js';
test('e2e: passes', () => assert.equal(two, 2));
EOF
mkdir -p "$SRC/notes"
for i in $(seq 1 120); do
  echo "note $i" >"$SRC/notes/note-$i.md"
done
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
cat >"$SRC/.dualdrive.json" <<'EOF'
{
  "image": "node:22",
  "test_command": "node --test && (cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes) && echo dualdrive-config-in-use",
  "memory": "768m",
  "pids": 128
}
EOF
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

open_pr 7
printf 'django==3.2.0\n' >"$SRC/requirements.txt"
push_pr 7

# A third upstream that is neither Node nor configured.
git init -q --bare "$WORK/plain.git"
git -C "$WORK/plain.git" symbolic-ref HEAD refs/heads/main
"${GIT[@]}" checkout -q --orphan plain
"${GIT[@]}" rm -rfq .
echo "# plain" >"$SRC/README.md"
"${GIT[@]}" add -A
"${GIT[@]}" commit -qm "plain"
"${GIT[@]}" push -q "$WORK/plain.git" HEAD:main
"${GIT[@]}" checkout -q -B pr-8 plain
printf 'print("hello")\n' >"$SRC/hello.py"
push_pr 8 "$WORK/plain.git"

open_pr 9
cat >"$SRC/test/e2e-hang.test.js" <<'EOF'
import { test } from 'node:test';
test('e2e: never ends', () => {
  for (;;) {}
});
EOF
push_pr 9

open_pr 10
mkdir -p "$SRC/client"
cat >"$SRC/client/package-lock.json" <<'EOF'
{
  "name": "client",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "client", "version": "0.1.0", "dependencies": { "minimist": "1.2.0" } },
    "node_modules/minimist": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.0.tgz"
    }
  }
}
EOF
push_pr 10

# GitHub's test merges, refs/pull/<n>/merge. #1's merges its own head, so the
# checks run on it. #2's merges #1's head, as a stale one would after a push,
# so the checks fall back to #2's head.
MERGES=()
make_merge() {
  "${GIT[@]}" checkout -q -B "merge-$1" main
  "${GIT[@]}" merge -q --no-ff --no-edit -m "Merge $2 into main" "$2"
  "${GIT[@]}" push -q "$WORK/upstream.git" "HEAD:refs/pull/$1/merge"
  MERGES[$1]="$("${GIT[@]}" rev-parse HEAD)"
}
make_merge 1 "${HEADS[1]}"
make_merge 2 "${HEADS[1]}"

# What GitHub's files API would list for each pull request: every path that
# differs from the branch it targets.
mkdir -p "$WORK/files"
for n in 1 2 3 4 5 6 7 8 9 10; do
  base=main
  if [ "$n" -eq 6 ]; then
    base=configured
  elif [ "$n" -eq 8 ]; then
    base=plain
  fi
  "${GIT[@]}" diff --name-only "$base" "${HEADS[$n]}" >"$WORK/files/$n.txt"
done

# Stands in for GitHub's files API, a page at a time, as GitHub pages it.
FILES_PORT=48732
# shellcheck disable=SC2016 # the ${...} is JavaScript, for node
node -e '
  const [port, dir, repo] = process.argv.slice(1);
  const fs = require("node:fs");
  require("node:http").createServer((req, res) => {
    const url = new URL(req.url, "http://stand-in");
    const found = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/);
    const list = found && found[1] === repo && fs.existsSync(`${dir}/${found[2]}.txt`)
      ? fs.readFileSync(`${dir}/${found[2]}.txt`, "utf8").split("\n").filter(Boolean)
      : null;
    if (!list) {
      res.writeHead(404).end("{\"message\":\"Not Found\"}");
      return;
    }
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    const files = list.slice((page - 1) * perPage, page * perPage).map((filename) => ({ filename, status: "modified" }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(files));
  }).listen(Number(port), "127.0.0.1");
' "$FILES_PORT" "$WORK/files" "$REPO" &
FILES_PID=$!

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
trap 'kill "$REGISTRY_PID" "$FILES_PID" 2>/dev/null || true' EXIT
sleep 1

for n in 1 2 3 4 5 6 7 8 9 10; do
  upstream="$WORK/upstream.git"
  test_limit=600
  if [ "$n" -eq 9 ]; then
    test_limit=15
  fi
  if [ "$n" -eq 6 ]; then
    upstream="$WORK/configured.git"
  elif [ "$n" -eq 8 ]; then
    upstream="$WORK/plain.git"
  fi
  echo "auditing pull request $n"
  (cd "$WORK/project" && UPSTREAM_REPO_URL="file://$upstream" GITHUB_REPOSITORY="$REPO" \
    GITHUB_API_URL="http://127.0.0.1:$FILES_PORT" AUDIT_GITHUB_TOKEN='' AUDIT_E2E_PROBE=e2e-probe-value \
    AUDIT_TEST_TIMEOUT="$test_limit" \
    bash audit/run.sh "$n") >"$WORK/report-$n.json"
done

# Settings on this machine, on pull requests already audited.
audit_again() {
  local n="$1" name="$2"
  shift 2
  echo "auditing pull request $n again ($name)"
  (cd "$WORK/project" && env UPSTREAM_REPO_URL="file://$WORK/upstream.git" GITHUB_REPOSITORY="$REPO" \
    GITHUB_API_URL="http://127.0.0.1:$FILES_PORT" AUDIT_GITHUB_TOKEN='' "$@" \
    bash audit/run.sh "$n") >"$WORK/report-$n-$name.json"
}
audit_again 7 osv-off OSV_MODE=off
# The databases offline mode reads, downloaded once for the ecosystems in a
# requirements.txt, as an operator would on a machine that can reach osv.dev.
mkdir -p "$WORK/osv-seed" "$WORK/osv-db"
printf 'django==3.2.0\n' >"$WORK/osv-seed/requirements.txt"
# Exit 1 here only means it found Django's vulnerabilities while downloading.
download=0
docker run --rm -e OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/db -v "$WORK/osv-db":/db -v "$WORK/osv-seed":/src:ro \
  ghcr.io/google/osv-scanner:v2.2.4 scan source --offline-vulnerabilities --download-offline-databases -r /src \
  >"$WORK/osv-download.log" 2>&1 || download=$?
if [ "$download" -gt 1 ]; then
  echo "downloading the osv databases failed (exit $download); see $WORK/osv-download.log"
fi
audit_again 7 osv-offline OSV_MODE=offline OSV_DB_DIR="$WORK/osv-db"
mkdir -p "$WORK/osv-db-empty"
audit_again 7 osv-no-db OSV_MODE=offline OSV_DB_DIR="$WORK/osv-db-empty"
audit_again 4 npm-down NPM_AUDIT_REGISTRY=https://127.0.0.1:9/

node - "$WORK" "$REPO" "${MERGES[1]}" "${HEADS[1]}" "${HEADS[2]}" "${HEADS[3]}" "${HEADS[4]}" "${HEADS[5]}" "${HEADS[6]}" "${HEADS[7]}" "${HEADS[8]}" "${HEADS[9]}" "${HEADS[10]}" <<'EOF'
const { readFileSync } = require('node:fs');
const [work, repo, merge1, ...heads] = process.argv.slice(2);
const report = (n) => JSON.parse(readFileSync(`${work}/report-${n}.json`, 'utf8'));
const failures = [];
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const r = report(n);
  expect(r.pr === n, `#${n}: the report names pull request ${n}`);
  expect(r.repo === repo, `#${n}: the report names the repo`);
  expect(r.head_sha === heads[n - 1], `#${n}: head_sha is the pull request's commit`);
  const want = readFileSync(`${work}/files/${n}.txt`, 'utf8').split('\n').filter(Boolean).sort();
  expect(
    JSON.stringify(r.changedPaths) === JSON.stringify(want),
    `#${n}: changedPaths lists the ${want.length} file${want.length === 1 ? '' : 's'} the pull request changes`,
  );
  expect(Array.isArray(r.secrets?.findings), `#${n}: the secret scan ran`);
}
expect(report(1).changedPaths.length > 100, '#1: changedPaths read both pages of the files API');
expect(
  report(1).tested?.ref === 'merge' && report(1).tested?.sha === merge1,
  "#1: the checks ran on GitHub's test merge, and head_sha is still the head",
);
expect(
  report(2).tested?.ref === 'head' && report(2).tested?.sha === heads[1],
  "#2: a test merge of some other head is ignored, and the head is checked",
);
expect(report(3).tested?.ref === 'head', '#3: no test merge, so the head is checked');
expect(report(1).tests.passed === true, '#1: a test importing from lib/ passes, so the whole checkout is mounted');
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
expect(
  report(6).tests.tail.includes(String(768 * 1024 * 1024)) && report(6).test_config?.memory_mb === 768,
  "#6: the container gets the 768m of memory the file asks for",
);

expect(report(1).osv?.skipped === 'no lockfile osv-scanner reads', '#1: no other lockfile, so osv-scanner is skipped');
const osv = report(7).osv;
expect(
  osv?.scanner === 'osv-scanner' && osv.critical >= 1 && osv.packages?.[0]?.name?.toLowerCase() === 'django',
  `#7: osv-scanner finds critical vulnerabilities in Django 3.2.0${osv?.error ? ` (got: ${osv.error})` : ''}`,
);
expect(
  report(8).tests.passed === false && /no package\.json/.test(report(8).tests.tail),
  '#8: a repo with no test setup fails with a message saying what to add',
);
expect(
  report(5).test_config?.mode === 'default' && report(5).proposed_test_config?.test_command === 'true',
  "#5: the report shows the test command the pull request proposes, and that it wasn't used",
);
expect(
  report(6).test_config?.mode === 'custom' && report(6).proposed_test_config === undefined,
  "#6: the default branch's config is reported, and nothing is proposed",
);

const hung = report(9).tests;
expect(
  hung.passed === false && hung.exit_code === 124 && /stopped after 15s/.test(hung.tail),
  '#9: a test that never ends is stopped at the time limit and fails',
);
const nested = report(10).osv;
expect(
  nested?.scanner === 'osv-scanner' && nested.total >= 1 && nested.packages?.[0]?.name === 'minimist',
  `#10: osv-scanner reads client/package-lock.json and finds minimist 1.2.0${nested?.error ? ` (got: ${nested.error})` : ''}`,
);
expect(report(10).vulns.skipped === 'no package-lock.json', '#10: npm audit still reads only the root lockfile');

const again = (name) => JSON.parse(readFileSync(`${work}/report-${name}.json`, 'utf8'));
expect(/OSV_MODE=off/.test(again('7-osv-off').osv?.skipped ?? ''), '#7 with OSV_MODE=off: skipped, and the report says why');
const offline = again('7-osv-offline').osv;
expect(
  offline?.scanner === 'osv-scanner' && offline.critical >= 1,
  `#7 with OSV_MODE=offline: Django's vulnerabilities found from the saved database, with no network${offline?.error ? ` (got: ${offline.error})` : ''}`,
);
const noDb = again('7-osv-no-db').osv;
expect(
  /no usable database in OSV_DB_DIR/.test(noDb?.error ?? ''),
  `#7 offline with an empty OSV_DB_DIR: the report says the database is missing${noDb?.error ? '' : ` (got: ${JSON.stringify(noDb)})`}`,
);
const npmDown = again('4-npm-down').vulns;
expect(
  typeof npmDown?.error === 'string' && npmDown.total === undefined,
  `#4 with an unreachable registry: npm audit is reported as not run, not as zero${npmDown?.error ? '' : ` (got: ${JSON.stringify(npmDown)})`}`,
);

const hits = readFileSync(`${work}/registry-hits.log`, 'utf8').trim();
expect(hits === '', `#4: the pull request's registry saw no request${hits ? ` (got: ${hits})` : ''}`);

if (failures.length > 0) {
  process.exit(1);
}
EOF
