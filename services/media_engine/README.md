# Nexus Media Engine — Colab L4 profile

Own GPU backend for Nexus avatars and cinematic video. The reference machine is Google Colab Pro with NVIDIA L4 (~22.5 GB VRAM), ~53 GB system RAM and ~235.7 GB runtime disk.

## Architecture

- FasterLivePortrait: audio-driven face and mouth.
- LTX-Video 0.9.5: body motion / cinematic image-to-video.
- Nexus compositor: protects the upper 42% of the frame and blends over a 10% feather zone so the sharp FLP face survives the body render.
- One GPU lock: FLP and LTX are executed sequentially, not simultaneously. Each heavy stage runs in a child process so VRAM is released before the next stage.
- ffmpeg: final MP4 composition and audio mux.
- FastAPI: health, avatar render and video-job API.

Default L4 render profile:
- 608×768
- 25 fps
- requested 91 frames (normalized by LTX to the closest valid 8n+1 frame count)
- 30 inference steps
- guidance 3.0
- seed 7
- face protect 42%
- feather 10%

## Colab start

In a fresh Colab GPU runtime:

```bash
!git clone -b nexus/media-engine-v1-20261003 https://github.com/Damianwojownik/nexus-ai.git /content/nexus-ai
!bash /content/nexus-ai/services/media_engine/colab_l4_bootstrap.sh
```

The bootstrap prints a random `NEXUS_MEDIA_ENGINE_TOKEN`. Keep it secret. The service listens on port 9872.

To expose the Colab service to Nexus, use an HTTPS tunnel (Cloudflare Tunnel/ngrok) and configure the Nexus app with:
- `NEXUS_AVATAR_SERVER_URL=https://<tunnel-host>`
- `NEXUS_AVATAR_SERVER_TOKEN=<same token>`
- `NEXUS_VIDEO_SERVER_URL=https://<tunnel-host>`
- `NEXUS_VIDEO_SERVER_TOKEN=<same token>`

Do not commit the token.

## API

Authenticated with `Authorization: Bearer <token>` or `X-Nexus-Token`.

- `GET /health` or `GET /v1/health`
- `POST /v1/avatar/render` (multipart: `source_image`, `audio`, optional body prompt/settings) -> MP4
- `POST /v1/render` alias for avatar render
- `POST /v1/video/jobs` -> queued LTX job
- `GET /v1/video/jobs/{id}`
- `GET /v1/files/{filename}`

## Important

The code path is designed for the confirmed L4/53 GB RAM Colab profile, but GPU execution still needs to be validated in the actual Colab runtime because Colab changes CUDA/Python packages over time. The health endpoint exposes GPU and disk state so incompatibilities are visible rather than silently hidden.
