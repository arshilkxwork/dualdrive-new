#!/usr/bin/env bash
# Runs the DualDrive sandbox (docker-compose.yml) once and exits with the
# demo's result: a prompt-injected builder that can't get a merge, then two
# named reviewers who can. Needs only Docker.
#
#   bash scripts/demo-sandbox.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# An IDE, an agent or a non-login shell may not have read the startup files
# that put Docker Desktop's CLI on PATH. Look where it installs, as
# audit/run.sh does.
if ! command -v docker >/dev/null 2>&1; then
  for dir in "$HOME/.docker/bin" /Applications/Docker.app/Contents/Resources/bin /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$dir/docker" ]; then
      PATH="$dir:$PATH"
      break
    fi
  done
fi
command -v docker >/dev/null 2>&1 || { echo "demo-sandbox.sh: can't find docker. Install Docker Desktop, or put docker on PATH." >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "demo-sandbox.sh: Docker is installed but not running; start Docker Desktop first" >&2; exit 2; }

code=0
docker compose up --build --attach demo --abort-on-container-exit --exit-code-from demo || code=$?
docker compose down --remove-orphans >/dev/null 2>&1 || true
exit "$code"
