#!/usr/bin/env bash
# Deterministic checks for one pull request: the tests in a container with
# no network, a secret scan, a dependency audit, and the list of changed
# files. Prints one JSON line for @auditor to read.
#
# The tests run the way demo-service needs (Node 22, `node --test`) unless the
# upstream's default branch has a .dualdrive.json naming another image and
# command; audit/config.js reads it.
#
# Usage: audit/run.sh <pr-number>                 a pull request on GITHUB_REPOSITORY
#        audit/run.sh <owner/repo#pr-number>      one on another repo @keyholder governs
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
    set -a
    # shellcheck source=/dev/null
    source "$candidate"
    set +a
    break
  fi
done

TARGET="${1:-}"
TARGET_REPO=""
PR_NUM="$TARGET"
# In a variable: bash 3.2 reads a quoted or inline pattern differently.
repo_target='^([A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+)#([0-9]+)$'
if [[ "$TARGET" =~ $repo_target ]]; then
  TARGET_REPO="${BASH_REMATCH[1]}"
  PR_NUM="${BASH_REMATCH[2]}"
fi
[[ "$PR_NUM" =~ ^[0-9]+$ ]] || die "usage: audit/run.sh <pr-number>, or <owner/repo#pr-number> for another repo"
# No apostrophes in these messages: inside "${VAR:?...}" a ' starts a quote,
# so two of them vanish from the output and one breaks the script.
: "${UPSTREAM_REPO_URL:?Set UPSTREAM_REPO_URL in .env — do not guess it from the local checkout, this script does not run from inside demo-service}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY=owner/repo in .env}"

# The GitHub that hosts the repos: github.com, or a GitHub Enterprise Server.
GITHUB_SERVER="${GITHUB_SERVER_URL:-https://github.com}"
GITHUB_SERVER="${GITHUB_SERVER%/}"
server_url='^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~-]+)*$'
[[ "$GITHUB_SERVER" =~ $server_url ]] || die "GITHUB_SERVER_URL must be an https:// URL such as https://github.example.com"

# Another repo is cloned from that server by its name. Naming
# GITHUB_REPOSITORY itself keeps UPSTREAM_REPO_URL.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
if [ -n "$TARGET_REPO" ] && [ "$(lower "$TARGET_REPO")" != "$(lower "$GITHUB_REPOSITORY")" ]; then
  UPSTREAM_REPO_URL="$GITHUB_SERVER/$TARGET_REPO.git"
  GITHUB_REPOSITORY="$TARGET_REPO"
fi

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
  # With no match the pattern comes back unexpanded, and find_tool's -x
  # test on it fails, which is what we want.
  printf '%s\n' "$HOME"/.nvm/versions/node/v*/bin | sort -V | tail -1
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

# git for anything that talks to the server. A private repo needs
# AUDIT_GITHUB_TOKEN for git as well as for the API. It reaches git as an
# HTTP header for GITHUB_SERVER_URL only, exported in a subshell: never on a
# command line, where any user's ps could read it, and never in the clone
# URL or .git/config, which the test container mounts with the checkout.
# Prompts are off, so a repo git can't read fails here instead of waiting
# for a password nobody will type.
git_net() (
  export GIT_TERMINAL_PROMPT=0
  if [ -n "${AUDIT_GITHUB_TOKEN:-}" ]; then
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$AUDIT_GITHUB_TOKEN" | base64 | tr -d '\n')"
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$GITHUB_SERVER/.extraheader" GIT_CONFIG_VALUE_0
  fi
  exec git "$@"
)

# Builder's branch lives on its fork. refs/pull/<n>/head exists on the
# upstream repo for every pull request, whichever fork it came from.
git_net clone --quiet --depth 1 "$UPSTREAM_REPO_URL" "$CLONE"

# How to run the tests, from .dualdrive.json on the default branch. It is read
# before the pull request is checked out, so a pull request can't choose its
# own test command. git show reads the committed blob, so a symlink there
# can't point this at some other file.
CONFIG_FILE="$TMPDIR/dualdrive.json"
if git -C "$CLONE" cat-file -e HEAD:.dualdrive.json 2>/dev/null; then
  git -C "$CLONE" show HEAD:.dualdrive.json >"$CONFIG_FILE"
