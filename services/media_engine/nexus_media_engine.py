from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = Path(__file__).resolve().parent
FLP_ROOT = Path(os.environ.get("FASTER_LIVEPORTRAIT_DIR", ROOT / "vendor" / "FasterLivePortrait")).resolve()
LTX_ROOT = Path(os.environ.get("LTX_VIDEO_DIR", ROOT / "vendor" / "LTX-Video")).resolve()
RUNTIME_ROOT = Path(os.environ.get("NEXUS_MEDIA_RUNTIME", ROOT / "runtime" / "media_engine")).resolve()
OUTPUT_ROOT = RUNTIME_ROOT / "outputs"
WORK_ROOT = RUNTIME_ROOT / "work"
LTX_CONFIG = Path(
    os.environ.get(
        "NEXUS_LTX_CONFIG",
        SERVICE_ROOT / "configs" / "ltxv-nexus-l4.yaml",
    )
).resolve()
TOKEN = os.environ.get("NEXUS_MEDIA_ENGINE_TOKEN", "").strip()

DEFAULT_BODY_PROMPT = (
    "A single uninterrupted, realistic 3.6-second medium portrait shot of the "
    "same person from the reference, preserving exact identity, clothing, "
    "proportions and framing. Natural direct eye contact, subtle breathing, "
    "a small natural nod, relaxed shoulders, gentle human body motion, stable "
    "camera and lighting, crisp details."
)
DEFAULT_NEGATIVE = (
    "blurry, smeared, soft face, identity change, exaggerated expression, "
    "static hands, frozen pose, jerky movement, flicker, camera movement, zoom, "
    "crop, extra arms, duplicated hands, extra fingers, missing fingers, "
    "deformed fingers, broken wrists, warped anatomy, changing clothes, "
    "changing background, text, watermark"
)

app = FastAPI(title="Nexus Media Engine — Miś TEST", version="1.0.0-test")
GPU_LOCK = asyncio.Lock()
JOBS: dict[str, dict[str, Any]] = {}

OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
WORK_ROOT.mkdir(parents=True, exist_ok=True)


def require_auth(authorization: Optional[str], x_nexus_token: Optional[str]) -> None:
    if not TOKEN:
        raise HTTPException(503, "NEXUS_MEDIA_ENGINE_TOKEN is not configured")
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    elif x_nexus_token:
        supplied = x_nexus_token.strip()
    if not supplied or not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(401, "Invalid Nexus media engine token")


def run_checked(cmd: list[str], cwd: Optional[Path] = None, timeout: int = 3600) -> str:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        tail = proc.stdout[-6000:] if proc.stdout else ""
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{tail}")
    return proc.stdout


def gpu_info() -> dict[str, Any]:
    try:
        raw = run_checked(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            timeout=10,
        ).strip().splitlines()[0]
        name, total, used, free, util = [part.strip() for part in raw.split(",")]
        return {
            "available": True,
            "name": name,
            "vramMiB": int(total),
            "usedMiB": int(used),
            "freeMiB": int(free),
            "utilizationPercent": int(util),
        }
    except Exception as exc:
        return {"available": False, "error": str(exc)[:300]}


def disk_info() -> dict[str, Any]:
    usage = shutil.disk_usage(RUNTIME_ROOT)
    gib = 1024 ** 3
    return {
        "totalGiB": round(usage.total / gib, 1),
        "usedGiB": round(usage.used / gib, 1),
        "freeGiB": round(usage.free / gib, 1),
    }


def nearest_valid_frames(frames: int) -> int:
    frames = max(9, min(241, int(frames)))
    n = round((frames - 1) / 8)
    return max(9, n * 8 + 1)


