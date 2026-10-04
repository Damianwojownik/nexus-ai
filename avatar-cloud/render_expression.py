"""Cloud-only masked facial editing of an existing, immutable body-motion video."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

from expression_edit import preserve_motion_frame, read_expression_inputs
from render_body import prompt_file

MODEL = "Wan-AI/Wan2.1-VACE-1.3B-diffusers"
REVISION = "ec4d2cb062b548996b179d493fdd05340de702a1"
PROMPT = (
    "The silver female android briefly closes both eyelids in a single quick blink "
    "and immediately reopens her green eyes, then gives a tiny closed-mouth smile. "
    "Her identity, head pose, robotic facial structure and lighting stay unchanged."
)
NEGATIVE = (
    "different face, human skin, extra eyes, asymmetric eyes, blurry face, distorted mouth, "
    "open mouth, teeth, broad grin, prolonged eye closure"
)


def check_expression_step(pipeline, step, timestep, state):
    if not state["latents"].isfinite().all().item():
        raise RuntimeError(f"Expression model produced non-finite latents at step {step}")
    return state


def render(job):
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Expression editing is restricted to the remote cloud worker")
    silent, output = job / "expression-silent.mp4", job / "expression.mp4"
    if silent.exists() or output.exists():
        raise ValueError("Expression output already exists; use a new job")
    if importlib.util.find_spec("ftfy") is None:
        raise RuntimeError("VACE prompt cleaning requires ftfy; install requirements-body.txt in the cloud environment")
    settings, source, masks, fps = read_expression_inputs(job)
    prompt = prompt_file(job, "expression.txt", PROMPT)
    negative = prompt_file(job, "negative.txt", NEGATIVE)
    source_hash = hashlib.sha256(Path(settings["sourceClip"]).read_bytes()).hexdigest()
    import numpy as np
    import torch
    from diffusers import AutoencoderKLWan, WanVACEPipeline
    from transformers import T5TokenizerFast

    if not torch.cuda.is_available():
        raise RuntimeError("A remote CUDA GPU is required for expression editing")
    print("Checking VACE prompt lengths", flush=True)
    tokenizer = T5TokenizerFast.from_pretrained(MODEL, subfolder="tokenizer", revision=REVISION)
    inputs = tokenizer([prompt, negative], padding="max_length", max_length=256, return_tensors="pt")
    if inputs.input_ids.shape[1] > 256:
        raise ValueError("Expression prompt exceeds the 256-token conditioning limit")
    del tokenizer, inputs
    print("Loading masked whole-video editing model", flush=True)
    vae = AutoencoderKLWan.from_pretrained(
        MODEL, subfolder="vae", revision=REVISION, torch_dtype=torch.float32,
    )
    pipe = WanVACEPipeline.from_pretrained(
        MODEL, revision=REVISION, torch_dtype=torch.bfloat16, vae=vae,
    )
    pipe.enable_model_cpu_offload()
    pipe.vae.enable_tiling()
    width, height = source[0].size
    generated = pipe(
        video=source, mask=masks, reference_images=[source[0]],
        # VACE 0.35.1 rejects embeds-only calls; its stock encoder requires string prompts.
        prompt=prompt, negative_prompt=negative, max_sequence_length=256,
        height=height, width=width, num_frames=len(source),
        num_inference_steps=30, guidance_scale=5.0, conditioning_scale=1.0,
        generator=torch.Generator(device="cuda").manual_seed(7), output_type="pil",
        callback_on_step_end=check_expression_step,
    ).frames[0]
    if len(generated) != len(source) or any(frame.size != (width, height) for frame in generated):
        raise RuntimeError("Facial editor changed the master motion timeline or resolution")
    with (job / "expression-encode.log").open("w") as log:
        with subprocess.Popen([
            "ffmpeg", "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0",
            "-an", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", str(silent),
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log) as writer:
            for base, edited, mask in zip(source, generated, masks):
                pixels = preserve_motion_frame(np.asarray(base), np.asarray(edited), np.asarray(mask), settings["faceRegion"])
                writer.stdin.write(pixels.tobytes())
        if writer.returncode:
            raise RuntimeError(f"Expression encoder failed: see {job / 'expression-encode.log'}")
    subprocess.run([
        "ffmpeg", "-v", "error", "-n", "-i", str(silent), "-i", settings["sourceClip"],
        "-map", "0:v:0", "-map", "1:a:0?", "-c", "copy", "-movflags", "+faststart", str(output),
    ], check=True, timeout=120)
    if hashlib.sha256(Path(settings["sourceClip"]).read_bytes()).hexdigest() != source_hash:
        raise RuntimeError("Master body-motion file changed during facial editing")
    (job / "expression-settings.json").write_text(json.dumps({
        **settings, "model": MODEL, "revision": REVISION, "prompt": prompt,
        "negativePrompt": negative, "sourceSha256": source_hash,
        "frames": len(source), "fps": fps, "width": width, "height": height,
        "protectedPixelsExactBeforeEncoding": True, "encodingCrf": 12,
        "separateHeadClip": False, "bodyMotionRegenerated": False,
        "lipSync": False, "requiresVisualExpressionReview": True,
        "staticRegionRequiresStableHead": True,
    }, indent=2), encoding="utf-8")
    return output


if __name__ == "__main__":
    print("EXPRESSION_READY", render(Path(sys.argv[1]).resolve()))
