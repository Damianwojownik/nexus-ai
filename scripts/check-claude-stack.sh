#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "FAIL Node: not on PATH." >&2; exit 1; }
exec node "$ROOT/scripts/claude-stack.mjs" check
