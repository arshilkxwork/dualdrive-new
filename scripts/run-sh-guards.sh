#!/usr/bin/env bash
# Checks the ways audit/run.sh refuses to start. None of them need Docker, so
# this runs on macOS too, where the README's setup lives and /bin/bash is 3.2.
#
#   bash scripts/run-sh-guards.sh [bash-to-test]     default: bash on PATH
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_UNDER_TEST="${1:-bash}"
# shellcheck disable=SC2016 # $BASH_VERSION is for the shell under test
"$SHELL_UNDER_TEST" -c 'echo "testing audit/run.sh with bash $BASH_VERSION"'

# A copy of the script with nothing beside it, so a real .env in this
# checkout can't leak into the cases.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-sh-guards-XXXXXX")"
mkdir "$WORK/audit"
cp "$ROOT/audit/run.sh" "$WORK/audit/run.sh"

failed=0
# check <name> <expected exit> <expected text> [VAR=value ...] -- [args ...]
check() {
  local name="$1" want_exit="$2" want_text="$3" output code=0
  shift 3
  local vars=()
  while [ "$1" != "--" ]; do
    vars+=("$1")
    shift
  done
  shift
  output="$(cd "$WORK" && env -i PATH="$PATH" HOME="$HOME" ${vars[@]+"${vars[@]}"} "$SHELL_UNDER_TEST" audit/run.sh "$@" 2>&1)" || code=$?
  if [ "$code" -eq "$want_exit" ] && [[ "$output" == *"$want_text"* ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: exit $code, wanted $want_exit and \"$want_text\""
    printf '%s\n' "$output" | sed 's/^/     /'
    failed=1
  fi
}

check "no pull request number" 2 "usage: audit/run.sh <pr-number>" --
check "a pull request number that isn't a number" 2 "usage: audit/run.sh <pr-number>" -- 12abc
check "a repo target that isn't owner/repo#N" 2 "usage: audit/run.sh <pr-number>" -- "just-a-name#7"
check "a repo target with a flag for an owner" 2 "usage: audit/run.sh <pr-number>" -- "-x/repo#7"
check "an owner/repo#N target passes the usage check" 1 "do not guess it from the local checkout" -- "org/other-repo#7"
check "UPSTREAM_REPO_URL unset" 1 "do not guess it from the local checkout" -- 7
check "GITHUB_REPOSITORY unset" 1 "Set GITHUB_REPOSITORY=owner/repo" UPSTREAM_REPO_URL=https://example.invalid/r.git -- 7
check "GITHUB_SERVER_URL that isn't https" 2 "GITHUB_SERVER_URL must be an https:// URL" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r GITHUB_SERVER_URL=http://github.example.com -- 7
check "GITHUB_SERVER_URL with a header in it" 2 "GITHUB_SERVER_URL must be an https:// URL" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r "GITHUB_SERVER_URL=https://x.example/.extraheader=1" -- 7
check "OSV_IMAGE that docker would read as a flag" 2 "OSV_IMAGE must be a container image name" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r OSV_IMAGE=--privileged -- 7
check "NPM_AUDIT_REGISTRY that isn't https" 2 "NPM_AUDIT_REGISTRY must be an https:// URL" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r NPM_AUDIT_REGISTRY=http://mirror.example/ -- 7
check "a time limit that isn't whole seconds" 2 "must be whole seconds" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r AUDIT_TEST_TIMEOUT=10m -- 7
check "a time limit of zero" 2 "must be whole seconds" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r AUDIT_SCAN_TIMEOUT=0 -- 7
check "a clone URL with a token in it" 2 "UPSTREAM_REPO_URL has credentials in it" \
  UPSTREAM_REPO_URL=https://x-access-token:abc123@github.com/o/r.git GITHUB_REPOSITORY=o/r -- 7
check "an OSV_MODE that doesn't exist" 2 "OSV_MODE must be online, offline or off" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r OSV_MODE=fast -- 7
check "offline OSV with no database directory" 2 "OSV_MODE=offline needs OSV_DB_DIR" \
  UPSTREAM_REPO_URL=https://example.invalid/r.git GITHUB_REPOSITORY=o/r OSV_MODE=offline OSV_DB_DIR=/no/such/dir -- 7

printf 'GITHUB_TOKEN=github_pat_not_a_real_one\n' >"$WORK/.env"
check "keyholder's GITHUB_TOKEN in .env" 2 "holds keyholder's secrets" -- 7
printf '  export KEYHOLDER_API_KEY="k"\n' >"$WORK/.env"
check "keyholder's API key in .env, exported and indented" 2 "holds keyholder's secrets" -- 7
printf 'SWITCH_REGISTRATION_TOKEN=abc\n' >"$WORK/.env"
check "the registration token in .env" 2 "holds keyholder's secrets" -- 7

# Empty or commented-out values are fine: copying .env.example as it is
# leaves them that way. The run then stops at the next check instead.
printf 'GITHUB_TOKEN=\nKEYHOLDER_API_KEY= # later\n# SWITCH_REGISTRATION_TOKEN=abc\n' >"$WORK/.env"
check "empty and commented-out secrets pass the guard" 1 "do not guess it from the local checkout" -- 7

# The message for a missing setting must come through whole. Inside
# "${VAR:?...}" an apostrophe starts a quote and swallows text.
cp "$ROOT/.env.example" "$WORK/.env"
sed -i.bak '/^UPSTREAM_REPO_URL=/d' "$WORK/.env"
check "a copy of .env.example passes the guard" 1 "Set UPSTREAM_REPO_URL in .env" -- 7

exit "$failed"
