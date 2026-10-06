#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKER_DIR="$ROOT/services/avatar_live_worker"
VENV_PY="$WORKER_DIR/.venv/bin/python"

[[ -x "$VENV_PY" ]] || { echo "Worker venv missing. Run services/avatar_live_worker/install_linux.sh first."; exit 1; }
[[ -n "${NEXUS_LIVE_AVATAR_WORKER_TOKEN:-}" ]] || { echo "Set NEXUS_LIVE_AVATAR_WORKER_TOKEN."; exit 1; }

export NEXUS_MUSETALK_DIR="${NEXUS_MUSETALK_DIR:-$ROOT/.tools/MuseTalk}"
export NEXUS_LIVE_WORKER_HOST="${NEXUS_LIVE_WORKER_HOST:-0.0.0.0}"
export NEXUS_LIVE_WORKER_PORT="${NEXUS_LIVE_WORKER_PORT:-9874}"
export NEXUS_LIVE_RENDER_FPS="${NEXUS_LIVE_RENDER_FPS:-25}"
export NEXUS_LIVE_MAX_SESSIONS="${NEXUS_LIVE_MAX_SESSIONS:-1}"
export NEXUS_LIVE_AUDIO_WINDOW_MS="${NEXUS_LIVE_AUDIO_WINDOW_MS:-480}"

exec "$VENV_PY" "$WORKER_DIR/worker.py"
