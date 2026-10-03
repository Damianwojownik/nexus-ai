from __future__ import annotations

import asyncio
import io
import os
import secrets
from typing import Optional

import torch
from diffusers import FluxPipeline
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

MODEL_ID = os.getenv("NEXUS_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell")
SERVER_TOKEN = os.getenv("NEXUS_IMAGE_SERVER_TOKEN", "").strip()
CPU_OFFLOAD = os.getenv("NEXUS_IMAGE_CPU_OFFLOAD", "1") != "0"
ALLOW_CPU = os.getenv("NEXUS_IMAGE_ALLOW_CPU", "0") == "1"
MAX_SIDE = int(os.getenv("NEXUS_IMAGE_MAX_SIDE", "1536"))

app = FastAPI(title="Nexus Image Engine", version="0.1.0")
_pipeline: Optional[FluxPipeline] = None
_pipeline_lock = asyncio.Lock()


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    width: int = 1024
    height: int = 1024
    steps: int = 4
    seed: Optional[int] = None
    guidance_scale: float = 0.0


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not SERVER_TOKEN:
        raise HTTPException(status_code=503, detail="NEXUS_IMAGE_SERVER_TOKEN is not configured")
    if authorization != f"Bearer {SERVER_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def device_name() -> str:
    if torch.cuda.is_available():
        return torch.cuda.get_device_name(0)
    return "cpu"


def validate_request(request: GenerateRequest) -> None:
    if request.width < 512 or request.height < 512 or request.width > MAX_SIDE or request.height > MAX_SIDE:
        raise HTTPException(status_code=400, detail=f"width and height must be between 512 and {MAX_SIDE}")
    if request.width % 16 or request.height % 16:
        raise HTTPException(status_code=400, detail="width and height must be divisible by 16")
    if request.steps < 1 or request.steps > 4:
        raise HTTPException(status_code=400, detail="FLUX.1-schnell steps must be from 1 to 4")
    if request.seed is not None and not 0 <= request.seed <= 2_147_483_647:
        raise HTTPException(status_code=400, detail="seed must be from 0 to 2147483647")
    if not 0 <= request.guidance_scale <= 10:
        raise HTTPException(status_code=400, detail="guidance_scale must be from 0 to 10")
    if not torch.cuda.is_available() and not ALLOW_CPU:
        raise HTTPException(status_code=503, detail="CUDA GPU is required; set NEXUS_IMAGE_ALLOW_CPU=1 only for deliberate CPU testing")


def load_pipeline() -> FluxPipeline:
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    if not torch.cuda.is_available() and not ALLOW_CPU:
        raise RuntimeError("CUDA GPU is required")

    if torch.cuda.is_available():
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    else:
        dtype = torch.float32

    pipe = FluxPipeline.from_pretrained(MODEL_ID, torch_dtype=dtype)
    pipe.set_progress_bar_config(disable=True)

    if torch.cuda.is_available():
        if CPU_OFFLOAD:
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")
    else:
        pipe.to("cpu")

    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()

    _pipeline = pipe
    return pipe


def render_image(request: GenerateRequest) -> tuple[bytes, int]:
    validate_request(request)
    pipe = load_pipeline()
    seed = request.seed if request.seed is not None else secrets.randbelow(2_147_483_647)
    generator = torch.Generator(device="cpu").manual_seed(seed)

    with torch.inference_mode():
        output = pipe(
            prompt=request.prompt.strip(),
            width=request.width,
            height=request.height,
            num_inference_steps=request.steps,
            guidance_scale=request.guidance_scale,
            generator=generator,
            output_type="pil",
        )
    image = output.images[0]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), seed


@app.get("/health")
async def health(_: None = Depends(require_token)) -> dict:
    gpu_available = torch.cuda.is_available()
    ready = gpu_available or ALLOW_CPU
    return {
        "ok": ready,
        "provider": "nexus-self-hosted",
        "model": MODEL_ID,
        "mode": "text-to-image",
        "device": device_name(),
        "loaded": _pipeline is not None,
        "message": None if ready else "CUDA GPU is not available",
    }


@app.post("/v1/generate")
async def generate(request: GenerateRequest, _: None = Depends(require_token)) -> Response:
    async with _pipeline_lock:
        try:
            image_bytes, seed = await asyncio.to_thread(render_image, request)
        except HTTPException:
            raise
        except torch.cuda.OutOfMemoryError as error:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            raise HTTPException(status_code=507, detail="GPU out of memory; lower the resolution or keep CPU offload enabled") from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=f"Image generation failed: {error}") from error

    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Nexus-Model": MODEL_ID,
            "X-Nexus-Seed": str(seed),
            "X-Nexus-Steps": str(request.steps),
        },
    )
