#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Linux" && -d /content && "${NEXUS_CLOUD_WORKER:-}" == "1" ]] || {
  echo "Requires an authorized Colab Linux GPU experiment; not a FREE service." >&2
  exit 1
}
command -v nvidia-smi >/dev/null
nvidia-smi --query-gpu=name --format=csv,noheader
command -v uv >/dev/null

BASE=/content/nexus-faster-animal
REPO="$BASE/repo"
PYTHON="$BASE/venv/bin/python"
REVISION=8aad3602177547aaa5e4beec0c3ef5b7944e7a1f
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$BASE"
if [[ ! -d "$REPO" ]]; then
  git clone --no-checkout https://github.com/warmshao/FasterLivePortrait.git "$REPO"
  git -C "$REPO" checkout --detach "$REVISION"
fi
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$REVISION" ]] || {
  echo "Unexpected source revision; existing checkout was not modified." >&2
  exit 1
}
if [[ ! -x "$PYTHON" ]]; then
  uv venv --python 3.11 --seed "$BASE/venv"
fi
uv pip install --python "$PYTHON" --no-build-isolation-package tensorrt \
  -r "$SCRIPT_DIR/requirements-faster-animal.txt"
NVIDIA_LIBS="$("$PYTHON" -c 'from pathlib import Path; import sysconfig; print(":".join(str(p) for p in (Path(sysconfig.get_paths()["purelib"]) / "nvidia").glob("*/lib") if p.is_dir()))')"
export LD_LIBRARY_PATH="$NVIDIA_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$PYTHON" -c 'import torch, tensorrt; assert torch.cuda.is_available(); assert torch.backends.cudnn.version() // 1000 == 8; assert tensorrt.__version__ == "8.6.1"; print("CUDA_TENSORRT_COMPATIBLE", torch.__version__, torch.backends.cudnn.version(), tensorrt.__version__)'
TOOLCHAIN="$BASE/cuda-12-1"
export MAMBA_ROOT_PREFIX="$BASE/mamba"
if [[ ! -x "$BASE/bin/micromamba" ]]; then
  curl --fail --location --silent --show-error \
    https://micro.mamba.pm/api/micromamba/linux-64/2.3.2 \
    -o "$BASE/micromamba-2.3.2.tar.bz2"
  tar -xjf "$BASE/micromamba-2.3.2.tar.bz2" -C "$BASE" bin/micromamba
fi
if [[ ! -x "$TOOLCHAIN/bin/nvcc" ]]; then
  "$BASE/bin/micromamba" create --yes --prefix "$TOOLCHAIN" --override-channels \
    -c nvidia/label/cuda-12.1.1 -c conda-forge cuda-toolkit=12.1.1 gxx_linux-64=12
fi
export CUDA_HOME="$TOOLCHAIN"
export CC="$TOOLCHAIN/bin/x86_64-conda-linux-gnu-cc"
export CXX="$TOOLCHAIN/bin/x86_64-conda-linux-gnu-c++"
export PATH="$BASE/venv/bin:$TOOLCHAIN/bin:$PATH"
"$CUDA_HOME/bin/nvcc" --version
export TORCH_CUDA_ARCH_LIST
TORCH_CUDA_ARCH_LIST="$("$PYTHON" -c 'import torch; assert torch.cuda.is_available(); print(".".join(map(str,torch.cuda.get_device_capability())))')"
export MAX_JOBS=2
(
  cd "$REPO/src/models/XPose/models/UniPose/ops"
  "$PYTHON" setup.py build_ext --force build install
)
"$PYTHON" -m pip freeze > "$BASE/package-freeze.txt"

"$PYTHON" - "$REPO" <<'PY'
import os
from pathlib import Path
import sys
from huggingface_hub import snapshot_download

repo = Path(sys.argv[1])
checkpoints = repo / "checkpoints"
snapshot_download(
    "warmshao/FasterLivePortrait",
    revision="eb937f4bec7186598df2d1f68e1ddbb488ae1de5",
    local_dir=str(checkpoints),
    allow_patterns=[
        "README.md", "liveportrait_animal_onnx_v1.1/*",
        "liveportrait_onnx/libgrid_sample_3d_plugin.so",
        "liveportrait_animal_onnx/xpose.pth",
        "liveportrait_animal_onnx/clip_embedding_9.pkl",
        "liveportrait_animal_onnx/clip_embedding_68.pkl",
    ],
)
animal = checkpoints / "liveportrait_animal_onnx_v1.1"
for name in ("xpose.pth", "clip_embedding_9.pkl", "clip_embedding_68.pkl"):
    source = checkpoints / "liveportrait_animal_onnx" / name
    target = animal / name
    if not target.exists():
        os.link(source, target)
    elif not os.path.samefile(source, target):
        raise RuntimeError(f"Existing animal dependency is incompatible: {target}")
snapshot_download(
    "jdh-algo/JoyVASA",
    revision="b8f13fe9c23679c56f21b1baafb92ed00dc087c3",
    local_dir=str(checkpoints / "JoyVASA"),
    allow_patterns=["README.md", "config.json", "motion_generator/*", "motion_template/*"],
)
snapshot_download(
    "TencentGameMate/chinese-hubert-base",
    revision="fce0375452b1dd6c080ac3248d423d4d037bc831",
    local_dir=str(checkpoints / "chinese-hubert-base"),
    allow_patterns=["README.md", "config.json", "preprocessor_config.json", "pytorch_model.bin"],
)
print("FASTER_ANIMAL_WEIGHTS_READY", repo)
PY

(
  cd "$REPO"
  for model in warping_spade-fix motion_extractor appearance_feature_extractor stitching; do
    ONNX="checkpoints/liveportrait_animal_onnx_v1.1/${model}-v1.1.onnx"
    ENGINE="${ONNX%.onnx}.trt"
    PRECISION=fp16
    [[ "$model" != motion_extractor ]] || PRECISION=fp32
    if [[ ! -f "$ENGINE" ]]; then
      "$PYTHON" scripts/onnx2trt.py -o "$ONNX" -e "$ENGINE" -p "$PRECISION"
    fi
  done
)
echo "FASTER_ANIMAL_ENVIRONMENT_READY"
