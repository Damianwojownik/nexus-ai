from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flp-root", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    flp_root = Path(args.flp_root).resolve()
    source = Path(args.source).resolve()
    audio = Path(args.audio).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if str(flp_root) not in sys.path:
        sys.path.insert(0, str(flp_root))

    previous = Path.cwd()
    os.chdir(flp_root)
    try:
        from omegaconf import OmegaConf
        from src.pipelines.gradio_live_portrait_pipeline import GradioLivePortraitPipeline

        cfg = OmegaConf.load(str(flp_root / "configs" / "onnx_infer.yaml"))
        cfg.infer_params.flag_pasteback = True
        pipe = GradioLivePortraitPipeline(cfg, is_animal=False)
        rendered, _preview, _elapsed = pipe.run_audio_driving(
            str(audio), str(source)
        )
        rendered_path = Path(rendered)
        if not rendered_path.is_absolute():
            rendered_path = (flp_root / rendered_path).resolve()
        if not rendered_path.exists():
            raise RuntimeError("FasterLivePortrait did not return an output video")
        shutil.copy2(rendered_path, output)
    finally:
        os.chdir(previous)


if __name__ == "__main__":
    main()
