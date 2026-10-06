from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from fractions import Fraction
from typing import Any
from urllib.parse import urlsplit

import av
import numpy as np
import uvicorn
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from fastapi import FastAPI, Header, HTTPException, WebSocket
from pydantic import BaseModel
from starlette.websockets import WebSocketDisconnect

from musetalk_engine import LIBRARIAN_SHA256, MUSETALK_UPSTREAM_COMMIT, MuseTalkEngine
from protocol import AudioPacket, ProtocolError, decode_audio_packet

LOG = logging.getLogger("nexus.live_worker")
logging.basicConfig(level=os.environ.get("NEXUS_LIVE_LOG_LEVEL", "INFO"))

HOST = os.environ.get("NEXUS_LIVE_WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("NEXUS_LIVE_WORKER_PORT", "9874"))
API_TOKEN = os.environ.get("NEXUS_LIVE_AVATAR_WORKER_TOKEN", "").strip()
CONTROL_URL_BASE = os.environ.get(
    "NEXUS_LIVE_WORKER_CONTROL_URL_BASE", f"ws://127.0.0.1:{PORT}"
).strip().rstrip("/")
MAX_SESSIONS = int(os.environ.get("NEXUS_LIVE_MAX_SESSIONS", "1"))
SESSION_TTL_SECONDS = int(os.environ.get("NEXUS_LIVE_SESSION_TTL_SECONDS", "1800"))
AUDIO_WINDOW_MS = int(os.environ.get("NEXUS_LIVE_AUDIO_WINDOW_MS", "480"))
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

engine = MuseTalkEngine()
sessions: dict[str, "LiveSession"] = {}
sessions_lock = asyncio.Lock()


class SessionRequest(BaseModel):
    identity: dict[str, Any]


class OfferRequest(BaseModel):
    type: str
    sdp: str


def require_auth(authorization: str | None) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="NEXUS_LIVE_AVATAR_WORKER_TOKEN is not configured")
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not hmac.compare_digest(supplied, API_TOKEN):
        raise HTTPException(status_code=401, detail="invalid live worker token")


def validate_identity(identity: dict[str, Any]) -> None:
    if identity.get("id") != "nexus-librarian":
        raise HTTPException(status_code=400, detail="worker supports only nexus-librarian")
    if identity.get("referenceSha256") != LIBRARIAN_SHA256:
        raise HTTPException(status_code=400, detail="Nexus identity reference hash mismatch")
    if not isinstance(identity.get("revision"), str) or not identity["revision"]:
        raise HTTPException(status_code=400, detail="missing Nexus identity revision")
    if not isinstance(identity.get("rigRevision"), str) or not identity["rigRevision"]:
        raise HTTPException(status_code=400, detail="missing Nexus rig revision")


def control_url(session_id: str) -> str:
    base = urlsplit(CONTROL_URL_BASE)
    if base.scheme not in ("ws", "wss") or not base.hostname or base.username or base.password:
        raise HTTPException(status_code=500, detail="NEXUS_LIVE_WORKER_CONTROL_URL_BASE is invalid")
    if base.scheme == "ws" and base.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(status_code=500, detail="remote live worker control URL must use WSS")
    return f"{CONTROL_URL_BASE}/v1/live/sessions/{session_id}/control"


def configured_ice_servers() -> tuple[list[RTCIceServer], list[dict[str, Any]]]:
    raw = os.environ.get("NEXUS_LIVE_ICE_SERVERS", "").strip()
    if not raw:
        return [], []
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="NEXUS_LIVE_ICE_SERVERS must be JSON") from exc
    if not isinstance(values, list):
        raise HTTPException(status_code=500, detail="NEXUS_LIVE_ICE_SERVERS must be a JSON array")
    rtc: list[RTCIceServer] = []
    public: list[dict[str, Any]] = []
    for item in values:
        if not isinstance(item, dict):
            raise HTTPException(status_code=500, detail="invalid ICE server entry")
        urls = item.get("urls")
        if not isinstance(urls, (str, list)):
            raise HTTPException(status_code=500, detail="ICE server urls are required")
        if isinstance(urls, list) and not all(isinstance(value, str) for value in urls):
            raise HTTPException(status_code=500, detail="ICE server urls must be strings")
        username = item.get("username")
        credential = item.get("credential")
        if username is not None and not isinstance(username, str):
            raise HTTPException(status_code=500, detail="ICE username must be a string")
        if credential is not None and not isinstance(credential, str):
            raise HTTPException(status_code=500, detail="ICE credential must be a string")
        rtc.append(RTCIceServer(urls=urls, username=username, credential=credential))
        public.append({
            "urls": urls,
            **({"username": username} if username is not None else {}),
            **({"credential": credential} if credential is not None else {}),
        })
    return rtc, public


class NexusVideoTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, owner: "LiveSession") -> None:
        super().__init__()
        self.owner = owner
        self.fps = engine.fps
        self.clock_rate = 90000
        self.step = round(self.clock_rate / self.fps)
        self.time_base = Fraction(1, self.clock_rate)
        self.started = time.monotonic()
        self.index = 0
        self.latest = engine.idle_frame()
        self.frames: asyncio.Queue[tuple[int, object]] = asyncio.Queue(maxsize=10)

    def push_frame(self, generation: int, frame: object) -> None:
        if generation != self.owner.generation or self.readyState != "live":
            return
        if self.frames.full():
            try:
                self.frames.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self.frames.put_nowait((generation, frame))
        except asyncio.QueueFull:
            pass
        if self.owner.first_neural_frame_ms is None:
            self.owner.first_neural_frame_ms = (time.monotonic() - self.owner.created_at) * 1000

    async def recv(self) -> av.VideoFrame:
        target = self.started + self.index / self.fps
        delay = target - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

        newest = None
        while True:
            try:
                generation, frame = self.frames.get_nowait()
                if generation == self.owner.generation:
                    newest = frame
            except asyncio.QueueEmpty:
                break

        if newest is not None:
            self.latest = newest
        elif self.owner.state != "SPEAKING":
            self.latest = engine.idle_frame()

        frame = av.VideoFrame.from_ndarray(np.asarray(self.latest), format="bgr24")
        frame.pts = self.index * self.step
        frame.time_base = self.time_base
        self.index += 1
        return frame


class LiveSession:
    def __init__(self, session_id: str, identity: dict[str, Any], rtc_ice: list[RTCIceServer]) -> None:
        self.id = session_id
        self.identity = identity
        self.rtc_ice = rtc_ice
        self.created_at = time.monotonic()
        self.state = "IDLE"
        self.emotion = "neutral"
        self.generation = 0
        self.pc: RTCPeerConnection | None = None
        self.video = NexusVideoTrack(self)
        self.audio_queue: asyncio.Queue[tuple[int, bytes]] = asyncio.Queue(maxsize=24)
        self.audio_buffer = bytearray()
        self.stream_id: str | None = None
        self.next_sequence = 0
        self.last_pts_ms = -1.0
        self.closed = False
        self.first_neural_frame_ms: float | None = None
        self.windows_rendered = 0
        self.render_task = asyncio.create_task(self._render_loop())
        self._loop = asyncio.get_running_loop()

    def _reset_stream(self, stream_id: str) -> None:
        self.generation += 1
        self.stream_id = stream_id
        self.next_sequence = 0
        self.last_pts_ms = -1.0
        self.audio_buffer.clear()
        while not self.audio_queue.empty():
            try:
                self.audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    def feed_packet(self, packet: AudioPacket) -> None:
        if self.closed:
            return
        if self.stream_id != packet.stream_id:
            if packet.sequence != 0:
                raise ProtocolError("new audio stream must begin with sequence 0")
            self._reset_stream(packet.stream_id)
        if packet.sequence != self.next_sequence:
            raise ProtocolError(
                f"audio sequence discontinuity: expected {self.next_sequence}, got {packet.sequence}"
            )
        if packet.pts_ms < self.last_pts_ms:
            raise ProtocolError("audio PTS moved backwards")
        self.next_sequence += 1
        self.last_pts_ms = packet.pts_ms
        self.audio_buffer.extend(packet.pcm16le)

        window_samples = round(16000 * AUDIO_WINDOW_MS / 1000)
        window_bytes = window_samples * 2
        while len(self.audio_buffer) >= window_bytes:
            payload = bytes(self.audio_buffer[:window_bytes])
            del self.audio_buffer[:window_bytes]
            if self.audio_queue.full():
                try:
                    self.audio_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            self.audio_queue.put_nowait((self.generation, payload))

    async def _render_loop(self) -> None:
        while not self.closed:
            try:
                generation, pcm = await self.audio_queue.get()
            except asyncio.CancelledError:
                return
            if generation != self.generation:
                continue

            def current() -> bool:
                return not self.closed and generation == self.generation

            def emit(frame: object) -> None:
                if not current():
                    return
                self._loop.call_soon_threadsafe(self.video.push_frame, generation, frame)

            try:
                frames = await asyncio.to_thread(engine.render_pcm, pcm, emit, current)
                if current() and frames:
                    self.windows_rendered += 1
            except asyncio.CancelledError:
                return
            except Exception:
                LOG.exception("MuseTalk live render window failed")
                if current():
                    self.state = "ERROR"

    async def interrupt(self) -> None:
        self.generation += 1
        self.audio_buffer.clear()
        self.stream_id = None
        self.next_sequence = 0
        self.last_pts_ms = -1.0
        while not self.audio_queue.empty():
            try:
                self.audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self.state = "INTERRUPTED"

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.generation += 1
        self.render_task.cancel()
        await asyncio.gather(self.render_task, return_exceptions=True)
        self.video.stop()
        if self.pc is not None:
            await self.pc.close()
            self.pc = None

    def metrics(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "emotion": self.emotion,
            "ageSeconds": round(time.monotonic() - self.created_at, 3),
            "firstNeuralFrameMs": None if self.first_neural_frame_ms is None
            else round(self.first_neural_frame_ms, 2),
            "windowsRendered": self.windows_rendered,
            "streamId": self.stream_id,
            "nextSequence": self.next_sequence,
        }


