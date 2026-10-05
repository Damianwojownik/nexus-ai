# Nexus live avatar gateway

This service is an authenticated gateway between the local Agent Hub and a **separate,
already-running persistent neural renderer worker**. It proxies the worker's real health,
session, SDP-answer, and WebSocket control operations. WebRTC media travels between the
browser and worker directly; PCM audio is sent over the provider's ordered DataChannel.

The gateway is not itself an avatar renderer. Health only reports available when the
configured worker explicitly reports `available: true`, `warm: true`, and
`mode: "persistent-neural-stream"`. It never turns the existing FasterLivePortrait
`run_audio_driving(...) -> MP4` batch API into a live service.

## Worker contract

The worker must provide authenticated endpoints:

- `GET /v1/live/health` returning `available`, `warm`, and
  `mode: "persistent-neural-stream"`
- `POST /v1/live/sessions` accepting the pinned identity and returning a worker session ID,
  an authenticated control WebSocket URL, and ICE servers
- `POST /v1/live/sessions/{id}/offer` doing actual WebRTC SDP negotiation and returning a
  valid SDP answer with a continuously produced neural video track
- `WS /v1/live/sessions/{id}/control` consuming state, viseme, and interrupt events
- `DELETE /v1/live/sessions/{id}` releasing the session

The worker loads its model and the fixed identity before reporting warm. It must consume
PCM16LE audio and `ptsMs` from the Nexus DataChannel, preserve the supplied identity, and
produce frames incrementally. The DataChannel is named `nexus-live-audio`; each binary
message begins with a 4-byte big-endian JSON-header length, then a JSON header with
`type: "AUDIO"`, `streamId`, `sequence`, `ptsMs`, `encoding: "PCM16LE"`, `sampleRate`,
`channels`, and `byteLength`, followed by the PCM bytes. Control WebSocket messages use
`STATE`, `VISEME`, `INTERRUPT`, and `CLOSE` with audio-clock `ptsMs`. The browser does not
send the gateway or worker credentials. The gateway keeps a short-lived per-session
capability for its local control WebSocket.

## Local Windows gateway

Install Python 3.11. In the Agent Hub process set `NEXUS_LIVE_AVATAR_SERVER_URL` and
`NEXUS_LIVE_AVATAR_SERVER_TOKEN`. In the gateway process, set the same token plus its worker
URL/token and run from the repository root:

```powershell
$env:NEXUS_LIVE_AVATAR_SERVER_URL = "http://127.0.0.1:9873"
$env:NEXUS_LIVE_AVATAR_SERVER_TOKEN = "<same-long-random-token-for-Agent-Hub-and-gateway>"
$env:NEXUS_LIVE_AVATAR_WORKER_URL = "https://<your-real-worker-host>"
$env:NEXUS_LIVE_AVATAR_WORKER_TOKEN = "<worker-token>"
# Only needed if the worker returns a control WebSocket on another host.
$env:NEXUS_LIVE_AVATAR_WORKER_CONTROL_HOSTS = "<worker-control-host>"
$env:NEXUS_LIVE_AVATAR_CONTROL_URL_BASE = "ws://127.0.0.1:9873"
scripts\start-live-avatar-gateway-windows.ps1
```

The launcher creates `services/avatar_live/.venv` and installs only this gateway's
dependencies. Without a reachable warm worker it will report `NOT_CONFIGURED` or
`DISCONNECTED` and reject session creation; Nexus will continue to display its verified
static portrait rather than a fake animation.

## GPU and hosted deployment

The gateway Docker image is built from the repository root:

```bash
docker build -f services/avatar_live/Dockerfile -t nexus-live-avatar-gateway .
docker run --rm -p 9873:9873 \
  -e NEXUS_LIVE_AVATAR_SERVER_TOKEN \
  -e NEXUS_LIVE_AVATAR_WORKER_URL \
  -e NEXUS_LIVE_AVATAR_WORKER_TOKEN \
  -e NEXUS_LIVE_AVATAR_HOST=0.0.0.0 \
  -e NEXUS_LIVE_AVATAR_CONTROL_URL_BASE=wss://<gateway-host> \
  -e NEXUS_LIVE_AVATAR_ALLOWED_ORIGINS=https://<nexus-frontend-origin> \
  nexus-live-avatar-gateway
  ```

Terminate TLS at a trusted reverse proxy for hosted deployments and proxy the control
WebSocket as well as HTTP. The worker's WebRTC ICE candidates/media ports must be reachable
from the browser; add TURN only when the network requires it. Do not publish the worker
token to the browser or commit it to Git. GPU type, model compatibility, render latency,
FPS, and A/V offset belong to the worker deployment and must be measured there.
Run one gateway process/replica unless session state is moved to a shared store and control
connections are routed consistently.

The existing local GTX 970 reports 4 GB VRAM. This repo's FasterLivePortrait setup script
installs its batch/ONNX bridge and is not evidence that this card can run a warm low-latency
neural stream. No GPU worker is bundled or configured in this checkout; a compatible worker
must be supplied and tested before live can report available.
