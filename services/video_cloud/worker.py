from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx
import redis

REDIS_URL = os.getenv("NEXUS_VIDEO_REDIS_URL", "redis://redis:6379/0")
QUEUE_KEY = os.getenv("NEXUS_VIDEO_QUEUE", "nexus:video:jobs")
JOB_TTL_SECONDS = int(os.getenv("NEXUS_VIDEO_JOB_TTL", "604800"))

WAN_URL = os.getenv("NEXUS_VIDEO_WAN_URL", "").rstrip("/")
HUNYUAN_URL = os.getenv("NEXUS_VIDEO_HUNYUAN_URL", "").rstrip("/")
REQUEST_TIMEOUT = float(os.getenv("NEXUS_VIDEO_WORKER_TIMEOUT", "1800"))

r = redis.Redis.from_url(REDIS_URL, decode_responses=True)


def job_key(job_id: str) -> str:
    return f"nexus:video:job:{job_id}"


def load(job_id: str) -> dict[str, Any]:
    raw = r.get(job_key(job_id))
    if not raw:
        raise RuntimeError("job_not_found")
    return json.loads(raw)


def save(job: dict[str, Any]) -> None:
    job["updated_at"] = time.time()
    r.set(job_key(job["id"]), json.dumps(job), ex=JOB_TTL_SECONDS)


def select_backend(req: dict[str, Any]) -> tuple[str, str]:
    requested = req.get("model", "auto")
    mode = req.get("mode", "text-to-video")

    if requested == "wan2.2":
        if not WAN_URL:
            raise RuntimeError("wan2.2_backend_not_configured")
        return "wan2.2", WAN_URL

    if requested == "hunyuanvideo":
        if not HUNYUAN_URL:
            raise RuntimeError("hunyuan_backend_not_configured")
        return "hunyuanvideo", HUNYUAN_URL

    if mode in ("speech-to-video", "character-animate") and WAN_URL:
        return "wan2.2", WAN_URL
    if HUNYUAN_URL:
        return "hunyuanvideo", HUNYUAN_URL
    if WAN_URL:
        return "wan2.2", WAN_URL
    raise RuntimeError("no_video_backend_configured")


def run_remote(base_url: str, payload: dict[str, Any]) -> dict[str, Any]:
    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        response = client.post(f"{base_url}/generate", json=payload)
        response.raise_for_status()
        data = response.json()
    if not data.get("video_url"):
        raise RuntimeError("backend_missing_video_url")
    return data


def process(job_id: str) -> None:
    job = load(job_id)
    job["status"] = "running"
    job["progress"] = 5
    save(job)

    try:
        backend_name, backend_url = select_backend(job["request"])
        payload = {**job["request"], "job_id": job_id}
        result = run_remote(backend_url, payload)
        job["status"] = "completed"
        job["progress"] = 100
        job["result"] = {
            "backend": backend_name,
            "video_url": result["video_url"],
            "poster_url": result.get("poster_url"),
            "metadata": result.get("metadata", {}),
        }
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)[:1000]
    save(job)


def main() -> None:
    while True:
        item = r.blpop(QUEUE_KEY, timeout=5)
        if not item:
            continue
        _, job_id = item
        process(job_id)


if __name__ == "__main__":
    main()
