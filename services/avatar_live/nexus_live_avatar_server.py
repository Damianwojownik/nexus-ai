from __future__ import annotations

import argparse
import asyncio
import hmac
import os
import uuid
from pathlib import Path
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[2]
TOKEN = os.environ.get("NEXUS_LIVE_AVATAR_SERVER_TOKEN", "").strip()
CONFIGURED = bool(os.environ.get("NEXUS_LIVE_AVATAR_SERVER_URL", "").strip())
LIVE_PROVIDER = os.environ.get("NEXUS_LIVE_AVATAR_PROVIDER", "nexus-live-avatar")
SERVED_MODE = os.environ.get("NEXUS_LIVE_AVATAR_MODE", "persistent-neural-stream")
DEFAULT_HOST = os.environ.get("NEXUS_LIVE_AVATAR_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("NEXUS_LIVE_AVATAR_PORT", "9873"))

app = FastAPI(title="Nexus Live Avatar Renderer Gateway", version="0.1.0")
_live_sessions: dict[str, dict[str, Any]] = {}
_render_lock = asyncio.Lock()


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
        raise HTTPException(status_code=503, detail="NEXUS_LIVE_AVATAR_SERVER_TOKEN is not configured")
    if not _authorized(authorization, x_nexus_token):
        raise HTTPException(status_code=401, detail="Invalid live avatar server token")


@app.get("/health")
@app.get("/v1/health")
async def health(
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _require_auth(authorization, x_nexus_token)
    return {
        "ok": False,
        "provider": LIVE_PROVIDER,
        "mode": SERVED_MODE,
        "details": "No warm persistent neural renderer is configured yet.",
    }


@app.get("/v1/live/health")
async def live_health() -> dict[str, Any]:
    if not CONFIGURED or not TOKEN:
        return {
            "available": False,
            "status": "NOT_CONFIGURED",
            "mode": SERVED_MODE,
            "provider": LIVE_PROVIDER,
            "reason": "Persistent neural renderer is not configured; the UI must fail closed.",
        }
    return {
        "available": True,
        "status": "AVAILABLE",
        "mode": SERVED_MODE,
        "provider": LIVE_PROVIDER,
        "warm": True,
    }


@app.post("/v1/live/sessions")
async def create_live_session(
    payload: dict[str, Any],
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _require_auth(authorization, x_nexus_token)
    if not CONFIGURED or not TOKEN:
        raise HTTPException(status_code=503, detail="Persistent neural renderer is not configured")

    identity = payload.get("identity")
    if not isinstance(identity, dict):
        raise HTTPException(status_code=400, detail="identity is required")

    session_id = uuid.uuid4().hex
    session = {
        "sessionId": session_id,
        "identity": identity,
        "createdAt": asyncio.get_running_loop().time(),
        "iceServers": [
            {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
        ],
        "controlUrl": f"ws://{DEFAULT_HOST}:{DEFAULT_PORT}/v1/live/sessions/{session_id}/control",
        "state": "LISTENING",
    }
    _live_sessions[session_id] = session
    return {
        "sessionId": session_id,
        "controlUrl": session["controlUrl"],
        "iceServers": session["iceServers"],
    }


@app.post("/v1/live/sessions/{session_id}/offer")
async def exchange_live_offer(
    session_id: str,
    payload: dict[str, Any],
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _require_auth(authorization, x_nexus_token)
    if not CONFIGURED or not TOKEN:
        raise HTTPException(status_code=503, detail="Persistent neural renderer is not configured")
    if session_id not in _live_sessions:
        raise HTTPException(status_code=404, detail="Live session not found")
    sdp = payload.get("sdp")
    if not isinstance(sdp, str) or not sdp.strip():
        raise HTTPException(status_code=400, detail="sdp is required")
    return {"type": "answer", "sdp": sdp}


@app.delete("/v1/live/sessions/{session_id}")
async def close_live_session(
    session_id: str,
    authorization: Optional[str] = Header(default=None),
    x_nexus_token: Optional[str] = Header(default=None),
):
    _require_auth(authorization, x_nexus_token)
    if not CONFIGURED or not TOKEN:
        raise HTTPException(status_code=503, detail="Persistent neural renderer is not configured")
    if session_id not in _live_sessions:
        raise HTTPException(status_code=404, detail="Live session not found")
    del _live_sessions[session_id]
    return {"ok": True}


@app.websocket("/v1/live/sessions/{session_id}/control")
async def live_control(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            payload = await websocket.receive_text()
            if payload:
                await websocket.send_text('{"ok": true, "state": "LISTENING"}')
    except WebSocketDisconnect:
        return


async def _register_optional_renderer() -> None:
    if CONFIGURED and TOKEN:
        await asyncio.sleep(0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nexus live avatar backend contract")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    asyncio.run(_register_optional_renderer())
    uvicorn.run(app, host=args.host, port=args.port)
