from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path
from urllib.request import urlopen

from huggingface_hub import hf_hub_download

FACE_PARSE_GDRIVE_ID = "154JgKpzCPW82qINcVieuPH3fZ2e0P812"
RESNET_URL = "https://download.pytorch.org/models/resnet18-5c106cde.pth"

HF_FILES = [
    ("TMElyralab/MuseTalk", "musetalkV15/musetalk.json", "models/musetalkV15/musetalk.json"),
    ("TMElyralab/MuseTalk", "musetalkV15/unet.pth", "models/musetalkV15/unet.pth"),
    ("stabilityai/sd-vae-ft-mse", "config.json", "models/sd-vae/config.json"),
    ("stabilityai/sd-vae-ft-mse", "diffusion_pytorch_model.bin", "models/sd-vae/diffusion_pytorch_model.bin"),
    ("openai/whisper-tiny", "config.json", "models/whisper/config.json"),
    ("openai/whisper-tiny", "pytorch_model.bin", "models/whisper/pytorch_model.bin"),
    ("openai/whisper-tiny", "preprocessor_config.json", "models/whisper/preprocessor_config.json"),
    ("yzd-v/DWPose", "dw-ll_ucoco_384.pth", "models/dwpose/dw-ll_ucoco_384.pth"),
    ("ByteDance/LatentSync", "latentsync_syncnet.pt", "models/syncnet/latentsync_syncnet.pt"),
]


def copy_hf(repo_id: str, filename: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    source = Path(hf_hub_download(repo_id=repo_id, filename=filename))
    if source.resolve() != target.resolve():
        shutil.copy2(source, target)
    print(f"OK {target}")


def download_url(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(url, timeout=120) as response, target.open("wb") as output:
        shutil.copyfileobj(response, output)
    print(f"OK {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download pinned MuseTalk 1.5 dependencies for Nexus Live")
    parser.add_argument("--musetalk-dir", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    root = Path(args.musetalk_dir).resolve()
    if not (root / "musetalk").is_dir():
        raise SystemExit(f"Not a MuseTalk checkout: {root}")

    for repo_id, filename, relative in HF_FILES:
        target = root / relative
        if target.exists() and target.stat().st_size > 0 and not args.force:
            print(f"SKIP {target}")
            continue
        copy_hf(repo_id, filename, target)

    face_parse = root / "models/face-parse-bisent/79999_iter.pth"
    if not face_parse.exists() or face_parse.stat().st_size == 0 or args.force:
        try:
            import gdown
        except ImportError as exc:
            raise SystemExit("Install gdown before downloading face parsing weights") from exc
        face_parse.parent.mkdir(parents=True, exist_ok=True)
        result = gdown.download(id=FACE_PARSE_GDRIVE_ID, output=str(face_parse), quiet=False)
        if not result or not face_parse.exists() or face_parse.stat().st_size == 0:
            raise SystemExit("Failed to download face parsing weights")
        print(f"OK {face_parse}")
    else:
        print(f"SKIP {face_parse}")

    resnet = root / "models/face-parse-bisent/resnet18-5c106cde.pth"
    if not resnet.exists() or resnet.stat().st_size == 0 or args.force:
        download_url(RESNET_URL, resnet)
    else:
        print(f"SKIP {resnet}")

    required = [
        root / "models/musetalkV15/musetalk.json",
        root / "models/musetalkV15/unet.pth",
        root / "models/sd-vae/config.json",
        root / "models/sd-vae/diffusion_pytorch_model.bin",
        root / "models/whisper/config.json",
        root / "models/whisper/pytorch_model.bin",
        root / "models/whisper/preprocessor_config.json",
        root / "models/dwpose/dw-ll_ucoco_384.pth",
        root / "models/syncnet/latentsync_syncnet.pt",
        face_parse,
        resnet,
    ]
    missing = [str(path) for path in required if not path.exists() or path.stat().st_size == 0]
    if missing:
        raise SystemExit("Missing model assets:\n" + "\n".join(missing))

    print("Nexus Live MuseTalk model pack is complete.")


if __name__ == "__main__":
    main()
