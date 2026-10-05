from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
import uvicorn
import websockets
from fastapi import FastAPI, Header, HTTPException, WebSocket
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect, WebSocketState

LOG = logging.getLogger("nexus.live_avatar")

API_TOKEN = os.environ.get("NEXUS_LIVE_AVATAR_SERVER_TOKEN", "").strip()
WORKER_URL = os.environ.get("NEXUS_LIVE_AVATAR_WORKER_URL", "").strip().rstrip("/")
WORKER_TOKEN = os.environ.get("NEXUS_LIVE_AVATAR_WORKER_TOKEN", "").strip()
WORKER_CONTROL_HOSTS = {
    host.strip().lower()
    for host in os.environ.get("NEXUS_LIVE_AVATAR_WORKER_CONTROL_HOSTS", "").split(",")
    if host.strip()
}
HOST = os.environ.get("NEXUS_LIVE_AVATAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("NEXUS_LIVE_AVATAR_PORT", "9873"))
CONTROL_URL_BASE = os.environ.get(
    "NEXUS_LIVE_AVATAR_CONTROL_URL_BASE", f"ws://127.0.0.1:{PORT}"
).strip().rstrip("/")
ALLOWED_CONTROL_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("NEXUS_LIVE_AVATAR_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
SESSION_LIMIT = 16
SESSION_TTL_SECONDS = 30 * 60
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
LIBRARIAN_REFERENCE_SHA256 = "5810f3518ad5ac9a326ae720797c9c9117fb8160f94f00caeec019a260ea2e04"

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    sweeper = asyncio.create_task(_session_sweeper())
    try:
        yield
    finally:
        sweeper.cancel()
        await asyncio.gather(sweeper, return_exceptions=True)
        async with _sessions_lock:
            sessions = list(_sessions.values())
            _sessions.clear()
        for session in sessions:
            try:
                await _close_worker_session(session)
            except HTTPException as error:
                LOG.warning("Could not close live session during shutdown: %s", error.detail)


app = FastAPI(title="Nexus live avatar gateway", version="1.0.0", lifespan=_lifespan)


@dataclass
class Session:
    worker_id: str
    worker_control_url: str
    capability_hash: bytes
    created_at: float
    ice_servers: list[dict[str, Any]]
    offered: bool = False
    closing: bool = False


class SessionRequest(BaseModel):
    identity: dict[str, Any]


class OfferRequest(BaseModel):
    type: str
    sdp: str


_sessions: dict[str, Session] = {}
_sessions_lock = asyncio.Lock()


def _safe_base_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("Worker URL must be an absolute HTTP(S) URL without embedded credentials")
    if parts.query or parts.fragment:
        raise ValueError("Worker URL cannot contain a query or fragment")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Remote live workers must use HTTPS")
    return value.rstrip("/")


def _safe_control_url(value: Any) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=502, detail="Renderer omitted its control URL")
    parts = urlsplit(value)
    if parts.scheme not in ("ws", "wss") or not parts.hostname or parts.username or parts.password:
        raise HTTPException(status_code=502, detail="Renderer returned an invalid control URL")
    if parts.scheme == "ws" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(status_code=502, detail="Remote renderer control must use WSS")
    allowed_hosts = set(WORKER_CONTROL_HOSTS)
    worker_host = urlsplit(WORKER_URL).hostname
    if worker_host:
        allowed_hosts.add(worker_host.lower())
    if parts.hostname.lower() not in allowed_hosts:
        raise HTTPException(status_code=502, detail="Renderer control host is not in the worker allowlist")
    return value


def _safe_control_url_base() -> str:
    parts = urlsplit(CONTROL_URL_BASE)
    if (
        parts.scheme not in ("ws", "wss")
        or not parts.netloc
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise HTTPException(status_code=500, detail="NEXUS_LIVE_AVATAR_CONTROL_URL_BASE is invalid")
    if parts.scheme == "ws" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(status_code=500, detail="Remote browser control URLs must use WSS")
    return CONTROL_URL_BASE


def _allowed_control_origin(origin: str) -> bool:
    if not origin:
        return False
    normalized = origin.rstrip("/")
    if ALLOWED_CONTROL_ORIGINS:
        return normalized in ALLOWED_CONTROL_ORIGINS
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and parts.hostname in (
        "localhost", "127.0.0.1", "::1"
    )


def _worker_configured() -> bool:
    return bool(API_TOKEN and WORKER_URL and WORKER_TOKEN)


def _require_auth(authorization: str | None, x_nexus_token: str | None) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="NEXUS_LIVE_AVATAR_SERVER_TOKEN is not configured")
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    elif x_nexus_token:
        supplied = x_nexus_token.strip()
    if not supplied or not hmac.compare_digest(supplied, API_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid live avatar gateway token")


async def _worker_request(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float = 10,
) -> httpx.Response:
    if not _worker_configured():
        raise HTTPException(status_code=503, detail="A persistent neural renderer worker is not configured")
    try:
        base_url = _safe_base_url(WORKER_URL)
    except ValueError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if not path.startswith("/") or path.startswith("//"):
        raise HTTPException(status_code=500, detail="Invalid internal renderer path")
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        try:
            return await client.request(
                method,
                f"{base_url}{path}",
                json=payload,
                headers={"Authorization": f"Bearer {WORKER_TOKEN}"},
            )
        except httpx.HTTPError as error:
            LOG.warning("Live renderer worker request failed: %s", type(error).__name__)
            raise HTTPException(status_code=503, detail="Persistent neural renderer worker is unreachable") from error


async def _worker_json(
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float = 10,
) -> dict[str, Any]:
    response = await _worker_request(method, path, payload=payload, timeout=timeout)
    if not response.is_success:
        LOG.warning("Live renderer worker returned HTTP %d for %s", response.status_code, path)
        raise HTTPException(status_code=502, detail=f"Renderer worker HTTP {response.status_code}")
    try:
        body = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="Renderer worker returned invalid JSON") from error
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="Renderer worker returned an invalid response")
    return body


