# TEST / EXPERIMENTAL — Miś Engine v1. Original main branch remains untouched.
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
    parser.add_argument("--subject-mode", choices=["human", "animal"], default=os.environ.get("NEXUS_AVATAR_SUBJECT_MODE", "animal"))
    parser.add_argument("--articulation-json-file")
    parser.add_argument("--articulation-strength", type=float, default=0.35)
    args = parser.parse_args()

    flp_root = Path(args.flp_root).resolve()
    source = Path(args.source).resolve()
    audio = Path(args.audio).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if str(flp_root) not in sys.path:
        sys.path.insert(0, str(flp_root))
    avatar_service_root = Path(__file__).resolve().parents[1] / "avatar_server"
    if str(avatar_service_root) not in sys.path:
        sys.path.insert(0, str(avatar_service_root))

    previous = Path.cwd()
    os.chdir(flp_root)
    try:
        from omegaconf import OmegaConf
        from src.pipelines.gradio_live_portrait_pipeline import GradioLivePortraitPipeline

        cfg = OmegaConf.load(str(flp_root / "configs" / "onnx_infer.yaml"))
        cfg.infer_params.flag_pasteback = True
        pipe = GradioLivePortraitPipeline(cfg, is_animal=(args.subject_mode == "animal"))
        if args.articulation_json_file:
            from mis_articulation_injector import parse_controls, render_controlled_audio
            articulation_path = Path(args.articulation_json_file).resolve()
            controls = parse_controls(articulation_path.read_text(encoding="utf-8"))
            rendered_path = render_controlled_audio(
                pipe,
                audio,
                source,
                output.parent / "flp-controlled",
                controls,
                max(0.0, min(1.0, args.articulation_strength)),
            )
        else:
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
