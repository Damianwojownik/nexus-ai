"""Isolated Colab/Linux cloud setup, invoked explicitly from a notebook."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

from render_flashhead import require_cloud

COMMIT = "9bc03de06bb0de82cd6bc477804512ae06144bf2"


def main():
    require_cloud()
    os.environ["MPLBACKEND"] = "Agg"
    if os.environ.get("NEXUS_MODEL_DOWNLOAD_CONSENT") != "1":
        raise RuntimeError("Authorize model installation with NEXUS_MODEL_DOWNLOAD_CONSENT=1")
    root = Path(os.environ.get("NEXUS_FLASHHEAD_SETUP_DIR", "/content/nexus-flashhead-lite")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free < 50 * 1024**3:
        raise RuntimeError("At least 50 GiB free disk is required for cloud setup")
    gpu = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader,nounits"],
        text=True, timeout=30).splitlines()[0].split(",")
    if float(gpu[2]) < 8 or int(gpu[1]) < 16384:
        raise RuntimeError("Use an Ampere-or-newer cloud GPU with at least 16 GiB VRAM")
    print("Cloud GPU:", ", ".join(gpu), flush=True)
    with (root / "setup.log").open("a", buffering=1, encoding="utf-8") as log:
        def run(args, cwd=None, timeout=1200):
            print("Running:", " ".join(map(str, args)), flush=True)
            subprocess.run(list(map(str, args)), cwd=cwd, timeout=timeout, check=True,
                           stdout=log, stderr=subprocess.STDOUT)

        run([sys.executable, "-m", "pip", "install", "uv"])
        uv = shutil.which("uv")
        if not uv:
            raise RuntimeError("uv installation failed")
        python = root / ".venv/bin/python"
        if not python.exists():
            run([uv, "venv", "--python", "3.10", root / ".venv"])
        repo = root / "engine"
        if not repo.exists():
            run(["git", "clone", "https://github.com/Soul-AILab/SoulX-FlashHead.git", repo])
            run(["git", "checkout", COMMIT], cwd=repo)
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
        if actual != COMMIT:
            raise RuntimeError("Existing engine revision differs; do not overwrite another installation")
        run([uv, "pip", "install", "--python", python, "torch==2.7.1", "torchvision==0.22.1",
             "--index-url", "https://download.pytorch.org/whl/cu128"])
        # Upstream pins NCCL 2.27.3, but its torch/xformers versions require 2.26.2.
        requirements = root / "requirements.nexus.txt"
        lines = (repo / "requirements.txt").read_text().splitlines()
        requirements.write_text("\n".join(
            line for line in lines if line.strip() != "nvidia-nccl-cu12==2.27.3"
        ) + "\nnvidia-nccl-cu12==2.26.2\ntorch==2.7.1\ntorchvision==0.22.1\n")
        run([uv, "pip", "install", "--python", python, "-r", requirements,
             "ninja", "packaging", "setuptools", "wheel", "huggingface_hub"])
        run([python, "-c", "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"])
        env = dict(os.environ, MAX_JOBS="2")
        subprocess.run([uv, "pip", "install", "--python", str(python),
                        "flash_attn==2.8.0.post2", "--no-build-isolation"],
                       env=env, check=True, timeout=1200, stdout=log, stderr=subprocess.STDOUT)
        run(["apt-get", "update"])
        run(["apt-get", "install", "-y", "espeak-ng", "ffmpeg"])
        run([python, "-c",
             "from huggingface_hub import snapshot_download; "
             "snapshot_download('Soul-AILab/SoulX-FlashHead-1_3B', "
             "allow_patterns=['Model_Lite/**','VAE_LTX/**','README.md','LICENSE*'], "
             "local_dir='models/SoulX-FlashHead-1_3B'); "
             "snapshot_download('facebook/wav2vec2-base-960h',local_dir='models/wav2vec2-base-960h')"],
            cwd=repo)
        run([python, "-c", "from flash_head.inference import get_pipeline; print('FlashHead imports OK')"],
            cwd=repo)
    print("SETUP COMPLETE. No local GPU was used.", flush=True)


if __name__ == "__main__":
    main()
