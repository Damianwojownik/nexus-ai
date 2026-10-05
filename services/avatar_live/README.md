# Nexus live avatar backend

This service is the server-side contract for a warm persistent neural renderer.

It is intentionally fail-closed: if no configured renderer is available, the service
returns a structured `NOT_CONFIGURED` health status instead of pretending the avatar is
live. This keeps the browser UI honest and preserves the existing Paulina PCM + viseme
pipeline without generating a fake talking-head loop.

## Environment

Set these variables before starting the service:

```bash
NEXUS_LIVE_AVATAR_SERVER_URL=http://127.0.0.1:9873
NEXUS_LIVE_AVATAR_SERVER_TOKEN=replace-me
```

The backend answers the same contract expected by the local Agent Hub:

- `GET /health` and `GET /v1/health`
- `GET /v1/live/health`
- `POST /v1/live/sessions`
- `POST /v1/live/sessions/{id}/offer`
- `DELETE /v1/live/sessions/{id}`
- `WS /v1/live/sessions/{id}/control`

## Current status

This repository is still missing a real neural renderer. The service therefore exposes the
contract and blocks all session creation until a warm renderer is actually configured.

Use it as the integration point for a future FasterLivePortrait/RTSP/WebRTC renderer or a
hosted GPU worker.
