#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

soft() {
  local label="$1"; shift
  if ! "$@"; then
    echo "WARN: $label failed; continuing." >&2
  fi
}

echo "== Nexus Claude Tooling =="
need node
need npm

major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$major" -lt 18 ]; then
  echo "Claude Code requires Node.js 18+." >&2
  exit 1
fi

echo "[1/6] Claude Code"
npm install -g @anthropic-ai/claude-code@latest
claude --version

echo "[2/6] OmniRoute"
npm install -g omniroute@latest
soft "OmniRoute doctor" omniroute doctor

echo "[3/6] claude-setup"
soft "claude-setup marketplace" claude plugin marketplace add nickmaglowsch/claude-setup
soft "claude-setup plugin" claude plugin install claude-setup@claude-setup --scope local

echo "[4/6] Headroom"
if command -v uv >/dev/null 2>&1; then
  soft "Headroom via uv" uv tool install --python 3.13 'headroom-ai[all]'
elif command -v python3 >/dev/null 2>&1; then
  soft "Headroom via pip" python3 -m pip install --user --upgrade 'headroom-ai[all]'
else
  echo "WARN: Python/uv not found; Headroom skipped." >&2
fi
if command -v headroom >/dev/null 2>&1; then
  soft "Headroom init Claude" headroom init claude
  soft "Headroom doctor" headroom doctor
else
  echo "WARN: headroom is not on PATH yet. Restart shell or add the user bin directory." >&2
fi

echo "[5/6] Task Observer"
soft "Task Observer" npx -y skills add rebelytics/one-skill-to-rule-them-all --skill task-observer --agent claude-code

echo "[6/6] OmniRoute MCP"
soft "OmniRoute MCP" claude mcp add --transport http --scope local omniroute http://127.0.0.1:20128/api/mcp/stream

echo
echo "Verification:"
soft "Claude doctor" claude doctor
soft "Claude MCP list" claude mcp list

echo
echo "Interactive steps still required:"
echo "  1) run: claude      and sign in"
echo "  2) run: omniroute setup"
echo "  3) run: omniroute   to keep the local gateway running"
echo "Start a fresh Claude session after setup so hooks/skills are loaded."
