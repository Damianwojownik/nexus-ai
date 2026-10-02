from __future__ import annotations

import json
import os
import time
import uuid
from typing import Literal, Optional

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

REDIS_URL = os.getenv("NEXUS_VIDEO_REDIS_URL", "redis://redis:6379/0")
QUEUE_KEY = os.getenv("NEXUS_VIDEO_QUEUE", "nexus:video:jobs")
JOB_TTL_SECONDS = int(os.getenv("NEXUS_VIDEO_JOB_TTL", "604800"))

r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
app = FastAPI(title="Nexus Video Cloud", version="0.1.0")


class VideoRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    negative_prompt: str = ""
    mode: Literal["text-to-video", "image-to-video", "speech-to-video", "character-animate"] = "text-to-video"
    model: Literal["auto", "wan2.2", "hunyuanvideo"] = "auto"
    quality: Literal["preview", "high", "ultra"] = "high"
    width: int = Field(default=1280, ge=256, le=1920)
    height: int = Field(default=720, ge=256, le=1080)
    fps: int = Field(default=24, ge=8, le=60)
    duration_seconds: float = Field(default=5.0, ge=1.0, le=30.0)
    seed: Optional[int] = None
    image_url: Optional[str] = None
    audio_url: Optional[str] = None


def _job_key(job_id: str) -> str:
    return f"nexus:video:job:{job_id}"


def _save(job_id: str, data: dict) -> None:
    r.set(_job_key(job_id), json.dumps(data), ex=JOB_TTL_SECONDS)


def _load(job_id: str) -> dict:
    raw = r.get(_job_key(job_id))
    if not raw:
        raise HTTPException(404, "job_not_found")
    return json.loads(raw)


@app.get("/health")
def health():
    try:
        r.ping()
        redis_ok = True
    except Exception:
        redis_ok = False
    return {"ok": redis_ok, "queue": QUEUE_KEY}


@app.post("/v1/video/jobs", status_code=202)
def create_job(req: VideoRequest):
    if req.mode == "image-to-video" and not req.image_url:
        raise HTTPException(400, "image_url_required")
    if req.mode == "speech-to-video" and not req.audio_url:
        raise HTTPException(400, "audio_url_required")

    job_id = uuid.uuid4().hex
    now = time.time()
    job = {
        "id": job_id,
        "status": "queued",
        "progress": 0,
        "created_at": now,
        "updated_at": now,
        "request": req.model_dump(),
        "result": None,
        "error": None,
    }
    _save(job_id, job)
    r.rpush(QUEUE_KEY, job_id)
    return {"ok": True, "job_id": job_id, "status": "queued"}


@app.get("/v1/video/jobs/{job_id}")
def get_job(job_id: str):
    return _load(job_id)
