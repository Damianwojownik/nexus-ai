#!/usr/bin/env bash
set -euo pipefail

ROOT="${NEXUS_ROOT:-/content/nexus-ai}"
VENDOR="$ROOT/vendor"
FLP="$VENDOR/FasterLivePortrait"
LTX="$VENDOR/LTX-Video"
CACHE="${HF_HOME:-/content/nexus-cache/huggingface}"

echo "== Nexus Media Engine / Colab L4 =="
nvidia-smi || true
free -h || true
df -h /content || true

sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg git espeak-ng >/dev/null

python -m pip install -q --upgrade pip
python -m pip install -q fastapi "uvicorn[standard]" python-multipart pillow huggingface_hub

mkdir -p "$VENDOR" "$CACHE"
export HF_HOME="$CACHE"
export TRANSFORMERS_CACHE="$CACHE/transformers"
export HUGGINGFACE_HUB_CACHE="$CACHE/hub"
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True,max_split_size_mb:256"

if [ ! -d "$FLP/.git" ]; then
  git clone --depth=1 https://github.com/warmshao/FasterLivePortrait.git "$FLP"
else
  git -C "$FLP" pull --ff-only
fi

if [ ! -d "$LTX/.git" ]; then
  git clone --depth=1 https://github.com/Lightricks/LTX-Video.git "$LTX"
else
  git -C "$LTX" pull --ff-only
fi

echo "== Installing FasterLivePortrait dependencies =="
python -m pip install -q -r "$FLP/requirements.txt"
python -m pip install -q onnxruntime-gpu omegaconf

echo "== Downloading FasterLivePortrait checkpoints =="
huggingface-cli download warmshao/FasterLivePortrait --local-dir "$FLP/checkpoints"

echo "== Installing LTX-Video =="
python -m pip install -q -e "$LTX"

export FASTER_LIVEPORTRAIT_DIR="$FLP"
export LTX_VIDEO_DIR="$LTX"
export NEXUS_LTX_CONFIG="$ROOT/services/media_engine/configs/ltxv-nexus-l4.yaml"
export NEXUS_MEDIA_RUNTIME="/content/nexus-runtime/media_engine"

if [ -z "${NEXUS_MEDIA_ENGINE_TOKEN:-}" ]; then
  export NEXUS_MEDIA_ENGINE_TOKEN="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
fi

echo
echo "NEXUS_MEDIA_ENGINE_TOKEN=$NEXUS_MEDIA_ENGINE_TOKEN"
echo "Starting Nexus Media Engine on :9872"
python "$ROOT/services/media_engine/nexus_media_engine.py"
