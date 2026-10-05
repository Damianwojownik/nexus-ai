"""Finite, cloud-only test of the pinned FlashHead streaming inference path."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import wave

SOURCE_REVISION = "9bc03de06bb0de82cd6bc477804512ae06144bf2"
MODEL_REVISION = "59119b6c681230c3eeee157e224ae1941746711e"
AUDIO_MODEL_REVISION = "22aad52d435eb6dbaf354bdad9b0da84ce7d6156"


def validate_inputs(portrait, audio, expected_hash):
    if hashlib.sha256(portrait.read_bytes()).hexdigest() != expected_hash:
        raise ValueError("Original portrait SHA-256 mismatch")
    with wave.open(str(audio), "rb") as speech:
        if speech.getparams()[:3] != (1, 2, 16000) or speech.getcomptype() != "NONE":
            raise ValueError("Provide mono 16000 Hz PCM16 speech")
        duration = speech.getnframes() / speech.getframerate()
        if not 0.2 <= duration <= 30:
            raise ValueError("Provide 0.2-30 seconds; speech is never truncated")
        payload = speech.readframes(speech.getnframes())
    if not any(payload):
        raise ValueError("Speech is silent")
    return payload, duration


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", type=Path)
    parser.add_argument("portrait", type=Path)
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--reference-sha256", required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Use an authorized Linux cloud GPU worker")
    args.portrait = args.portrait.resolve()
    args.audio = args.audio.resolve()
    args.output = args.output.resolve()
    payload, duration = validate_inputs(args.portrait, args.audio, args.reference_sha256)
    engine = args.engine.resolve()
    actual = subprocess.check_output(["git", "-C", str(engine), "rev-parse", "HEAD"], text=True).strip()
    if actual != SOURCE_REVISION:
        raise RuntimeError("FlashHead source revision mismatch")
    pins = json.loads((engine / "models/nexus-model-pins.json").read_text())
    if pins != {"flashhead": MODEL_REVISION, "wav2vec2": AUDIO_MODEL_REVISION}:
        raise RuntimeError("FlashHead model revision manifest mismatch; run pinned setup")
    args.output.mkdir()
    os.chdir(engine)
    sys.path.insert(0, str(engine))
    os.environ["MPLBACKEND"] = "Agg"
    import imageio.v2 as imageio
    import numpy as np
    import torch
    from collections import deque
    from flash_head.inference import get_pipeline, get_base_data, get_infer_params, get_audio_embedding, run_pipeline
    from render_flashhead import validate_gpu

    validate_gpu(torch)
    startup = time.monotonic()
    pipeline = get_pipeline(
        world_size=1, model_type="lite",
        ckpt_dir=str(engine / "models/SoulX-FlashHead-1_3B"),
        wav2vec_dir=str(engine / "models/wav2vec2-base-960h"),
    )
    get_base_data(pipeline, str(args.portrait.resolve()), base_seed=42, use_face_crop=False)
    params = get_infer_params()
    torch.cuda.synchronize()
    startup_seconds = time.monotonic() - startup
    rate, fps = params["sample_rate"], params["tgt_fps"]
    if rate != 16000 or fps != 25:
        raise RuntimeError("Unsupported audio/frame rate in pinned FlashHead configuration")
    window = params["frame_num"]
    motion = params["motion_frames_num"]
    step = window - motion
    if step <= 0:
        raise RuntimeError("Invalid streaming inference window")
    quantum = step * rate // fps
    history_size = int(rate * params["cached_audio_duration"])
    end_index = int(params["cached_audio_duration"] * fps)
    history = deque([0.0] * history_size, maxlen=history_size)
    audio = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768
    expected = int(duration * fps)
    produced = 0
    measured_frames = 0
    chunks = []
    silent = args.output / "silent.mp4"
    with imageio.get_writer(str(silent), fps=fps, codec="libx264", quality=8, macro_block_size=None) as writer:
        for index, start in enumerate(range(0, len(audio), quantum)):
            block = audio[start:start + quantum]
            if len(block) < quantum:
                block = np.pad(block, (0, quantum - len(block)))
            history.extend(block.tolist())
            torch.cuda.synchronize()
            began = time.monotonic()
            embedding = get_audio_embedding(pipeline, np.asarray(history), end_index - window, end_index)
            video = run_pipeline(pipeline, embedding)[motion:]
            torch.cuda.synchronize()
            frames = video.to(torch.uint8).cpu().numpy()
            elapsed = time.monotonic() - began
            if len(frames) != step or frames.ndim != 4 or frames.shape[-1] != 3:
                raise RuntimeError("Invalid streaming model frame count/shape")
            measured_frames += len(frames)
            count = min(len(frames), expected - produced)
            for frame in frames[:count]:
                if float(frame.std()) < 1:
                    raise RuntimeError("Blank neural output")
                writer.append_data(frame)
            produced += count
            chunks.append({"index": index, "frames": len(frames), "processingSeconds": elapsed})
            print("STREAM_CHUNK", index, "frames", len(frames), "seconds", round(elapsed, 4), flush=True)
    if produced != expected:
        raise RuntimeError(f"Expected {expected} saved frames; received {produced}")
    subprocess.run([
        "ffmpeg", "-v", "error", "-n", "-i", str(silent), "-i", str(args.audio.resolve()),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
        "-shortest", "-movflags", "+faststart", str(args.output / "video.mp4"),
    ], check=True, timeout=180)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(args.output / "video.mp4"), "-f", "null", "-"], check=True, timeout=180)
    measured_seconds = sum(chunk["processingSeconds"] for chunk in chunks)
    report = {
        "engine": "soulx-flashhead-lite", "mode": "finite-streaming-path-benchmark",
        "sourceRevision": SOURCE_REVISION, "modelRevision": MODEL_REVISION, "audioModelRevision": AUDIO_MODEL_REVISION,
        "referenceSha256": args.reference_sha256,
        "audioSha256": hashlib.sha256(args.audio.read_bytes()).hexdigest(),
        "gpu": torch.cuda.get_device_name(0), "startupSeconds": startup_seconds,
        "nativeWidth": params["width"], "nativeHeight": params["height"],
        "inputQuantumMs": quantum / rate * 1000,
        "firstWarmChunkProcessingMs": chunks[0]["processingSeconds"] * 1000,
        "firstChunkLatencyLowerBoundMs": (quantum / rate + chunks[0]["processingSeconds"]) * 1000,
        "modelProcessingFpsIncludingAudioAndTransfer": measured_frames / measured_seconds,
        "savedFrames": produced, "fps": fps, "durationSeconds": duration, "chunks": chunks,
        "faceCrop": False, "inputReplay": True, "liveConversationReady": False,
        "visualApproval": False, "animalSupportVerified": False, "phonemeAlignmentVerified": False,
        "freeBackendVerified": False,
    }
    (args.output / "benchmark.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
