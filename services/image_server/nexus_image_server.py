from __future__ import annotations

import asyncio
import io
import os
import secrets
from typing import Optional, Union

import torch
from diffusers import EulerDiscreteScheduler, FluxPipeline, StableDiffusionXLPipeline
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

MODEL_ID = os.getenv("NEXUS_IMAGE_MODEL", "SG161222/RealVisXL_V5.0_Lightning").strip()
MODEL_FAMILY = os.getenv("NEXUS_IMAGE_MODEL_FAMILY", "auto").strip().lower()
SERVER_TOKEN = os.getenv("NEXUS_IMAGE_SERVER_TOKEN", "").strip()
CPU_OFFLOAD_SETTING = os.getenv("NEXUS_IMAGE_CPU_OFFLOAD", "auto").strip().lower()
ALLOW_CPU = os.getenv("NEXUS_IMAGE_ALLOW_CPU", "0") == "1"
MAX_SIDE = int(os.getenv("NEXUS_IMAGE_MAX_SIDE", "1536"))
DEFAULT_STEPS = int(os.getenv("NEXUS_IMAGE_STEPS", "4"))
DEFAULT_GUIDANCE = float(os.getenv("NEXUS_IMAGE_GUIDANCE", "1.5"))
DEFAULT_NEGATIVE_PROMPT = os.getenv(
    "NEXUS_IMAGE_NEGATIVE_PROMPT",
    "low quality, blurry, deformed anatomy, malformed hands, extra fingers, extra limbs, duplicate person, text, watermark",
)

app = FastAPI(title="Nexus Image Engine", version="0.2.0")
_pipeline: Optional[Union[FluxPipeline, StableDiffusionXLPipeline]] = None
_pipeline_family: Optional[str] = None
_pipeline_lock = asyncio.Lock()


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    negative_prompt: Optional[str] = Field(default=None, max_length=2000)
    width: int = 1024
    height: int = 1024
    steps: Optional[int] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not SERVER_TOKEN:
        raise HTTPException(status_code=503, detail="NEXUS_IMAGE_SERVER_TOKEN is not configured")
    if authorization != f"Bearer {SERVER_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def detect_model_family() -> str:
    if MODEL_FAMILY in {"flux", "sdxl"}:
        return MODEL_FAMILY
    model_lower = MODEL_ID.lower()
    if "flux" in model_lower:
        return "flux"
    return "sdxl"


def device_name() -> str:
    if torch.cuda.is_available():
        return torch.cuda.get_device_name(0)
    return "cpu"


def use_cpu_offload(family: str) -> bool:
    if CPU_OFFLOAD_SETTING in {"1", "true", "yes", "on"}:
        return True
    if CPU_OFFLOAD_SETTING in {"0", "false", "no", "off"}:
        return False
    return family == "flux"


def validate_request(request: GenerateRequest, family: str) -> tuple[int, float]:
    if request.width < 512 or request.height < 512 or request.width > MAX_SIDE or request.height > MAX_SIDE:
        raise HTTPException(status_code=400, detail=f"width and height must be between 512 and {MAX_SIDE}")
    if request.width % 16 or request.height % 16:
        raise HTTPException(status_code=400, detail="width and height must be divisible by 16")
    steps = request.steps if request.steps is not None else DEFAULT_STEPS
    max_steps = 4 if family == "flux" and "schnell" in MODEL_ID.lower() else 12
    if steps < 1 or steps > max_steps:
        raise HTTPException(status_code=400, detail=f"steps must be from 1 to {max_steps} for the configured model")
    if request.seed is not None and not 0 <= request.seed <= 2_147_483_647:
        raise HTTPException(status_code=400, detail="seed must be from 0 to 2147483647")
    guidance = request.guidance_scale
    if guidance is None:
        guidance = 0.0 if family == "flux" and "schnell" in MODEL_ID.lower() else DEFAULT_GUIDANCE
    if not 0 <= guidance <= 10:
        raise HTTPException(status_code=400, detail="guidance_scale must be from 0 to 10")
    if not torch.cuda.is_available() and not ALLOW_CPU:
        raise HTTPException(status_code=503, detail="CUDA GPU is required; set NEXUS_IMAGE_ALLOW_CPU=1 only for deliberate CPU testing")
    return steps, guidance


def load_pipeline() -> tuple[Union[FluxPipeline, StableDiffusionXLPipeline], str]:
    global _pipeline, _pipeline_family
    if _pipeline is not None and _pipeline_family is not None:
        return _pipeline, _pipeline_family

    if not torch.cuda.is_available() and not ALLOW_CPU:
        raise RuntimeError("CUDA GPU is required")

    family = detect_model_family()
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32

    if family == "flux":
        pipe: Union[FluxPipeline, StableDiffusionXLPipeline] = FluxPipeline.from_pretrained(
            MODEL_ID,
            torch_dtype=dtype,
        )
    else:
        pipe = StableDiffusionXLPipeline.from_pretrained(
            MODEL_ID,
            torch_dtype=dtype,
            use_safetensors=True,
        )
        # Lightning SDXL checkpoints are most reliable with trailing timesteps.
        pipe.scheduler = EulerDiscreteScheduler.from_config(
            pipe.scheduler.config,
            timestep_spacing="trailing",
        )

    pipe.set_progress_bar_config(disable=True)

    if torch.cuda.is_available():
        if use_cpu_offload(family):
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
    _pipeline_family = family
    return pipe, family


def render_image(request: GenerateRequest) -> tuple[bytes, int, int, float, str]:
    pipe, family = load_pipeline()
    steps, guidance = validate_request(request, family)
    seed = request.seed if request.seed is not None else secrets.randbelow(2_147_483_647)
    generator = torch.Generator(device="cpu").manual_seed(seed)

    kwargs = {
        "prompt": request.prompt.strip(),
        "width": request.width,
        "height": request.height,
        "num_inference_steps": steps,
        "guidance_scale": guidance,
        "generator": generator,
        "output_type": "pil",
    }
    if family == "sdxl":
        kwargs["negative_prompt"] = (request.negative_prompt or DEFAULT_NEGATIVE_PROMPT).strip()

    with torch.inference_mode():
        output = pipe(**kwargs)

    image = output.images[0]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), seed, steps, guidance, family


@app.get("/health")
async def health(_: None = Depends(require_token)) -> dict:
    gpu_available = torch.cuda.is_available()
    ready = gpu_available or ALLOW_CPU
    family = detect_model_family()
    return {
        "ok": ready,
        "provider": "nexus-self-hosted",
        "model": MODEL_ID,
        "family": family,
        "mode": "text-to-image",
        "device": device_name(),
        "loaded": _pipeline is not None,
        "cpuOffload": use_cpu_offload(family),
        "message": None if ready else "CUDA GPU is not available",
    }


@app.post("/v1/generate")
async def generate(request: GenerateRequest, _: None = Depends(require_token)) -> Response:
    async with _pipeline_lock:
        try:
            image_bytes, seed, steps, guidance, family = await asyncio.to_thread(render_image, request)
        except HTTPException:
            raise
        except torch.cuda.OutOfMemoryError as error:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            raise HTTPException(status_code=507, detail="GPU out of memory; lower the resolution or enable CPU offload") from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=f"Image generation failed: {error}") from error

    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Nexus-Model": MODEL_ID,
            "X-Nexus-Family": family,
            "X-Nexus-Seed": str(seed),
            "X-Nexus-Steps": str(steps),
            "X-Nexus-Guidance": str(guidance),
        },
    )
