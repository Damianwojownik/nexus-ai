"""Experimental cloud batch adapter for the pinned nosi EchoMimicV3 service."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

from render import verify_video
from configure_echomimic import NOSI_COMMIT, verify_memory_patch


def prepare_job(job, engine):
    portraits = [job / name for name in ("portrait.png", "portrait.jpg")
                 if (job / name).is_file()]
    if len(portraits) != 1 or not (job / "speech.wav").is_file():
        raise ValueError("Provide exactly one portrait PNG/JPEG and speech.wav")
    for name in ("video.mp4", "echo-silent.mp4", "echo-pending.mp4", "engine.json"):
        if (job / name).exists():
            raise FileExistsError(f"Existing {name} preserved; create a new job")
    models = engine / "models/echomimic"
    backbone = models / "Wan2.1-Fun-V1.1-1.3B-InP"
    required = [
        engine / "app/services/lipsync/echomimic_service.py",
        engine / "config/echomimic_config.yaml",
        backbone / "config.json",
        backbone / "diffusion_pytorch_model.safetensors",
        backbone / "Wan2.1_VAE.pth",
        backbone / "models_t5_umt5-xxl-enc-bf16.pth",
        backbone / "models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth",
        backbone / "google/umt5-xxl/tokenizer_config.json",
        models / "EchoMimicV3/echomimicv3-flash-pro/diffusion_pytorch_model.safetensors",
        models / "chinese-wav2vec2-base/config.json",
        models / "chinese-wav2vec2-base/preprocessor_config.json",
        models / "chinese-wav2vec2-base/pytorch_model.bin",
    ]
    missing = [str(path) for path in required if not path.is_file() or not path.stat().st_size]
    if missing:
        raise RuntimeError("EchoMimic dependencies missing:\n" + "\n".join(missing))
    revision = subprocess.run(
        ["git", "-C", str(engine), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if revision != NOSI_COMMIT:
        raise RuntimeError("Unsupported nosi revision; use the tested adapter source pin")
    verify_memory_patch(engine)
    return portraits[0], models


def validate_audio(audio, sample_rate, np):
    if audio.ndim != 1 or sample_rate != 16000:
        raise ValueError("speech.wav must be mono 16000 Hz audio")
    if not np.isfinite(audio).all() or not 0.2 <= len(audio) / sample_rate <= 30:
        raise ValueError("Speech must contain 0.2-30 seconds of finite audio")
    if float(np.max(np.abs(audio))) < 0.0001:
        raise ValueError("Speech is silent")


def validate_frames(frames, expected_count, np):
    if expected_count < 2 or len(frames) != expected_count:
        raise RuntimeError(f"Expected {expected_count} frames, received {len(frames)}")
    shape = frames[0].shape
    if len(shape) != 3 or min(shape[:2]) < 2 or any(side % 2 for side in shape[:2]):
        raise RuntimeError("EchoMimic frames require even positive video dimensions")
    for frame in frames:
        if (frame.shape != shape or frame.ndim != 3 or frame.shape[2] != 3
                or frame.dtype != np.uint8 or float(frame.std()) < 1):
            raise RuntimeError("EchoMimic produced invalid or blank BGR frames")


async def render_job(job):
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("EchoMimic inference requires a Linux cloud worker")
    job = Path(job).resolve()
    configured = os.environ.get("NEXUS_NOSI_DIR")
    if not configured:
        raise RuntimeError("Set NEXUS_NOSI_DIR to the pinned nosi checkout")
    engine = Path(configured).resolve()
    portrait, models = prepare_job(job, engine)
    import cv2
    import imageio.v2 as imageio
    import numpy as np
    import soundfile as sf
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("Cloud CUDA GPU required; no CPU fallback")
    audio, rate = sf.read(str(job / "speech.wav"), dtype="float32")
    validate_audio(audio, rate, np)
    image = cv2.imread(str(portrait))
    if image is None:
        raise ValueError("Portrait could not be decoded")
    sys.path.insert(0, str(engine))
    from app.services.lipsync.echomimic_service import EchoMimicV3Service

    service = EchoMimicV3Service(str(models))
    await service.load_models()
    if not service.neural_available:
        raise RuntimeError("EchoMimic neural model did not load")
    frames = await service.generate_frames(
        image, str(job / "speech.wav"), audio, sample_rate=rate, fps=25,
    )
    validate_frames(frames, int(len(audio) / rate * 25), np)
    silent = job / "echo-silent.mp4"
    pending = job / "echo-pending.mp4"
    with imageio.get_writer(str(silent), fps=25, codec="libx264",
                            quality=8, macro_block_size=None) as writer:
        for frame in frames:
            writer.append_data(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    subprocess.run([
        "ffmpeg", "-n", "-i", str(silent), "-i", str(job / "speech.wav"),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
        "-shortest", "-movflags", "+faststart", str(pending),
    ], check=True, timeout=120)
    verify_video(str(pending))
    pending.rename(job / "video.mp4")
    (job / "engine.json").write_text(json.dumps({
        "engine": "echomimic-v3", "adapter": "nosi", "upstreamCommit": NOSI_COMMIT,
        "mode": "batch", "liveStream": False, "fps": 25,
        "memoryStrategy": "stage-wise-cpu-offload",
        "frames": len(frames), "width": frames[0].shape[1], "height": frames[0].shape[0],
        "visualApproval": False, "requiresVisualReview": True,
    }, indent=2), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: render_echomimic.py JOB_DIRECTORY")
    asyncio.run(render_job(sys.argv[1]))
