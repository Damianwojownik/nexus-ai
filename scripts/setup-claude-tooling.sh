#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "FAIL Node: install Node 22.22.2+, or 24/25/26 first." >&2
  exit 1
fi
exec node "$ROOT/scripts/claude-stack.mjs" setup "$@"
