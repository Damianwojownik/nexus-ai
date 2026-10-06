# Nexus Live Worker — MuseTalk 1.5

This directory contains the missing **persistent neural renderer** for Nexus Live.
It is intentionally separate from the existing batch/Cinema renderers.

The live path is:

```text
Microsoft Paulina (local Windows)
  -> verified PCM16LE + native SAPI timing
  -> browser audio clock
  -> WebRTC DataChannel: nexus-live-audio
  -> Nexus MuseTalk Worker (warm GPU)
  -> MuseTalk 1.5 neural mouth/face frames
  -> WebRTC video track
  -> Nexus UI
```

No MP4 is created in the live path. The worker stays warm across turns, accepts
interrupts and drops stale generations after a barge-in.

## What is implemented

- pinned upstream MuseTalk 1.5 checkout
- pinned Nexus librarian identity SHA-256
- persistent model load and one-time reference preparation
- authenticated worker API
- real WebRTC SDP negotiation with `aiortc`
- ordered binary PCM DataChannel compatible with `helpers/neuralLiveAvatarProvider.ts`
- 16 kHz mono PCM validation, sequence validation and monotonic PTS
- continuous video track at a target 25 FPS
- bounded frame queues that prefer low latency over rendering stale frames
- `STATE`, `VISEME`, `INTERRUPT`, and `CLOSE` control messages
- health and per-session render metrics
- Linux, Windows and CUDA Docker installation paths

The current renderer modifies the talking face using audio and preserves the
canonical source frame outside the neural face blend. A single still reference
therefore produces a photorealistic **talking portrait**, not independently
generated full-body gestures. For Vidu-like body motion, use a visually approved
25 FPS base/idle video of the exact Nexus identity as the next quality layer;
do not regenerate a different person every turn.

## Hardware

The worker deliberately refuses CPU rendering. The default minimum is 10 GiB
VRAM. For production live use, benchmark an RTX 3090 24 GB first and an RTX 4090
24 GB when the 3090 cannot meet the latency/FPS target.

The local GTX 970 4 GB is suitable for the Nexus application, Agent Hub and
voice stack, but is not the production neural renderer target.

## Install on Linux GPU host

Prerequisites:

- NVIDIA driver compatible with CUDA 11.8 PyTorch wheels
- Python 3.10
- Git
- FFmpeg

Run:

```bash
chmod +x services/avatar_live_worker/install_linux.sh
services/avatar_live_worker/install_linux.sh
```

The installer:

1. clones the official MuseTalk repository into `.tools/MuseTalk`
2. checks out commit `0a89dec45a0192b824e3cf4daf96c239440c5ed8`
3. creates an isolated Python environment
4. installs the upstream CUDA/PyTorch and MMLab stack
5. installs the Nexus WebRTC worker
6. downloads the official MuseTalk 1.5 model assets
7. prints the detected CUDA GPU/VRAM

## Install on Windows

Python 3.10, Git and FFmpeg must already be available.

```powershell
powershell -ExecutionPolicy Bypass -File services\avatar_live_worker\install_windows.ps1
```

The worker itself will fail health when the GPU does not meet the configured
minimum. Installation success must not be reported as proof of realtime FPS.

## Run worker locally

Use a long random token. Never put this token in Vite/browser variables.

```powershell
$env:NEXUS_LIVE_AVATAR_WORKER_TOKEN = "<long-random-secret>"
$env:NEXUS_LIVE_WORKER_CONTROL_URL_BASE = "ws://127.0.0.1:9874"
powershell -ExecutionPolicy Bypass -File services\avatar_live_worker\start_windows.ps1
```

Linux:

```bash
export NEXUS_LIVE_AVATAR_WORKER_TOKEN='<long-random-secret>'
export NEXUS_LIVE_WORKER_CONTROL_URL_BASE='ws://127.0.0.1:9874'
services/avatar_live_worker/start_linux.sh
```

## Connect the existing Nexus gateway

For local worker + local gateway:

