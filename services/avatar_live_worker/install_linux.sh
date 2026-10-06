#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKER_DIR="$ROOT/services/avatar_live_worker"
TOOLS_DIR="$ROOT/.tools"
MUSETALK_DIR="$TOOLS_DIR/MuseTalk"
VENV_DIR="$WORKER_DIR/.venv"
MUSETALK_COMMIT="0a89dec45a0192b824e3cf4daf96c239440c5ed8"
PYTHON="${PYTHON:-python3.10}"

command -v git >/dev/null || { echo "git is required"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (apt-get install ffmpeg)"; exit 1; }
command -v "$PYTHON" >/dev/null || { echo "Python 3.10 is required"; exit 1; }

mkdir -p "$TOOLS_DIR"
if [[ ! -d "$MUSETALK_DIR/.git" ]]; then
  git clone https://github.com/TMElyralab/MuseTalk.git "$MUSETALK_DIR"
fi

git -C "$MUSETALK_DIR" fetch --depth 1 origin "$MUSETALK_COMMIT"
git -C "$MUSETALK_DIR" checkout --detach "$MUSETALK_COMMIT"
ACTUAL="$(git -C "$MUSETALK_DIR" rev-parse HEAD)"
[[ "$ACTUAL" == "$MUSETALK_COMMIT" ]] || { echo "MuseTalk pin mismatch: $ACTUAL"; exit 1; }

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"
PY="$VENV_DIR/bin/python"
"$PY" -m pip install --upgrade pip setuptools wheel
"$PIP" install torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118
"$PIP" install -r "$MUSETALK_DIR/requirements.txt"
"$PIP" install --upgrade openmim
"$VENV_DIR/bin/mim" install mmengine
"$VENV_DIR/bin/mim" install "mmcv==2.0.1"
"$VENV_DIR/bin/mim" install "mmdet==3.1.0"
"$VENV_DIR/bin/mim" install "mmpose==1.1.0"
"$PIP" install -r "$WORKER_DIR/requirements.txt"
"$PIP" install "huggingface_hub==0.30.2" gdown

"$PY" "$WORKER_DIR/download_models.py" --musetalk-dir "$MUSETALK_DIR"

export NEXUS_MUSETALK_DIR="$MUSETALK_DIR"
"$PY" - <<'PY'
import os
import torch
print("Python:", __import__("sys").version.split()[0])
print("Torch:", torch.__version__)
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0)
    print("GPU:", p.name)
    print("VRAM GiB:", round(p.total_memory / 1024**3, 2))
print("MuseTalk:", os.environ["NEXUS_MUSETALK_DIR"])
PY

echo
echo "Nexus Live worker installation complete."
echo "Next: set NEXUS_LIVE_AVATAR_WORKER_TOKEN and run services/avatar_live_worker/start_linux.sh"