async def wait_for_ice_complete(pc: RTCPeerConnection, timeout: float = 8.0) -> None:
    if pc.iceGatheringState == "complete":
        return
    event = asyncio.Event()

    @pc.on("icegatheringstatechange")
    async def changed() -> None:
        if pc.iceGatheringState == "complete":
            event.set()

    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        LOG.warning("ICE gathering did not complete before timeout; returning current SDP")


async def expire_sessions() -> None:
    while True:
        await asyncio.sleep(30)
        now = time.monotonic()
        expired: list[tuple[str, LiveSession]] = []
        async with sessions_lock:
            for session_id, session in tuple(sessions.items()):
                if now - session.created_at > SESSION_TTL_SECONDS:
                    sessions.pop(session_id, None)
                    expired.append((session_id, session))
        for session_id, session in expired:
            LOG.info("expiring live session %s", session_id)
            await session.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await asyncio.to_thread(engine.load)
        LOG.info(
            "MuseTalk worker warm: load=%.0fms avatar=%.0fms gpu=%s",
            engine.metrics.model_load_ms,
            engine.metrics.avatar_prepare_ms,
            engine.gpu_info(),
        )
    except Exception:
        LOG.exception("MuseTalk worker started without a warm renderer")
    sweeper = asyncio.create_task(expire_sessions())
    try:
        yield
    finally:
        sweeper.cancel()
        await asyncio.gather(sweeper, return_exceptions=True)
        async with sessions_lock:
            remaining = list(sessions.values())
            sessions.clear()
        await asyncio.gather(*(session.close() for session in remaining), return_exceptions=True)


app = FastAPI(title="Nexus MuseTalk Live Worker", version="1.0.0", lifespan=lifespan)