fi
node "$SCRIPT_DIR/config.js" "$CONFIG_FILE" >"$TMPDIR/test-config"
{
  IFS= read -r TEST_IMAGE
  IFS= read -r TEST_COMMAND
  IFS= read -r TEST_MODE
} <"$TMPDIR/test-config"
node "$SCRIPT_DIR/config.js" --json "$CONFIG_FILE" >"$OUT/config.json"

git_net -C "$CLONE" fetch --quiet --depth 1 origin "pull/$PR_NUM/head:pr-$PR_NUM"
git -C "$CLONE" checkout --quiet "pr-$PR_NUM"
HEAD_SHA=$(git -C "$CLONE" rev-parse HEAD)

# A pull request that adds, changes or removes .dualdrive.json is still
# tested the default branch's way, but the report shows what it proposes,
# so a reviewer onboarding a new language sees why its tests didn't run as
# the new file says. Changing the file needs two approvals either way.
if git -C "$CLONE" cat-file -e "pr-$PR_NUM:.dualdrive.json" 2>/dev/null; then
  git -C "$CLONE" show "pr-$PR_NUM:.dualdrive.json" >"$TMPDIR/proposed.json"
  if ! cmp -s "$TMPDIR/proposed.json" "$CONFIG_FILE"; then
    node "$SCRIPT_DIR/config.js" --json "$TMPDIR/proposed.json" >"$OUT/proposed-config.json"
  fi
elif [ -f "$CONFIG_FILE" ]; then
  echo '{"removed":true}' >"$OUT/proposed-config.json"
fi

# Everything below checks what the base branch would become: GitHub's test
# merge, refs/pull/<n>/merge, when there is one. It is used only when its
# second parent is HEAD_SHA, the head the verdict will name; GitHub doesn't
# make one for a pull request with conflicts, and can lag behind a new push,
# and then the head itself is checked. The report says which. cat-file reads
# the parents from the commit itself, since a depth-1 fetch has no history.
TESTED_REF="head"
TESTED_SHA="$HEAD_SHA"
if git_net -C "$CLONE" fetch --quiet --depth 1 origin "pull/$PR_NUM/merge:pr-$PR_NUM-merge" 2>/dev/null; then
  merged_head="$(git -C "$CLONE" cat-file -p "pr-$PR_NUM-merge" | sed -n 's/^parent //p' | sed -n 2p)"
  if [ "$merged_head" = "$HEAD_SHA" ]; then
    git -C "$CLONE" checkout --quiet "pr-$PR_NUM-merge"
    TESTED_REF="merge"
    TESTED_SHA="$(git -C "$CLONE" rev-parse HEAD)"
  fi
fi

# Tests, as untrusted code: no network, capped memory, CPU and processes, no
# Linux capabilities, no setuid escalation, and a read-only filesystem apart
# from /tmp, which is also HOME for tools that keep a cache there.
CONTAINER=(--rm --network none
  --memory=512m --cpus=1.0 --pids-limit=64
  --cap-drop=ALL --security-opt=no-new-privileges
  --read-only "--tmpfs=/tmp:rw,exec,nosuid,nodev,size=256m" -e HOME=/tmp)
# The whole checkout is mounted read-only, so code the tests import from
# any folder is there. Without a .dualdrive.json the command is Node's,
# which needs a package.json; a repo with neither gets a failing result that
# says so, rather than Node's error about a project that isn't Node.
if [ "$TEST_MODE" = default ] && [ ! -f "$CLONE/package.json" ]; then
  echo "audit/run.sh: no .dualdrive.json on the default branch and no package.json, so there is no test command to run. Commit a .dualdrive.json naming the image and test_command (README)." >"$OUT/tests.log"
  TEST_EXIT=3
else
  set +e
  docker run "${CONTAINER[@]}" \
    -v "$CLONE":/w:ro -w /w \
    --entrypoint /bin/sh "$TEST_IMAGE" -c "$TEST_COMMAND" >"$OUT/tests.log" 2>&1
  TEST_EXIT=$?
  set -e
