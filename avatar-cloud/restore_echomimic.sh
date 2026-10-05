#!/usr/bin/env bash
set -euo pipefail

if [[ "${NEXUS_CLOUD_WORKER:-}" != "1" || "$(uname -s)" != "Linux" || ! -d /content ]]; then
  echo "Run only in an authorized Linux Colab worker with NEXUS_CLOUD_WORKER=1." >&2
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

root=/content/nexus-avatar
engine=/content/nexus-nosi-test/repo
python=/content/nexus-nosi-test/venv/bin/python
revision=a6bdb2a93ce2754dcbb1de74ac89c513b655f99f
export HF_HUB_DISABLE_TELEMETRY=1

for name in render.py render_echomimic.py configure_echomimic.py echomimic-low-vram.patch requirements-echomimic.txt; do
  test -s "$root/$name" || { echo "Upload missing $name to $root" >&2; exit 1; }
done
if ! command -v uv >/dev/null; then
  python -m pip install uv
fi
mkdir -p /content/nexus-nosi-test
if [[ ! -d "$engine" ]]; then
  git clone https://github.com/Charlex123/nosi.git "$engine"
  git -C "$engine" checkout --detach "$revision"
fi
[[ "$(git -C "$engine" rev-parse HEAD)" == "$revision" ]] || {
  echo "Existing nosi checkout has a different revision; preserved without modification." >&2
  exit 1
}
if [[ ! -x "$python" ]]; then
  uv venv --python 3.11 --seed /content/nexus-nosi-test/venv
fi
uv pip install --python "$python" \
  -r "$engine/requirements.txt" -r "$root/requirements-echomimic.txt" \
  'torch==2.8.0' 'torchvision==0.23.0' 'torchaudio==2.8.0'
"$python" "$root/configure_echomimic.py" "$engine"

hf=/content/nexus-nosi-test/venv/bin/hf
models="$engine/models/echomimic"
timeout 1800 "$hf" download alibaba-pai/Wan2.1-Fun-V1.1-1.3B-InP \
  --revision fc913c34361f4ec879e2f9c78b4f11ae50a937d1 \
  --local-dir "$models/Wan2.1-Fun-V1.1-1.3B-InP" \
  --include 'config.json' 'diffusion_pytorch_model.safetensors' 'Wan2.1_VAE.pth' \
  'models_t5_umt5-xxl-enc-bf16.pth' 'models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth' \
  'google/umt5-xxl/*' 'xlm-roberta-large/*' 'LICENSE.txt' 'README*.md'
timeout 1800 "$hf" download BadToBest/EchoMimicV3 \
  --revision 311e176905a8c4c24b240b530488fe636ce4d249 \
  --local-dir "$models/EchoMimicV3" --include 'echomimicv3-flash-pro/*' 'README.md'
timeout 900 "$hf" download TencentGameMate/chinese-wav2vec2-base \
  --revision 3991242c806928916fff4a8c0e4f76acf661b743 \
  --local-dir "$models/chinese-wav2vec2-base" \
  --include 'config.json' 'preprocessor_config.json' 'pytorch_model.bin' 'README.md'
"$python" -m pip freeze > /content/nexus-nosi-test/restored-packages.txt
echo "ECHOMIMIC_RESTORED: source/weights pinned; actual render and visual review still required."