def _validate_identity(identity: dict[str, Any]) -> None:
    expected = {
        "id": "nexus-librarian",
        "referenceSha256": LIBRARIAN_REFERENCE_SHA256,
    }
    for key, value in expected.items():
        if identity.get(key) != value:
            raise HTTPException(status_code=400, detail=f"Unsupported live avatar identity field: {key}")
    for key in ("revision", "rigRevision"):
        value = identity.get(key)
        if not isinstance(value, str) or not value or len(value) > 128:
            raise HTTPException(status_code=400, detail=f"Invalid live avatar identity field: {key}")


async def _live_health() -> dict[str, Any]:
    if not _worker_configured():
        return {
            "available": False,
            "status": "NOT_CONFIGURED",
            "mode": "persistent-neural-stream",
            "provider": "nexus-live-avatar-gateway",
            "warm": False,
            "reason": "Configure a real persistent neural worker; no batch renderer is treated as live.",
        }
    try:
        worker = await _worker_json("GET", "/v1/live/health", timeout=5)
    except HTTPException as error:
        status = "DISCONNECTED" if error.status_code == 503 else "ERROR"
        return {
            "available": False,
            "status": status,
            "mode": "persistent-neural-stream",
            "provider": "nexus-live-avatar-gateway",
            "warm": False,
            "reason": error.detail,
        }
    if (
        worker.get("available") is True
        and worker.get("warm") is True
        and worker.get("mode") == "persistent-neural-stream"
    ):
        return {
            "available": True,
            "status": "AVAILABLE",
            "mode": "persistent-neural-stream",
            "provider": str(worker.get("provider", "persistent-neural-worker"))[:128],
            "warm": True,
        }
    return {
        "available": False,
        "status": "ERROR",
        "mode": str(worker.get("mode", ""))[:128],
        "provider": str(worker.get("provider", "persistent-neural-worker"))[:128],
        "warm": False,
        "reason": str(worker.get("reason", "Worker is not a warm persistent neural stream"))[:512],
    }


async def _close_worker_session(session: Session) -> None:
    response = await _worker_request("DELETE", f"/v1/live/sessions/{session.worker_id}", timeout=5)
    if response.status_code not in (200, 202, 204, 404):
        LOG.warning("Renderer worker session close returned HTTP %d", response.status_code)


