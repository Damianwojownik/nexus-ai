from __future__ import annotations

import argparse
import asyncio
import hmac
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.background import BackgroundTask
from fastapi.responses import FileResponse, JSONResponse

ROOT = Path(__file__).resolve().parents[2]
FLP_ROOT = Path(os.environ.get("FASTER_LIVEPORTRAIT_DIR", ROOT / "vendor" / "FasterLivePortrait")).resolve()
TOKEN = os.environ.get("NEXUS_AVATAR_SERVER_TOKEN", "").strip()

app = FastAPI(title="Nexus Avatar Server", version="1.0.0")
_pipeline = None
_pipeline_lock = asyncio.Lock()


def _authorized(authorization: Optional[str], x_nexus_token: Optional[str]) -> bool:
    if not TOKEN:
        return False
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    elif x_nexus_token:
        supplied = x_nexus_token.strip()
    return bool(supplied) and hmac.compare_digest(supplied, TOKEN)


def _require_auth(authorization: Optional[str], x_nexus_token: Optional[str]) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="NEXUS_AVATAR_SERVER_TOKEN is not configured")
    if not _authorized(authorization, x_nexus_token):
        raise HTTPException(status_code=401, detail="Invalid Nexus avatar server token")


def _check_installation() -> list[str]:
    missing = []
    for rel in ("configs/onnx_infer.yaml", "src/pipelines/gradio_live_portrait_pipeline.py", "checkpoints"):
        if not (FLP_ROOT / rel).exists():
            missing.append(rel)
    return missing


def _load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    missing = _check_installation()
    if missing:
        raise RuntimeError("FasterLivePortrait installation incomplete: " + ", ".join(missing))

    import sys
    if str(FLP_ROOT) not in sys.path:
        sys.path.insert(0, str(FLP_ROOT))

    previous_cwd = Path.cwd()
    os.chdir(FLP_ROOT)
    try:
        from omegaconf import OmegaConf
        from src.pipelines.gradio_live_portrait_pipeline import GradioLivePortraitPipeline

        cfg = OmegaConf.load(str(FLP_ROOT / "configs" / "onnx_infer.yaml"))
        cfg.infer_params.flag_pasteback = True
        _pipeline = GradioLivePortraitPipeline(cfg, is_animal=False)
        return _pipeline
    finally:
        os.chdir(previous_cwd)


async def _save_upload(upload: UploadFile, directory: Path, fallback_name: str) -> Path:
    suffix = Path(upload.filename or fallback_name).suffix
    if not suffix:
        suffix = Path(fallback_name).suffix
    path = directory / f"{fallback_name.rsplit('.', 1)[0]}{suffix}"
    with path.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    return path


def _cleanup(paths: list[Path]) -> None:
    for path in paths:
        try:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            elif path.exists():
                path.unlink(missing_ok=True)
        except Exception:
            pass


def _run_audio(source_image: Path, audio: Path) -> Path:
    pipe = _load_pipeline()
    previous_cwd = Path.cwd()
    os.chdir(FLP_ROOT)
    try:
        output, _preview, _elapsed = pipe.run_audio_driving(str(audio), str(source_image))
        return (FLP_ROOT / output).resolve() if not Path(output).is_absolute() else Path(output)
    finally:
        os.chdir(previous_cwd)


def _run_video(source_image: Path, driving_video: Path) -> Path:
    pipe = _load_pipeline()
    previous_cwd = Path.cwd()
    os.chdir(FLP_ROOT)
    try:
        output, _preview, _elapsed = pipe.run_video_driving(str(driving_video), str(source_image))
        return (FLP_ROOT / output).resolve() if not Path(output).is_absolute() else Path(output)
    finally:
        os.chdir(previous_cwd)


@app.get("/health")
@app.get("/v1/health")
async def health(
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _require_auth(authorization, x_nexus_token)
    missing = _check_installation()
    return {
        "ok": not missing,
        "provider": "faster-liveportrait",
        "mode": "onnx",
        "gpuPreferred": True,
        "installation": str(FLP_ROOT),
        "missing": missing,
        "pipelineLoaded": _pipeline is not None,
    }


async def _animate_impl(
    source_image: Optional[UploadFile],
    image: Optional[UploadFile],
    audio: Optional[UploadFile],
    driving_audio: Optional[UploadFile],
    driving_video: Optional[UploadFile],
    authorization: Optional[str],
    x_nexus_token: Optional[str],
):
    _require_auth(authorization, x_nexus_token)
    source = source_image or image
    speech = audio or driving_audio
    if source is None:
        raise HTTPException(status_code=400, detail="source_image (or image) is required")
    if speech is None and driving_video is None:
        raise HTTPException(status_code=400, detail="audio/driving_audio or driving_video is required")

    work = Path(tempfile.mkdtemp(prefix="nexus-avatar-"))
    source_path = await _save_upload(source, work, "source.png")
    cleanup_paths = [work]

    try:
        async with _pipeline_lock:
            if speech is not None:
                audio_path = await _save_upload(speech, work, "speech.wav")
                output_path = await asyncio.to_thread(_run_audio, source_path, audio_path)
            else:
                video_path = await _save_upload(driving_video, work, "driving.mp4")
                output_path = await asyncio.to_thread(_run_video, source_path, video_path)

        if not output_path.exists():
            raise RuntimeError("FasterLivePortrait did not produce an output video")
        cleanup_paths.append(output_path.parent)
        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="nexus-avatar.mp4",
            background=BackgroundTask(_cleanup, cleanup_paths),
            headers={"Cache-Control": "no-store"},
        )
    except HTTPException:
        _cleanup(cleanup_paths)
        raise
    except Exception as exc:
        _cleanup(cleanup_paths)
        return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)[:1000]})


@app.post("/animate")
@app.post("/v1/animate")
@app.post("/v1/render")
async def animate(
    source_image: Optional[UploadFile] = File(default=None),
    image: Optional[UploadFile] = File(default=None),
    audio: Optional[UploadFile] = File(default=None),
    driving_audio: Optional[UploadFile] = File(default=None),
    driving_video: Optional[UploadFile] = File(default=None),
    mode: str = Form(default="auto"),
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    del mode
    return await _animate_impl(
        source_image,
        image,
        audio,
        driving_audio,
        driving_video,
        authorization,
        x_nexus_token,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nexus self-hosted talking-avatar server")
    parser.add_argument("--host", default=os.environ.get("NEXUS_AVATAR_SERVER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("NEXUS_AVATAR_SERVER_PORT", "9872")))
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