async def save_upload(upload: UploadFile, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        while chunk := await upload.read(1024 * 1024):
            handle.write(chunk)
    return path


def square_face_crop(source: Path, output: Path) -> Path:
    image = Image.open(source).convert("RGB")
    width, height = image.size
    side = min(width, height)
    left = max(0, (width - side) // 2)
    top = 0 if height >= width else max(0, (height - side) // 2)
    image.crop((left, top, left + side, top + side)).save(output, quality=96)
    return output


def make_face_mask(width: int, height: int, protect: float, feather: float, output: Path) -> Path:
    protect = min(0.8, max(0.15, protect))
    feather = min(0.3, max(0.01, feather))
    solid_end = int(height * protect)
    fade_end = min(height, solid_end + int(height * feather))
    mask = Image.new("L", (width, height), 0)
    pixels = mask.load()
    for y in range(height):
        if y < solid_end:
            value = 255
        elif y < fade_end:
            value = int(255 * (1 - (y - solid_end) / max(1, fade_end - solid_end)))
        else:
            value = 0
        for x in range(width):
            pixels[x, y] = value
    mask.save(output)
    return output


def run_flp(source: Path, audio: Path, output: Path) -> Path:
    worker = SERVICE_ROOT / "flp_worker.py"
    if not FLP_ROOT.exists():
        raise RuntimeError(f"FasterLivePortrait missing: {FLP_ROOT}")
    run_checked(
        [
            sys.executable,
            str(worker),
            "--flp-root",
            str(FLP_ROOT),
            "--source",
            str(source),
            "--audio",
            str(audio),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        timeout=1800,
    )
    if not output.exists():
        raise RuntimeError("FasterLivePortrait output missing")
    return output


def run_ltx(
    source: Optional[Path],
    prompt: str,
    negative_prompt: str,
    output_dir: Path,
    width: int,
    height: int,
    fps: int,
    frames: int,
    seed: int,
) -> Path:
    if not LTX_ROOT.exists():
        raise RuntimeError(f"LTX-Video missing: {LTX_ROOT}")
    if not LTX_CONFIG.exists():
        raise RuntimeError(f"LTX config missing: {LTX_CONFIG}")
    output_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        str(LTX_ROOT / "inference.py"),
        "--prompt",
        prompt,
        "--negative_prompt",
        negative_prompt,
        "--pipeline_config",
        str(LTX_CONFIG),
        "--output_path",
        str(output_dir),
        "--height",
        str(height),
        "--width",
        str(width),
        "--num_frames",
        str(nearest_valid_frames(frames)),
        "--frame_rate",
        str(fps),
        "--seed",
        str(seed),
        "--offload_to_cpu",
        "True",
    ]
    if source is not None:
        cmd += ["--input_media_path", str(source)]

    before = set(output_dir.glob("*.mp4"))
    run_checked(cmd, cwd=LTX_ROOT, timeout=3600)
    candidates = [p for p in output_dir.glob("*.mp4") if p not in before]
    if not candidates:
        candidates = list(output_dir.glob("*.mp4"))
    if not candidates:
        raise RuntimeError("LTX-Video output missing")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def composite_face_body(
    body: Path,
    face: Path,
    audio_source: Path,
    output: Path,
    width: int,
    height: int,
    fps: int,
    protect: float,
    feather: float,
) -> Path:
    mask = output.with_suffix(".mask.png")
    make_face_mask(width, height, protect, feather, mask)
    filter_complex = (
        f"[0:v]fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black[body];"
        f"[1:v]fps={fps},scale={width}:{width}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:0:black[face];"
        f"[2:v]format=gray[mask];"
        f"[face][mask]alphamerge[facea];"
        f"[body][facea]overlay=0:0:shortest=1[outv]"
    )
    run_checked(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(body),
            "-i",
            str(face),
            "-loop",
            "1",
            "-i",
            str(mask),
            "-filter_complex",
            filter_complex,
            "-map",
            "[outv]",
            "-map",
            "1:a?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "17",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            str(output),
        ],
        timeout=1200,
    )
    mask.unlink(missing_ok=True)
    if not output.exists():
        raise RuntimeError("Composite output missing")
    return output


async def render_avatar_pipeline(
    source: Path,
    audio: Path,
    prompt: str,
    negative_prompt: str,
    width: int,
    height: int,
    fps: int,
    frames: int,
    seed: int,
    protect: float,
    feather: float,
    work: Path,
    output: Path,
) -> Path:
    async with GPU_LOCK:
        face_source = square_face_crop(source, work / "face-source.png")
        face_video = await asyncio.to_thread(
            run_flp, face_source, audio, work / "face.mp4"
        )
        body_video = await asyncio.to_thread(
            run_ltx,
            source,
            prompt,
            negative_prompt,
            work / "ltx",
            width,
            height,
            fps,
            frames,
            seed,
        )
        return await asyncio.to_thread(
            composite_face_body,
            body_video,
            face_video,
            audio,
            output,
            width,
            height,
            fps,
            protect,
            feather,
        )


def file_url(request: Request, filename: str) -> str:
    return str(request.base_url).rstrip("/") + "/v1/files/" + filename


@app.get("/health")
@app.get("/v1/health")
async def health(
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    require_auth(authorization, x_nexus_token)
    return {
        "ok": True,
        "provider": "nexus-media-engine",
        "version": "1.0.0",
        "gpu": gpu_info(),
        "disk": disk_info(),
        "fasterLivePortrait": {
            "path": str(FLP_ROOT),
            "ready": (FLP_ROOT / "checkpoints").exists(),
        },
        "ltxVideo": {
            "path": str(LTX_ROOT),
            "ready": (LTX_ROOT / "inference.py").exists(),
            "config": str(LTX_CONFIG),
        },
        "defaults": {
            "width": 608,
            "height": 768,
            "fps": 25,
            "frames": 91,
            "guidance": 3.0,
            "steps": 30,
            "seed": 7,
            "faceProtect": 0.42,
            "feather": 0.10,
        },
    }


@app.post("/v1/avatar/render")
@app.post("/v1/render")
async def avatar_render(
    request: Request,
    source_image: UploadFile = File(...),
    audio: UploadFile = File(...),
    body_prompt: str = Form(default=DEFAULT_BODY_PROMPT),
    negative_prompt: str = Form(default=DEFAULT_NEGATIVE),
    width: int = Form(default=608),
    height: int = Form(default=768),
    fps: int = Form(default=25),
    num_frames: int = Form(default=91),
    seed: int = Form(default=7),
    face_protect: float = Form(default=0.42),
    feather: float = Form(default=0.10),
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    require_auth(authorization, x_nexus_token)
    width = min(1280, max(320, width))
    height = min(1280, max(320, height))
    fps = min(30, max(12, fps))

    job_id = uuid.uuid4().hex
    work = WORK_ROOT / job_id
    work.mkdir(parents=True, exist_ok=True)
    source_path = await save_upload(source_image, work / "source.png")
    audio_path = await save_upload(audio, work / "speech.wav")
    output = OUTPUT_ROOT / f"avatar-{job_id}.mp4"

    try:
        await render_avatar_pipeline(
            source_path,
            audio_path,
            body_prompt,
            negative_prompt,
            width,
            height,
            fps,
            num_frames,
            seed,
            face_protect,
            feather,
            work,
            output,
        )
        return FileResponse(
            output,
            media_type="video/mp4",
            filename="nexus-avatar.mp4",
            headers={
                "Cache-Control": "no-store",
                "X-Nexus-Engine": "flp+ltx+composite",
            },
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def run_video_job(job_id: str, payload: dict[str, Any], public_base: str) -> None:
    job = JOBS[job_id]
    job["status"] = "running"
    job["progress"] = 5
    work = WORK_ROOT / job_id
    work.mkdir(parents=True, exist_ok=True)
    try:
        source = None
        if payload.get("source_image_path"):
            source = Path(payload["source_image_path"])
        async with GPU_LOCK:
            job["progress"] = 15
            rendered = await asyncio.to_thread(
                run_ltx,
                source,
                str(payload.get("prompt") or ""),
                str(payload.get("negative_prompt") or DEFAULT_NEGATIVE),
                work / "ltx",
                int(payload.get("width") or 608),
                int(payload.get("height") or 768),
                int(payload.get("fps") or 25),
                int(payload.get("num_frames") or 91),
                int(payload.get("seed") or 7),
            )
            job["progress"] = 90
            final = OUTPUT_ROOT / f"video-{job_id}.mp4"
            shutil.copy2(rendered, final)
        job.update(
            {
                "status": "completed",
                "progress": 100,
                "result": {
                    "backend": "ltx-video-0.9.5",
                    "video_url": public_base.rstrip("/") + "/v1/files/" + final.name,
                },
            }
        )
    except Exception as exc:
        job.update({"status": "failed", "error": str(exc)[:3000]})
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.post("/v1/video/jobs")
async def create_video_job(
    request: Request,
    payload: dict[str, Any],
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    require_auth(authorization, x_nexus_token)
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {
        "id": job_id,
        "job_id": job_id,
        "status": "queued",
        "progress": 0,
        "created_at": time.time(),
        "result": None,
        "error": None,
    }
    public_base = str(request.base_url).rstrip("/")
    asyncio.create_task(run_video_job(job_id, payload, public_base))
    return JOBS[job_id]


@app.get("/v1/video/jobs/{job_id}")
async def video_job_status(
    job_id: str,
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    require_auth(authorization, x_nexus_token)
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return job


@app.get("/v1/files/{filename}")
async def media_file(
    filename: str,
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    require_auth(authorization, x_nexus_token)
    safe = Path(filename).name
    path = OUTPUT_ROOT / safe
    if not path.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("NEXUS_MEDIA_ENGINE_HOST", "0.0.0.0")
    port = int(os.environ.get("NEXUS_MEDIA_ENGINE_PORT", "9872"))
    uvicorn.run(app, host=host, port=port)