@app.get("/v1/live/health")
async def health(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_auth(authorization)
    return {
        "available": engine.ready,
        "warm": engine.ready,
        "mode": "persistent-neural-stream",
        "provider": "nexus-musetalk-v1.5",
        "upstreamCommit": MUSETALK_UPSTREAM_COMMIT,
        "fpsTarget": engine.fps,
        "audioWindowMs": AUDIO_WINDOW_MS,
        "activeSessions": len(sessions),
        "modelLoadMs": round(engine.metrics.model_load_ms, 2),
        "avatarPrepareMs": round(engine.metrics.avatar_prepare_ms, 2),
        "warmupMs": round(engine.metrics.warmup_ms, 2),
        "lastNeuralFps": round(engine.metrics.last_render_fps, 2),
        "gpu": engine.gpu_info(),
        "visual": engine.visual_info() if engine.ready else {},
        **({"reason": engine.error} if not engine.ready and engine.error else {}),
    }


@app.post("/v1/live/sessions", status_code=201)
async def create_session(
    body: SessionRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_auth(authorization)
    validate_identity(body.identity)
    if not engine.ready:
        raise HTTPException(status_code=503, detail=engine.error or "MuseTalk worker is not warm")
    rtc_ice, public_ice = configured_ice_servers()
    async with sessions_lock:
        if len(sessions) >= MAX_SESSIONS:
            raise HTTPException(status_code=429, detail="live worker session limit reached")
        session_id = uuid.uuid4().hex
        session = LiveSession(session_id, dict(body.identity), rtc_ice)
        sessions[session_id] = session
    return {
        "sessionId": session_id,
        "controlUrl": control_url(session_id),
        "iceServers": public_ice,
    }


@app.post("/v1/live/sessions/{session_id}/offer")
async def exchange_offer(
    session_id: str,
    body: OfferRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    require_auth(authorization)
    if not SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(status_code=404, detail="live session not found")
    if body.type != "offer" or not body.sdp.strip() or len(body.sdp) > 262144:
        raise HTTPException(status_code=400, detail="valid WebRTC offer required")
    async with sessions_lock:
        session = sessions.get(session_id)
    if session is None or session.closed:
        raise HTTPException(status_code=404, detail="live session not found")
    if session.pc is not None:
        raise HTTPException(status_code=409, detail="WebRTC offer already exchanged")

    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=session.rtc_ice))
    session.pc = pc
    pc.addTrack(session.video)

    @pc.on("datachannel")
    def on_datachannel(channel) -> None:
        if channel.label != "nexus-live-audio":
            LOG.warning("ignoring unexpected data channel %s", channel.label)
            return

        @channel.on("message")
        def on_message(message) -> None:
            if not isinstance(message, (bytes, bytearray, memoryview)):
                return
            try:
                session.feed_packet(decode_audio_packet(message))
            except ProtocolError as exc:
                LOG.warning("invalid live audio packet for %s: %s", session.id, exc)

    @pc.on("connectionstatechange")
    async def connection_state() -> None:
        LOG.info("session %s WebRTC state=%s", session.id, pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            async with sessions_lock:
                sessions.pop(session.id, None)
            await session.close()

    await pc.setRemoteDescription(RTCSessionDescription(sdp=body.sdp, type="offer"))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await wait_for_ice_complete(pc)
    if not pc.localDescription:
        raise HTTPException(status_code=500, detail="WebRTC answer was not created")
    return {"type": "answer", "sdp": pc.localDescription.sdp}


@app.delete("/v1/live/sessions/{session_id}")
async def delete_session(
    session_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    require_auth(authorization)
    async with sessions_lock:
        session = sessions.pop(session_id, None)
    if session is not None:
        await session.close()
    return {"ok": True}


@app.get("/v1/live/sessions/{session_id}/metrics")
async def session_metrics(
    session_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_auth(authorization)
    async with sessions_lock:
        session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="live session not found")
    return {
        **session.metrics(),
        "renderer": {
            "lastRenderMs": round(engine.metrics.last_render_ms, 2),
            "lastRenderFrames": engine.metrics.last_render_frames,
            "lastNeuralFps": round(engine.metrics.last_render_fps, 2),
            "totalFrames": engine.metrics.total_frames,
        },
    }


@app.websocket("/v1/live/sessions/{session_id}/control")
async def control(websocket: WebSocket, session_id: str) -> None:
    authorization = websocket.headers.get("authorization")
    try:
        require_auth(authorization)
    except HTTPException:
        await websocket.close(code=1008)
        return
    async with sessions_lock:
        session = sessions.get(session_id)
    if session is None or session.closed:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive_text()
            try:
                event = json.loads(message)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "ERROR", "message": "invalid JSON"})
                continue
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                await websocket.send_json({"type": "ERROR", "message": "invalid control event"})
                continue
            kind = event["type"]
            if kind == "STATE":
                state = str(event.get("state", "IDLE"))
                if state not in {
                    "IDLE", "LISTENING", "THINKING", "SPEAKING",
                    "EXECUTING", "INTERRUPTED", "ERROR"
                }:
                    await websocket.send_json({"type": "ERROR", "message": "invalid state"})
                    continue
                session.state = state
                session.emotion = str(event.get("emotion", "neutral"))[:64]
                await websocket.send_json({"type": "STATE_ACK", "state": session.state})
            elif kind == "VISEME":
                # MuseTalk is audio-driven. Visemes are retained by Nexus for timing evidence,
                # but are intentionally not painted as a second mouth layer.
                await websocket.send_json({"type": "VISEME_ACK"})
            elif kind == "INTERRUPT":
                await session.interrupt()
                await websocket.send_json({"type": "INTERRUPTED"})
            elif kind == "CLOSE":
                await websocket.close(code=1000)
                return
            else:
                await websocket.send_json({"type": "ERROR", "message": "unsupported control event"})
    except WebSocketDisconnect:
        return


def main() -> None:
    if not API_TOKEN:
        raise SystemExit("Set NEXUS_LIVE_AVATAR_WORKER_TOKEN before starting the live worker")
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        if "NEXUS_LIVE_WORKER_CONTROL_URL_BASE" not in os.environ:
            raise SystemExit("Remote worker binds require NEXUS_LIVE_WORKER_CONTROL_URL_BASE=wss://<public-worker-host>")
        parsed = urlsplit(CONTROL_URL_BASE)
        if parsed.scheme != "wss" or not parsed.hostname:
            raise SystemExit("Remote worker control must use a public WSS URL")
    uvicorn.run(app, host=HOST, port=PORT, log_level=os.environ.get("NEXUS_LIVE_LOG_LEVEL", "info").lower())


if __name__ == "__main__":
    main()