async def _prune_expired_sessions() -> None:
    now = time.monotonic()
    expired: list[tuple[str, Session]] = []
    async with _sessions_lock:
        for session_id, session in tuple(_sessions.items()):
            if now - session.created_at > SESSION_TTL_SECONDS and not session.closing:
                session.closing = True
                expired.append((session_id, session))
    for session_id, session in expired:
        try:
            await _close_worker_session(session)
        except HTTPException as error:
            LOG.warning("Could not close expired renderer session: %s", error.detail)
        finally:
            async with _sessions_lock:
                _sessions.pop(session_id, None)


async def _session_sweeper() -> None:
    while True:
        await asyncio.sleep(30)
        await _prune_expired_sessions()


@app.get("/health")
@app.get("/v1/health")
@app.get("/v1/live/health")
async def health(
    authorization: str | None = Header(default=None),
    x_nexus_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(authorization, x_nexus_token)
    result = await _live_health()
    result["activeSessions"] = len(_sessions)
    return result


@app.post("/v1/live/sessions", status_code=201)
async def create_live_session(
    body: SessionRequest,
    authorization: str | None = Header(default=None),
    x_nexus_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(authorization, x_nexus_token)
    control_url_base = _safe_control_url_base()
    _validate_identity(body.identity)
    await _prune_expired_sessions()
    if not (await _live_health())["available"]:
        raise HTTPException(status_code=503, detail="A warm persistent neural renderer is unavailable")
    async with _sessions_lock:
        if len(_sessions) >= SESSION_LIMIT:
            raise HTTPException(status_code=429, detail="Live renderer session limit reached")

    worker = await _worker_json(
        "POST", "/v1/live/sessions", payload={"identity": body.identity}, timeout=15
    )
    worker_id = worker.get("sessionId")
    ice_servers = worker.get("iceServers", [])
    if not isinstance(worker_id, str) or not SESSION_ID_PATTERN.fullmatch(worker_id):
        raise HTTPException(status_code=502, detail="Renderer worker returned an invalid session ID")
    if not isinstance(ice_servers, list) or any(
        not isinstance(item, dict)
        or not (isinstance(item.get("urls"), str) or (
            isinstance(item.get("urls"), list)
            and all(isinstance(url, str) for url in item["urls"])
        ))
        for item in ice_servers
    ):
        await _worker_request("DELETE", f"/v1/live/sessions/{worker_id}", timeout=5)
        raise HTTPException(status_code=502, detail="Renderer worker returned invalid ICE servers")
    try:
        worker_control_url = _safe_control_url(worker.get("controlUrl"))
    except HTTPException:
        await _worker_request("DELETE", f"/v1/live/sessions/{worker_id}", timeout=5)
        raise
    capability = secrets.token_urlsafe(32)
    local_id = uuid.uuid4().hex
    session = Session(
        worker_id=worker_id,
        worker_control_url=worker_control_url,
        capability_hash=hashlib.sha256(capability.encode("utf-8")).digest(),
        created_at=time.monotonic(),
        ice_servers=ice_servers,
    )
    async with _sessions_lock:
        if len(_sessions) >= SESSION_LIMIT:
            await _worker_request("DELETE", f"/v1/live/sessions/{worker_id}", timeout=5)
            raise HTTPException(status_code=429, detail="Live renderer session limit reached")
        _sessions[local_id] = session

    control_url = f"{control_url_base}/v1/live/sessions/{local_id}/control?capability={capability}"
    return {"sessionId": local_id, "controlUrl": control_url, "iceServers": ice_servers}


@app.post("/v1/live/sessions/{session_id}/offer")
async def exchange_offer(
    session_id: str,
    body: OfferRequest,
    authorization: str | None = Header(default=None),
    x_nexus_token: str | None = Header(default=None),
) -> dict[str, str]:
    _require_auth(authorization, x_nexus_token)
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise HTTPException(status_code=404, detail="Live session not found")
    if body.type != "offer" or not body.sdp.strip() or len(body.sdp) > 256 * 1024:
        raise HTTPException(status_code=400, detail="A valid WebRTC offer SDP is required")
    async with _sessions_lock:
        session = _sessions.get(session_id)
        if session is None or session.closing:
            raise HTTPException(status_code=404, detail="Live session not found")
        if session.offered:
            raise HTTPException(status_code=409, detail="A WebRTC offer was already exchanged for this session")
        session.offered = True
    try:
        answer = await _worker_json(
            "POST",
            f"/v1/live/sessions/{session.worker_id}/offer",
            payload={"type": "offer", "sdp": body.sdp},
            timeout=15,
        )
    except Exception:
        async with _sessions_lock:
            session.offered = False
        raise
    if answer.get("type") != "answer" or not isinstance(answer.get("sdp"), str) or not answer["sdp"].strip():
        async with _sessions_lock:
            session.offered = False
        raise HTTPException(status_code=502, detail="Renderer worker returned an invalid WebRTC answer")
    return {"type": "answer", "sdp": answer["sdp"]}


@app.delete("/v1/live/sessions/{session_id}")
async def close_live_session(
    session_id: str,
    authorization: str | None = Header(default=None),
    x_nexus_token: str | None = Header(default=None),
) -> dict[str, bool]:
    _require_auth(authorization, x_nexus_token)
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise HTTPException(status_code=404, detail="Live session not found")
    async with _sessions_lock:
        session = _sessions.pop(session_id, None)
        if session is None:
            return {"ok": True}
        session.closing = True
    await _close_worker_session(session)
    return {"ok": True}


@app.websocket("/v1/live/sessions/{session_id}/control")
async def live_control(websocket: WebSocket, session_id: str) -> None:
    origin = websocket.headers.get("origin", "")
    capability = websocket.query_params.get("capability", "")
    async with _sessions_lock:
        session = _sessions.get(session_id)
    if (
        not session
        or session.closing
        or time.monotonic() - session.created_at > SESSION_TTL_SECONDS
        or not _allowed_control_origin(origin)
        or not capability
        or not hmac.compare_digest(
            session.capability_hash, hashlib.sha256(capability.encode("utf-8")).digest()
        )
    ):
        await websocket.close(code=1008)
        return

    try:
        async with websockets.connect(
            session.worker_control_url,
            additional_headers={"Authorization": f"Bearer {WORKER_TOKEN}"},
            open_timeout=10,
            close_timeout=3,
            max_size=1024 * 1024,
        ) as worker_socket:
            await websocket.accept()

            async def client_to_worker() -> None:
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if message.get("text") is not None:
                        await worker_socket.send(message["text"])
                    elif message.get("bytes") is not None:
                        await worker_socket.send(message["bytes"])

            async def worker_to_client() -> None:
                async for message in worker_socket:
                    if isinstance(message, str):
                        await websocket.send_text(message)
                    else:
                        await websocket.send_bytes(message)

            tasks = {
                asyncio.create_task(client_to_worker()),
                asyncio.create_task(worker_to_client()),
            }
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception) and not isinstance(
                    result, (WebSocketDisconnect, websockets.exceptions.ConnectionClosed)
                ):
                    raise result
    except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
        return
    except Exception as error:
        LOG.warning("Live control relay failed: %s", type(error).__name__)
        if websocket.application_state == WebSocketState.CONNECTED:
            await websocket.close(code=1011)


def main() -> None:
    parser = argparse.ArgumentParser(description="Nexus live avatar gateway for a persistent renderer worker")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    options = parser.parse_args()
    if "NEXUS_LIVE_AVATAR_CONTROL_URL_BASE" not in os.environ:
        global CONTROL_URL_BASE
        CONTROL_URL_BASE = f"ws://127.0.0.1:{options.port}"
    control_base = urlsplit(CONTROL_URL_BASE)
    if options.host not in ("127.0.0.1", "localhost", "::1") and (
        control_base.scheme != "wss" or not ALLOWED_CONTROL_ORIGINS
    ):
        parser.error("Public binds require a WSS control URL and explicit NEXUS_LIVE_AVATAR_ALLOWED_ORIGINS")
    uvicorn.run(app, host=options.host, port=options.port)


if __name__ == "__main__":
    main()
