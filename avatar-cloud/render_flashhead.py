"""Cloud-only SoulX-FlashHead adapter for the existing Nexus job protocol."""
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

from render import verify_video


def require_cloud():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("FlashHead is restricted to a Linux cloud worker")


def validate_gpu(torch):
    if not torch.cuda.is_available():
        raise RuntimeError("Cloud CUDA GPU is required; no CPU/local fallback")
    major, _minor = torch.cuda.get_device_capability(0)
    memory = torch.cuda.get_device_properties(0).total_memory
    if major < 8 or memory < 16 * 1024**3:
        raise RuntimeError("Use an Ampere-or-newer cloud GPU with at least 16 GiB VRAM, not T4")


def prepare_speech(job):
    script = job / "script.txt"
    if not script.is_file():
        raise ValueError("Missing speech script")
    content = script.read_text(encoding="utf-8").strip()
    if not content or len(content) > 300:
        raise ValueError("FlashHead preview requires 1-300 characters; speech is never truncated")
    speech = job / "speech.wav"
    if speech.exists():
        raise ValueError("Speech already exists; create a new job")
    subprocess.run(
        ["espeak-ng", "-v", "pl", "-s", "155", "-w", str(speech), "-f", str(script)],
        check=True, timeout=60,
    )
    with wave.open(str(speech), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
    if not 0 < duration <= 30:
        raise ValueError("Speech must be at most 30 seconds; shorten the script")
    return speech


def model_type():
    value = os.environ.get("NEXUS_FLASHHEAD_MODEL", "lite")
    if value not in ("lite", "pro"):
        raise ValueError("NEXUS_FLASHHEAD_MODEL must be lite or pro")
    return value


def inference_command(engine, job, portrait, speech, quality="lite"):
    if quality not in ("lite", "pro"):
        raise ValueError("FlashHead quality must be lite or pro")
    return [
        sys.executable, str(engine / "generate_video.py"),
        "--ckpt_dir", str(engine / "models/SoulX-FlashHead-1_3B"),
        "--wav2vec_dir", str(engine / "models/wav2vec2-base-960h"),
        "--model_type", quality, "--cond_image", str(portrait),
        "--audio_path", str(speech), "--audio_encode_mode", "stream",
        "--save_file", str(job / "video.mp4"),
    ]


def require_models(engine, quality="lite"):
    if quality not in ("lite", "pro"):
        raise ValueError("FlashHead quality must be lite or pro")
    required = (
        engine / "generate_video.py",
        engine / ("models/SoulX-FlashHead-1_3B/Model_Pro" if quality == "pro"
                  else "models/SoulX-FlashHead-1_3B/Model_Lite"),
        engine / ("models/SoulX-FlashHead-1_3B/VAE_Wan/Wan2.1_VAE.pth" if quality == "pro"
                  else "models/SoulX-FlashHead-1_3B/VAE_LTX"),
        engine / "models/wav2vec2-base-960h",
    )
    if any(not path.exists() for path in required):
        raise RuntimeError("FlashHead code/weights are missing; run cloud model setup first")


def render_job(job):
    require_cloud()
    job = Path(job).resolve()
    portraits = [path for path in (job / "portrait.png", job / "portrait.jpg") if path.is_file()]
    if len(portraits) != 1 or not (job / "script.txt").is_file():
        raise ValueError("Provide exactly one PNG/JPEG portrait and a speech script")
    if (job / "video.mp4").exists():
        raise ValueError("Video already exists; create a new job")
    engine = Path(os.environ.get("NEXUS_FLASHHEAD_DIR", "/opt/SoulX-FlashHead")).resolve()
    quality = model_type()
    require_models(engine, quality)
    import torch
    validate_gpu(torch)
    speech = prepare_speech(job)
    subprocess.run(inference_command(engine, job, portraits[0], speech, quality), cwd=engine,
                   env=dict(os.environ, MPLBACKEND="Agg"), check=True, timeout=1800)
    output = job / "video.mp4"
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("FlashHead did not produce a video")
    verify_video(str(output))
    (job / "engine.json").write_text(json.dumps({
        "engine": "soulx-flashhead-" + quality, "mode": "batch", "targetFps": 25,
        "upstreamCommit": "9bc03de06bb0de82cd6bc477804512ae06144bf2",
        "liveStream": False,
    }, indent=2), encoding="utf-8")


if __name__ == "__main__":
    require_cloud()
    if len(sys.argv) != 2:
        raise SystemExit("Usage: render_flashhead.py JOB_DIRECTORY")
    render_job(sys.argv[1])