fi

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
#
# This runs on the host with network access, inside the pull request's own
# checkout. A .npmrc there could point npm at any registry and put any
# environment variable in the auth header, since npm expands ${VAR} in it.
# So the pull request's .npmrc goes, npm starts with an empty environment and
# a throwaway HOME, and the registry is named on the command line.
if [ -f "$CLONE/package-lock.json" ]; then
  rm -f "$CLONE/.npmrc"
  mkdir -p "$TMPDIR/npm-home"
  set +e
  (cd "$CLONE" && env -i PATH="$PATH" HOME="$TMPDIR/npm-home" \
    npm audit --audit-level=high --json --registry=https://registry.npmjs.org/) >"$OUT/npm-audit.json" 2>/dev/null
  set -e
else
  echo '{"skipped":"no package-lock.json"}' >"$OUT/npm-audit.json"
fi

# Every other ecosystem's lockfiles (pip, Poetry, uv, Go, Cargo, Bundler,
# Composer, Maven, Gradle, pnpm, Yarn, NuGet, Mix, pub) through osv-scanner,
# only when there is one, since the image is large. It reads the files and
# asks osv.dev about the versions; it runs nothing from the pull request, in
# a container with the checkout read-only and no capabilities.
OSV_IMAGE="ghcr.io/google/osv-scanner:v2.2.4"
other_lockfile="$(find "$CLONE" \( -path "$CLONE/.git" -o -name node_modules \) -prune -o -type f \( \
  -name 'requirements*.txt' -o -name Pipfile.lock -o -name poetry.lock -o -name uv.lock -o -name pdm.lock \
  -o -name go.mod -o -name Cargo.lock -o -name Gemfile.lock -o -name composer.lock -o -name pom.xml \
  -o -name gradle.lockfile -o -name pnpm-lock.yaml -o -name yarn.lock -o -name packages.lock.json \
  -o -name mix.lock -o -name pubspec.lock \) -print -quit)"
if [ -n "$other_lockfile" ]; then
  set +e
  docker run --rm --memory=1g --cpus=1.0 --pids-limit=256 \
    --cap-drop=ALL --security-opt=no-new-privileges \
    --read-only "--tmpfs=/tmp:rw,nosuid,nodev,size=256m" -e HOME=/tmp \
    -v "$CLONE":/src:ro "$OSV_IMAGE" scan source --format json -r /src >"$OUT/osv.json" 2>"$OUT/osv.log"
  echo "$?" >"$OUT/osv-exit"
  set -e
else
  echo skipped >"$OUT/osv-exit"
fi

# Changed files, from the same API call @keyholder makes for its floor check,
# every page of it. GITHUB_API_URL points it at GitHub Enterprise, or at the
# stand-in scripts/audit-e2e.sh runs. A local git diff can't work here: the
# refs were fetched at depth 1 and share no reachable merge base. The token
# goes to curl in a header file only this user can read, not as an argument.
AUTH=()
if [ -n "${AUDIT_GITHUB_TOKEN:-}" ]; then
  (umask 077 && printf 'Authorization: Bearer %s\n' "$AUDIT_GITHUB_TOKEN" >"$TMPDIR/github-auth")
  AUTH=(-H "@$TMPDIR/github-auth")
else
  echo "audit/run.sh: AUDIT_GITHUB_TOKEN is unset; using unauthenticated GitHub API (rate limit: 60 req/hr)" >&2
fi
# GitHub Enterprise Server's API lives under its own address, so
# GITHUB_SERVER_URL alone is enough; GITHUB_API_URL still wins.
if [ "$GITHUB_SERVER" = "https://github.com" ]; then
  GITHUB_API="${GITHUB_API_URL:-https://api.github.com}"
else
  GITHUB_API="${GITHUB_API_URL:-$GITHUB_SERVER/api/v3}"
fi
GITHUB_API="${GITHUB_API%/}"
page=1
while :; do
  curl -fsS ${AUTH[@]+"${AUTH[@]}"} \
    -H "Accept: application/vnd.github+json" \
    "$GITHUB_API/repos/$GITHUB_REPOSITORY/pulls/$PR_NUM/files?per_page=100&page=$page" \
    >"$OUT/files-$page.json"
  count=$(node -e 'const data = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!Array.isArray(data)) { console.error("GitHub files API response is not an array"); process.exit(1); } console.log(data.length);' "$OUT/files-$page.json")
  [[ "$count" =~ ^[0-9]+$ ]] || die "GitHub files API returned unexpected response on page $page"
  [ "$count" -lt 100 ] && break
  page=$((page + 1))
done
node -e 'console.log(JSON.stringify(process.argv.slice(1).flatMap((f) => JSON.parse(require("node:fs").readFileSync(f, "utf8")))))' \
  "$OUT"/files-*.json >"$OUT/files.json"

node "$SCRIPT_DIR/report.js" "$OUT" "$PR_NUM" "$HEAD_SHA" "$TEST_EXIT" "$GITHUB_REPOSITORY" "$TESTED_REF" "$TESTED_SHA"
