from __future__ import annotations

import asyncio
import hmac
import os
import time
import uuid
from typing import Optional

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from engine_registry import public_registry, registry

TOKEN = os.getenv("NEXUS_CLOUD_AVATAR_TOKEN", "").strip()
TIMEOUT = httpx.Timeout(connect=8.0, read=600.0, write=600.0, pool=30.0)

app = FastAPI(title="Nexus Avatar Cloud Orchestrator", version="0.1.0")


def _auth(auth: Optional[str], x_token: Optional[str]) -> None:
    if not TOKEN:
        raise HTTPException(503, "NEXUS_CLOUD_AVATAR_TOKEN is not configured")
    supplied = ""
    if auth and auth.lower().startswith("bearer "):
        supplied = auth[7:].strip()
    elif x_token:
        supplied = x_token.strip()
    if not supplied or not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(401, "Invalid Nexus cloud avatar token")


async def _engine_health(endpoint: str) -> dict:
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(endpoint.rstrip("/") + "/health")
        return {
            "ok": response.is_success,
            "status": response.status_code,
            "latencyMs": round((time.perf_counter() - started) * 1000, 1),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "latencyMs": round((time.perf_counter() - started) * 1000, 1),
            "error": str(exc)[:200],
        }


@app.get("/health")
async def health(
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _auth(authorization, x_nexus_token)
    specs = registry()
    active = [s for s in specs.values() if s.enabled]
    checks = await asyncio.gather(*[_engine_health(s.endpoint) for s in active])
    engines = []
    for spec, check in zip(active, checks):
        engines.append({**spec.public(), "health": check})
    return {
        "ok": any(e["health"]["ok"] for e in engines),
        "service": "nexus-avatar-cloud",
        "engines": engines,
    }


@app.get("/v1/engines")
async def engines(
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _auth(authorization, x_nexus_token)
    return {"engines": public_registry()}


async def _proxy_multipart(
    endpoint: str,
    route: str,
    files: dict,
    data: dict,
) -> Response:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        response = await client.post(endpoint.rstrip("/") + route, files=files, data=data)
    content_type = response.headers.get("content-type", "application/octet-stream")
    return Response(content=response.content, status_code=response.status_code, media_type=content_type)


@app.post("/v1/render/talking-head")
async def talking_head(
    source_image: UploadFile = File(...),
    audio: UploadFile = File(...),
    engine: str = Form(default="liveportrait"),
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _auth(authorization, x_nexus_token)
    specs = registry()
    spec = specs.get(engine)
    if not spec or not spec.enabled:
        raise HTTPException(400, f"Engine {engine!r} is unavailable")
    image_bytes, audio_bytes = await asyncio.gather(source_image.read(), audio.read())
    files = {
        "source_image": (source_image.filename or "source.png", image_bytes, source_image.content_type or "image/png"),
        "audio": (audio.filename or "speech.wav", audio_bytes, audio.content_type or "audio/wav"),
    }
    return await _proxy_multipart(spec.endpoint, "/v1/render", files, {})


@app.post("/v1/render/full-body")
async def full_body(
    source_image: UploadFile = File(...),
    audio: UploadFile = File(...),
    prompt: str = Form(default="natural conversational motion"),
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _auth(authorization, x_nexus_token)
    spec = registry()["echomimic"]
    if not spec.enabled:
        raise HTTPException(503, "Full-body engine disabled")
    image_bytes, audio_bytes = await asyncio.gather(source_image.read(), audio.read())
    files = {
        "source_image": (source_image.filename or "source.png", image_bytes, source_image.content_type or "image/png"),
        "audio": (audio.filename or "speech.wav", audio_bytes, audio.content_type or "audio/wav"),
    }
    return await _proxy_multipart(spec.endpoint, "/v1/render", files, {"prompt": prompt})


@app.post("/v1/render/lipsync")
async def lipsync(
    source_video: UploadFile = File(...),
    audio: UploadFile = File(...),
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _auth(authorization, x_nexus_token)
    spec = registry()["musetalk"]
    if not spec.enabled:
        raise HTTPException(503, "Lip-sync engine disabled")
    video_bytes, audio_bytes = await asyncio.gather(source_video.read(), audio.read())
    files = {
        "source_video": (source_video.filename or "source.mp4", video_bytes, source_video.content_type or "video/mp4"),
        "audio": (audio.filename or "speech.wav", audio_bytes, audio.content_type or "audio/wav"),
    }
    return await _proxy_multipart(spec.endpoint, "/v1/render", files, {})


@app.post("/v1/session")
async def create_session(
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _auth(authorization, x_nexus_token)
    # WebRTC transport will attach here in the next iteration. The session
    # contract is stable now so the Nexus client does not depend on a vendor.
    return JSONResponse({
        "ok": True,
        "sessionId": str(uuid.uuid4()),
        "transport": "http-fallback",
        "webrtc": False,
    })
