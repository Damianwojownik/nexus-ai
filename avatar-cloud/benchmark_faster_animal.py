"""Offline animal renderer benchmark; no automatic live/FREE backend."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
import wave

CODE_REVISION = "8aad3602177547aaa5e4beec0c3ef5b7944e7a1f"
ANIMAL_REVISION = "eb937f4bec7186598df2d1f68e1ddbb488ae1de5"


def validate_inputs(portrait: Path, audio: Path, reference_sha256: str) -> float:
    image = portrait.read_bytes()
    if not 0 < len(image) <= 5 * 1024 * 1024:
        raise ValueError("Portrait must contain 1 byte to 5 MB")
    if hashlib.sha256(image).hexdigest() != reference_sha256:
        raise ValueError("Character reference hash mismatch")
    if not image.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8")):
        raise ValueError("Portrait must be PNG or JPEG")
    with wave.open(str(audio), "rb") as source:
        if (source.getnchannels() != 1 or source.getsampwidth() != 2
                or source.getframerate() not in (16000, 24000)
                or source.getcomptype() != "NONE"):
            raise ValueError("Audio must be mono 16/24 kHz 16-bit PCM WAV")
        count = source.getnframes()
        duration = count / source.getframerate()
        if not 0.2 <= duration <= 30:
            raise ValueError("Audio must last 0.2-30 seconds")
        data = source.readframes(count)
    if len(data) != count * 2:
        raise ValueError("Audio WAV is truncated")
    samples = [value for (value,) in struct.iter_unpack("<h", data)]
    if max(samples) - min(samples) < 10:
        raise ValueError("Audio is silent or contains only a DC signal")
    return duration


def single_source_faces(source_infos: list[list[list[object]]]) -> list[list[object]]:
    if (len(source_infos) != 1 or len(source_infos[0]) != 1
            or len(source_infos[0][0]) != 10):
        raise RuntimeError("Expected one portrait and one complete animal face record")
    return source_infos[0]


def benchmark(repo: Path, output: Path, portrait: Path, audio: Path,
              reference_sha256: str, absolute_motion: bool = False) -> Path:
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Requires an authorized Linux GPU experiment")
    validate_inputs(portrait, audio, reference_sha256)
    revision = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True,
    ).strip()
    if revision != CODE_REVISION:
        raise RuntimeError("Unexpected FasterLivePortrait source revision")
    subprocess.run(["git", "-C", str(repo), "diff", "--exit-code", "--quiet"], check=True)
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source_image = output / ("portrait.png" if portrait.suffix.lower() == ".png" else "portrait.jpg")
    source_audio = output / "speech.wav"
    shutil.copyfile(portrait, source_image)
    shutil.copyfile(audio, source_audio)
    duration = validate_inputs(source_image, source_audio, reference_sha256)
    audio_sha256 = hashlib.sha256(source_audio.read_bytes()).hexdigest()
    start = time.perf_counter()
    sys.path.insert(0, str(repo))
    os.chdir(repo)
    os.environ["MPLBACKEND"] = "Agg"
    import numpy as np
    import torch
    from omegaconf import OmegaConf
    from PIL import Image
    from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline
    from src.pipelines.joyvasa_audio_to_motion_pipeline import JoyVASAAudio2MotionPipeline

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA renderer required; no automatic CPU fallback")
    torch.manual_seed(20261004)
    config = OmegaConf.load(repo / "configs" / "onnx_mp_infer.yaml")
    for unused in ("landmark", "face_analysis", "stitching_eye_retarget", "stitching_lip_retarget"):
        del config.animal_models[unused]
    weights = repo / "checkpoints" / "liveportrait_animal_onnx_v1.1"
    for name, model in config.animal_models.items():
        filename = "warping_spade-fix-v1.1.trt" if name == "warping_spade" else Path(model.model_path).stem + "-v1.1.trt"
        model.model_path = str(weights / filename)
        model.predict_type = "trt"
    config.infer_params.flag_relative_motion = not absolute_motion
    pipeline = FasterLivePortraitPipeline(config, is_animal=True)
    for name, model in pipeline.model_dict.items():
        if name != "xpose" and model.predictor.engine is None:
            raise RuntimeError(f"Model did not load on CUDA: {name}")
    if not pipeline.prepare_source(str(source_image)):
        raise RuntimeError("Animal source preparation failed; inspect the upstream traceback")
    if len(pipeline.src_imgs) != 1 or len(pipeline.src_infos[0]) != 1:
        raise RuntimeError("Expected one portrait and one animal face")
    motion_driver = JoyVASAAudio2MotionPipeline(
        motion_model_path=str(repo / config.joyvasa_models.motion_model_path),
        audio_model_path=str(repo / config.joyvasa_models.audio_model_path),
        motion_template_path=str(repo / config.joyvasa_models.motion_template_path),
        cfg_mode=config.infer_params.cfg_mode, cfg_scale=config.infer_params.cfg_scale,
    )
    torch.cuda.synchronize()
    startup_seconds = time.perf_counter() - start
    start = time.perf_counter()
    motion = motion_driver.gen_motion_sequence(str(source_audio))
    torch.cuda.synchronize()
    motion_seconds = time.perf_counter() - start
    fps = int(motion["output_fps"])
    poses = motion["motion"]
    if not poses or fps <= 0 or abs(len(poses) / fps - duration) > 0.1:
        raise RuntimeError("Motion duration does not match supplied speech")
    for pose in poses:
        if not all(np.isfinite(value).all() for value in pose.values()):
            raise RuntimeError("Motion generator returned non-finite values")
    source = pipeline.src_imgs[0]
    info = single_source_faces(pipeline.src_infos)
    for index in range(3):
        pipeline.run_with_pkl([poses[0], None, None], source, info, first_frame=index == 0)
    torch.cuda.synchronize()
    frames = []
    first_frame_seconds = 0.0
    start = time.perf_counter()
    for index, pose in enumerate(poses):
        _, frame = pipeline.run_with_pkl([pose, None, None], source, info, first_frame=index == 0)
        if frame.shape != source.shape or frame.dtype != np.uint8 or int(frame.max()) - int(frame.min()) < 1:
            raise RuntimeError(f"Invalid rendered frame: {index}")
        frames.append(frame)
        if index == 0:
            first_frame_seconds = time.perf_counter() - start
    torch.cuda.synchronize()
    drawing_seconds = time.perf_counter() - start
    if not any(np.any(frame != frames[0]) for frame in frames[1:]):
        raise RuntimeError("Renderer returned a static image")
    video = output / "video.mp4"
    height, width = source.shape[:2]
    with (output / "encode.log").open("wb") as log:
        process = subprocess.Popen([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{width}x{height}",
            "-framerate", str(fps), "-i", "pipe:0", "-i", str(source_audio),
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "fast",
            "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
            "-shortest", str(video),
        ], stdin=subprocess.PIPE, stderr=log)
        if process.stdin is None:
            raise RuntimeError("FFmpeg input pipe unavailable")
        try:
            for frame in frames:
                process.stdin.write(frame.tobytes())
        finally:
            process.stdin.close()
            return_code = process.wait(timeout=180)
        if return_code:
            raise RuntimeError(f"FFmpeg failed ({return_code}); inspect {output / 'encode.log'}")
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-f", "null", "-"], check=True, timeout=180)
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(video),
    ], text=True, timeout=180))
    videos = [stream for stream in probe["streams"] if stream["codec_type"] == "video"]
    audios = [stream for stream in probe["streams"] if stream["codec_type"] == "audio"]
    if (len(videos) != 1 or len(audios) != 1
            or int(videos[0]["nb_read_frames"]) != len(frames)
            or abs(float(videos[0]["duration"]) - duration) > 0.1
            or abs(float(audios[0]["duration"]) - duration) > 0.1):
        raise RuntimeError("Encoded audio/video duration or frame count mismatch")
    sheet = Image.new("RGB", (720, 600))
    for index in range(6):
        position = round(index * (len(frames) - 1) / 5)
        sheet.paste(Image.fromarray(frames[position]).resize((240, 300)), ((index % 3) * 240, (index // 3) * 300))
    sheet.save(output / "review.png")
    metadata = {
        "engine": "faster-liveportrait-animal-v1.1-joyvasa", "codeRevision": CODE_REVISION,
        "inferenceBackend": "tensorrt-8.6.1",
        "animalRevision": ANIMAL_REVISION, "referenceSha256": reference_sha256,
        "audioSha256": audio_sha256, "videoSha256": hashlib.sha256(video.read_bytes()).hexdigest(),
        "width": width, "height": height, "audioDurationSeconds": duration,
        "frames": len(frames), "fps": fps, "startupSeconds": startup_seconds,
        "audioToMotionSeconds": motion_seconds, "drawingSeconds": drawing_seconds,
        "drawingFpsExcludingStartupMotionAndEncoding": len(frames) / drawing_seconds,
        "meets25FpsDrawingTarget": len(frames) / drawing_seconds >= 25,
        "firstWarmDrawingFrameSeconds": first_frame_seconds,
        "absoluteMotion": absolute_motion, "visualApproval": False,
        "phonemeAlignmentVerified": False, "identityDriftVerified": False,
        "freeBackendVerified": False, "liveConversationReady": False,
    }
    (output / "benchmark.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata, indent=2))
    return video


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("portrait", type=Path)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--reference-sha256", required=True)
    parser.add_argument("--absolute-motion", action="store_true")
    args = parser.parse_args()
    video = benchmark(args.repo.resolve(), args.output, args.portrait, args.audio,
                      args.reference_sha256, args.absolute_motion)
    print("ANIMAL_BENCHMARK_READY", video)


if __name__ == "__main__":
    main()