```text
NEXUS_LIVE_AVATAR_SERVER_URL=http://127.0.0.1:9873
NEXUS_LIVE_AVATAR_SERVER_TOKEN=<gateway-secret>
NEXUS_LIVE_AVATAR_WORKER_URL=http://127.0.0.1:9874
NEXUS_LIVE_AVATAR_WORKER_TOKEN=<worker-secret>
NEXUS_LIVE_AVATAR_CONTROL_URL_BASE=ws://127.0.0.1:9873
```

Start the existing gateway with:

```powershell
scripts\start-live-avatar-gateway-windows.ps1
```

Agent Hub keeps the gateway token server-side. The browser never receives the
worker token.

## Remote/cloud GPU

Build from the repository root:

```bash
docker build -f services/avatar_live_worker/Dockerfile -t nexus-live-musetalk .
```

A remote worker MUST be served through HTTPS/WSS. Example runtime variables:

```text
NEXUS_LIVE_AVATAR_WORKER_TOKEN=<server-only-secret>
NEXUS_LIVE_WORKER_HOST=0.0.0.0
NEXUS_LIVE_WORKER_PORT=9874
NEXUS_LIVE_WORKER_CONTROL_URL_BASE=wss://<worker-public-host>
NEXUS_LIVE_RENDER_FPS=25
NEXUS_LIVE_MAX_SESSIONS=1
```

If browser and worker cannot establish a direct ICE path, configure a STUN/TURN
service through `NEXUS_LIVE_ICE_SERVERS`. Do not call the deployment complete
until a remote browser receives a real video track.

When the cloud provider supplies a public IP, prefer a direct WebRTC-capable
network path. When it supplies only an HTTP reverse proxy, use TURN or a provider
network option that supports WebRTC; an HTTPS API proxy by itself does not carry
the neural video media.

## Health

```bash
curl -H "Authorization: Bearer $NEXUS_LIVE_AVATAR_WORKER_TOKEN" \
  http://127.0.0.1:9874/v1/live/health
```

A valid warm response has:

```json
{
  "available": true,
  "warm": true,
  "mode": "persistent-neural-stream",
  "provider": "nexus-musetalk-v1.5"
}
```

That response only means the model/reference loaded. Production readiness still
requires a real WebRTC session and measured FPS/latency.

## Metrics

`GET /v1/live/health` reports:

- model load time
- reference preparation time
- target FPS
- last measured neural FPS
- GPU/VRAM

`GET /v1/live/sessions/{sessionId}/metrics` additionally reports:

- first neural frame latency
- render windows
- current stream/sequence
- last render time and frame count

## Sync

The browser can reserve a 700 ms first-frame lead when a neural session is
connected. PCM is sent to the GPU **before** the matching browser audio is
scheduled. Audio sample position remains the authoritative PTS. This lead is a
temporary realtime buffer, not a claim that A/V offset is already calibrated.

Tune these after real GPU measurements:

```text
NEXUS_LIVE_AUDIO_WINDOW_MS=480
NEXUS_LIVE_RENDER_FPS=25
NEXUS_MUSETALK_BATCH_SIZE=8
```

Lower audio windows can reduce first-frame latency but may reduce neural
throughput/continuity. Do not tune by guesswork; record actual metrics.

## Acceptance test

Do not label the renderer Vidu-like or production-ready until all are observed
on the target cloud GPU:

1. same Nexus identity for at least five consecutive turns
2. current speech drives current mouth movement
3. first neural frame arrives before audible speech after the configured lead
4. sustained output video track at >= 20 FPS, target 25 FPS
5. neural inference keeps up with realtime
6. microphone barge-in clears stale audio/video promptly
7. WebRTC stays alive between turns
8. no MP4/CSS-mouth fallback is used as a success condition
9. visible A/V offset is measured and corrected
10. session cost is measured before enabling any automatic paid lifecycle

Exact proprietary Vidu quality cannot be asserted from source code. The target
is the same **interaction model** (continuous photorealistic person, live speech,
interruptible session); actual visual parity requires a GPU render comparison.
