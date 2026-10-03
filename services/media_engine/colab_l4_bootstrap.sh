#!/usr/bin/env bash
set -euo pipefail

ROOT="${NEXUS_ROOT:-/content/nexus-ai}"
VENDOR="$ROOT/vendor"
FLP="$VENDOR/FasterLivePortrait"
LTX="$VENDOR/LTX-Video"
CACHE="${HF_HOME:-/content/nexus-cache/huggingface}"
ENGINE_LOG="/content/nexus-media-engine.log"
TUNNEL_LOG="/content/nexus-cloudflared.log"

echo "== Nexus Media Engine / Colab L4 =="
nvidia-smi || true
free -h || true
df -h /content || true

sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg git espeak-ng curl >/dev/null

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

# Persist the active worker token locally for this Colab runtime only.
# The file lives under /content, is not committed, and is readable only by the current user.
printf '%s' "$NEXUS_MEDIA_ENGINE_TOKEN" >/content/nexus-media-engine.token
chmod 600 /content/nexus-media-engine.token

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "== Installing Cloudflare tunnel client =="
  sudo curl -L --fail --silent --show-error \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared
  sudo chmod +x /usr/local/bin/cloudflared
fi

pkill -f "services/media_engine/nexus_media_engine.py" >/dev/null 2>&1 || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:9872" >/dev/null 2>&1 || true

echo "== Starting Nexus Media Engine =="
nohup python "$ROOT/services/media_engine/nexus_media_engine.py" >"$ENGINE_LOG" 2>&1 &
ENGINE_PID=$!
echo "$ENGINE_PID" >/content/nexus-media-engine.pid

for _ in $(seq 1 90); do
  if curl -fsS \
    -H "Authorization: Bearer $NEXUS_MEDIA_ENGINE_TOKEN" \
    http://127.0.0.1:9872/health >/content/nexus-health.json 2>/dev/null; then
    break
  fi
  if ! kill -0 "$ENGINE_PID" >/dev/null 2>&1; then
    echo "Nexus Media Engine stopped during startup."
    tail -n 100 "$ENGINE_LOG" || true
    exit 1
  fi
  sleep 2
done

if ! curl -fsS \
  -H "Authorization: Bearer $NEXUS_MEDIA_ENGINE_TOKEN" \
  http://127.0.0.1:9872/health >/content/nexus-health.json; then
  echo "Health check failed."
  tail -n 100 "$ENGINE_LOG" || true
  exit 1
fi

echo "== Starting HTTPS tunnel =="
: >"$TUNNEL_LOG"
nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9872 >"$TUNNEL_LOG" 2>&1 &
echo $! >/content/nexus-cloudflared.pid

NEXUS_MEDIA_ENGINE_URL=""
for _ in $(seq 1 60); do
  NEXUS_MEDIA_ENGINE_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
  [ -n "$NEXUS_MEDIA_ENGINE_URL" ] && break
  sleep 1
done

if [ -z "$NEXUS_MEDIA_ENGINE_URL" ]; then
  echo "Tunnel URL was not created."
  tail -n 100 "$TUNNEL_LOG" || true
  exit 1
fi

echo
echo "============================================================"
echo "NEXUS MEDIA ENGINE READY"
echo "URL:   $NEXUS_MEDIA_ENGINE_URL"
echo "TOKEN: $NEXUS_MEDIA_ENGINE_TOKEN"
echo "============================================================"
echo
echo "Health:"
cat /content/nexus-health.json || true
echo
echo "Keep this Colab runtime connected while Nexus is rendering."
