#!/usr/bin/env bash
# Runs the DualDrive sandbox (docker-compose.yml) once and exits with the
# demo's result: a prompt-injected builder that can't get a merge, then two
# named reviewers who can. Needs only Docker.
#
#   bash scripts/demo-sandbox.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
docker info >/dev/null 2>&1 || { echo "demo-sandbox.sh: Docker isn't running" >&2; exit 2; }

code=0
docker compose up --build --attach demo --abort-on-container-exit --exit-code-from demo || code=$?
docker compose down --remove-orphans >/dev/null 2>&1 || true
exit "$code"
