# Nexus Image Engine

Self-hosted text-to-image service for Nexus. The default free-first model is `SG161222/RealVisXL_V5.0_Lightning`, chosen for fast photorealistic SDXL generation without the Hugging Face access gate used by FLUX.1-schnell. Nexus calls the service through the local Agent Hub; there are no per-image API credits when the model runs on your own or rented GPU.

`black-forest-labs/FLUX.1-schnell` remains supported as an optional provider when the Hugging Face account used by the runtime has access to that gated repository.

## GPU target

The default RealVisXL profile is aimed at a CUDA GPU around 16–24 GB VRAM and should fit comfortably on an NVIDIA L4 24 GB without CPU offload. FLUX.1-schnell is heavier; CPU offload is enabled automatically for FLUX when `NEXUS_IMAGE_CPU_OFFLOAD=auto`.

Actual generation time and memory use depend on model revision, resolution, driver/CUDA stack and available system RAM.

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
export NEXUS_IMAGE_MODEL='SG161222/RealVisXL_V5.0_Lightning'
export NEXUS_IMAGE_MODEL_FAMILY='sdxl'
export NEXUS_IMAGE_CPU_OFFLOAD=0
```

Optional FLUX profile:

```bash
export NEXUS_IMAGE_MODEL='black-forest-labs/FLUX.1-schnell'
export NEXUS_IMAGE_MODEL_FAMILY='flux'
export NEXUS_IMAGE_CPU_OFFLOAD=auto
```

For FLUX, authenticate the runtime with a Hugging Face account that has accepted the model access conditions. Do not hard-code an HF token into the repository.

On the Agent Hub side set:

```bash
export NEXUS_IMAGE_SERVER_URL='http://127.0.0.1:8790'
export NEXUS_IMAGE_SERVER_TOKEN='replace-with-the-same-token'
```

If the GPU service runs on Colab or another remote machine, use a temporary/private tunnel protected by the Bearer token. Never expose an unauthenticated image endpoint to the public internet.

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
  -d '{"prompt":"A photorealistic woman sitting in an armchair, natural light","width":768,"height":1024,"steps":4}' \
  --output nexus-image.png
```

## Current MVP scope

Implemented: text-to-image, model-family routing for SDXL/FLUX, negative prompt support for SDXL, seed control, square/portrait/landscape sizes, lazy model loading, warm reuse, serialized GPU jobs, optional CPU offload and authenticated health/generation endpoints.

Validated in code: TypeScript build, image intent routing and Agent Hub binary proxy tests.

Still requires a real CUDA runtime test before being called GPU-ready. Identity lock, ControlNet/pose conditioning, inpainting/hand repair, background removal, automatic upscale and image-to-video handoff are later Creative Orchestrator phases and should only be marked ready after real end-to-end tests.
