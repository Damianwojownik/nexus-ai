# Nexus Image Engine

Self-hosted text-to-image service for Nexus. The MVP uses `black-forest-labs/FLUX.1-schnell` and keeps the model warm between requests. Nexus calls it through the local Agent Hub; no per-image API credits are required when the model runs on your own/rented GPU.

## GPU target

The default profile is aimed at a CUDA GPU around 24 GB VRAM (for example an NVIDIA L4) with CPU offload enabled. Actual generation time and memory use depend on model revision, resolution, driver/CUDA stack and available system RAM.

## Install

Use an environment that already has a CUDA-compatible PyTorch build. Then install the service dependencies:

```bash
python -m pip install -r services/image_server/requirements.txt
```

Do not blindly reinstall PyTorch in Colab or another managed GPU image if a working CUDA build is already present.

## Configure

Set a strong token in both the image service and the Nexus Agent Hub environment:

```bash
export NEXUS_IMAGE_SERVER_TOKEN='replace-with-a-long-random-token'
export NEXUS_IMAGE_MODEL='black-forest-labs/FLUX.1-schnell'
export NEXUS_IMAGE_CPU_OFFLOAD=1
```

On the Agent Hub side also set:

```bash
export NEXUS_IMAGE_SERVER_URL='http://127.0.0.1:8790'
export NEXUS_IMAGE_SERVER_TOKEN='replace-with-the-same-token'
```

If the GPU service runs on another machine, use its private/VPN URL instead of exposing an unauthenticated endpoint to the public internet.

## Run

```bash
uvicorn services.image_server.nexus_image_server:app --host 127.0.0.1 --port 8790
```

Health:

```bash
curl -H "Authorization: Bearer $NEXUS_IMAGE_SERVER_TOKEN" http://127.0.0.1:8790/health
```

Generate:

```bash
curl -X POST http://127.0.0.1:8790/v1/generate \
  -H "Authorization: Bearer $NEXUS_IMAGE_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A photorealistic woman sitting in an armchair, natural light","width":1024,"height":1024,"steps":4}' \
  --output nexus-image.png
```

## Current MVP scope

Implemented: text-to-image, seed control, square/portrait/landscape sizes, lazy model loading, warm reuse, serialized GPU jobs, CPU offload and authenticated health/generation endpoints.

Not yet implemented/tested here: identity lock, ControlNet/pose conditioning, inpainting/hand repair, background removal, automatic upscale and image-to-video handoff. Those belong to the next Creative Orchestrator phases and should only be marked ready after real GPU tests.
