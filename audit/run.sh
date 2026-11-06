#!/usr/bin/env bash
# Deterministic checks for one pull request on demo-service: the tests in a
# container with no network, a secret scan, a dependency audit, and the list
# of changed files. Prints one JSON line for @auditor to read.
#
# Usage: audit/run.sh <pr-number>
set -euo pipefail

die() { echo "audit/run.sh: $*" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for candidate in "$SCRIPT_DIR/../.env" ".env"; do
  if [ -f "$candidate" ]; then
    # @auditor runs this script as your user, so it can read any file the
    # script reads. keyholder's merge token and Switch key must not be in it.
    if grep -qE '^[[:space:]]*(export[[:space:]]+)?(GITHUB_TOKEN|KEYHOLDER_API_KEY|SWITCH_REGISTRATION_TOKEN)=[^[:space:]#]' "$candidate"; then
      die "$candidate holds keyholder's secrets, which the agents can read. Move them to keyholder's own .env (README, setup step 4)."
    fi
    set -a; source "$candidate"; set +a
    break
  fi
done

PR_NUM="${1:-}"
[[ "$PR_NUM" =~ ^[0-9]+$ ]] || die "usage: audit/run.sh <pr-number>"
: "${UPSTREAM_REPO_URL:?Set UPSTREAM_REPO_URL in .env — don't guess it from the local checkout, this script doesn't run from inside demo-service}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY=owner/repo in .env}"

# An agent may run this without your shell's startup files, and so without the
# PATH entries Docker Desktop and nvm add there. Look in their usual places
# before giving up.
find_tool() {
  local name="$1" dir
  shift
  command -v "$name" >/dev/null 2>&1 && return 0
  for dir in "$@"; do
    if [ -n "$dir" ] && [ -x "$dir/$name" ]; then
      PATH="$dir:$PATH"
      return 0
    fi
  done
  die "can't find $name. Put it on the PATH of whatever runs this script."
}
newest_nvm_bin() {
  ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1
}
for tool in git curl; do
  find_tool "$tool" /usr/bin /opt/homebrew/bin /usr/local/bin
done
find_tool node "${NVM_BIN:-}" "$(newest_nvm_bin)" "$HOME/.volta/bin" /opt/homebrew/bin /usr/local/bin
find_tool docker "$HOME/.docker/bin" /Applications/Docker.app/Contents/Resources/bin /usr/local/bin /opt/homebrew/bin
docker info >/dev/null 2>&1 || die "Docker isn't running; start Docker Desktop first"

TMPDIR=$(mktemp -d /tmp/dualdrive-audit-XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT
CLONE="$TMPDIR/repo"
OUT="$TMPDIR/out"
mkdir -p "$OUT"

# Builder's branch lives on its fork. refs/pull/<n>/head exists on the
# upstream repo for every pull request, whichever fork it came from.
git clone --quiet --depth 1 "$UPSTREAM_REPO_URL" "$CLONE"
git -C "$CLONE" fetch --quiet --depth 1 origin "pull/$PR_NUM/head:pr-$PR_NUM"
git -C "$CLONE" checkout --quiet "pr-$PR_NUM"
HEAD_SHA=$(git -C "$CLONE" rev-parse HEAD)

# Tests. package.json is mounted with src/ and test/ because Node reads its
# "type": "module" to decide that .js files are ES modules.
set +e
docker run --rm --network none \
  -v "$CLONE/package.json":/w/package.json:ro \
  -v "$CLONE/src":/w/src:ro \
  -v "$CLONE/test":/w/test:ro \
  -w /w node:22 node --test >"$OUT/tests.log" 2>&1
TEST_EXIT=$?
set -e

# Secrets.
if command -v gitleaks >/dev/null 2>&1; then
  set +e
  gitleaks detect --no-git --source "$CLONE" --redact --report-format json \
    --report-path "$OUT/gitleaks.json" >/dev/null 2>&1
  set -e
  node "$SCRIPT_DIR/secrets.js" --from-gitleaks "$OUT/gitleaks.json" "$CLONE" >"$OUT/secrets.json"
else
  node "$SCRIPT_DIR/secrets.js" "$CLONE" >"$OUT/secrets.json"
fi

# Dependencies. npm audit needs a lockfile; with none there's nothing it can
# check, which is the case while demo-service has no dependencies.
if [ -f "$CLONE/package-lock.json" ]; then
  set +e
  (cd "$CLONE" && npm audit --audit-level=high --json) >"$OUT/npm-audit.json" 2>/dev/null
  set -e
else
  echo '{"skipped":"no package-lock.json"}' >"$OUT/npm-audit.json"
fi

# Changed files, from the same API call @keyholder makes for its floor check,
# every page of it. A local git diff can't work here: both refs were fetched
# at depth 1 and share no reachable merge base. demo-service is public, so a
# token is optional; AUDIT_GITHUB_TOKEN, a read-only one, only raises the
# rate limit.
AUTH=()
if [ -n "${AUDIT_GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $AUDIT_GITHUB_TOKEN")
fi
page=1
while :; do
  curl -fsS ${AUTH[@]+"${AUTH[@]}"} \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/pulls/$PR_NUM/files?per_page=100&page=$page" \
    >"$OUT/files-$page.json"
  count=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).length)' "$OUT/files-$page.json")
  [ "$count" -lt 100 ] && break
  page=$((page + 1))
done
node -e 'console.log(JSON.stringify(process.argv.slice(1).flatMap((f) => JSON.parse(require("node:fs").readFileSync(f, "utf8")))))' \
  "$OUT"/files-*.json >"$OUT/files.json"

node "$SCRIPT_DIR/report.js" "$OUT" "$PR_NUM" "$HEAD_SHA" "$TEST_EXIT"
