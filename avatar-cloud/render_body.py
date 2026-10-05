"""Full-image motion generation, restricted to the remote Linux GPU worker."""
import gc
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import wave

from render import verify_video

MODEL = "Lightricks/LTX-Video"
REVISION = "8984fa25007f376c1a299016d0957a37a2f797bb"
VIDEO_MODEL = "Lightricks/LTX-Video-0.9.5"
VIDEO_REVISION = "e58e28c39631af4d1468ee57a853764e11c1d37e"
PROMPT = (
    "Locked stationary camera, full-body shot, head and feet always visible. "
    "The silver-haired fantasy man in black and gold armor walks in place on a "
    "black background. He lifts his left knee high and bends his left leg, "
    "puts the left foot down, then lifts his right knee and bends his right leg. "
    "Both legs alternate in clearly visible walking steps. Both arms swing "
    "naturally forward and backward, bending at the elbows. His shoulders and "
    "torso rotate with each step. Glowing blue and violet ribbons flow around "
    "his moving body. Smooth natural articulated motion."
)
NEGATIVE = (
    "static body, frozen limbs, still image, camera movement, zoom, cropped feet, "
    "extra limbs, missing limbs, warped hands, distorted body, flicker, blurry"
)


def prepare_speech(job, max_duration=97 / 24):
    audio = job / "speech.wav"
    subprocess.run(["espeak-ng", "-v", "pl", "-s", "150", "-f", str(job / "script.txt"), "-w", str(audio)], check=True, timeout=60)
    with wave.open(str(audio), "rb") as speech:
        duration = speech.getnframes() / speech.getframerate()
    if duration <= 0 or duration > max_duration:
        raise ValueError(f"Body preview requires speech lasting at most {max_duration:.2f} seconds; shorten the script")
    return audio


def prompt_file(job, filename, default):
    path = job / filename
    if not path.exists():
        return default
    text = path.read_text(encoding="utf-8").strip()
    if not text or len(text) > 2000:
        raise ValueError(f"{filename} must contain 1-2000 characters")
    return text


def motion_prompt(job):
    return prompt_file(job, "motion.txt", PROMPT)


def negative_prompt(job):
    return prompt_file(job, "negative.txt", NEGATIVE)


def frame_size(width, height):
    if width <= 0 or height <= 0:
        raise ValueError("Source image dimensions must be positive")
    scale = 768 / max(width, height)
    return max(32, round(width * scale / 32) * 32), max(32, round(height * scale / 32) * 32)


def prepare_body_image(source, size):
    from PIL import Image, ImageOps
    rgba = source.convert("RGBA")
    black = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
    opaque = Image.alpha_composite(black, rgba).convert("RGB")
    return ImageOps.pad(opaque, size, color="black")


def layer_settings(job):
    path = job / "body-layers.json"
    if not path.exists():
        return None
    settings = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(settings, dict)
        or not {"protectedTop", "feather"} <= set(settings)
        or set(settings) - {"protectedTop", "feather", "faceClip", "faceCrop", "mode", "faceBox"}
    ):
        raise ValueError("body-layers.json requires protectedTop/feather and optional faceClip/faceCrop")
    mode = settings.get("mode", "fixed")
    if mode not in ("fixed", "tracked"):
        raise ValueError("Body layer mode must be fixed or tracked")
    if mode == "tracked":
        from body_layers import validate_face_box
        validate_face_box(settings.get("faceBox"))
        feather = settings["feather"]
        if type(feather) not in (int, float) or not math.isfinite(feather) or not 0 < feather < .5:
            raise ValueError("Tracked feather must be in (0, 0.5)")
        if not {"faceClip", "faceCrop"} <= set(settings):
            raise ValueError("Tracked composition requires a face clip")
    elif "faceBox" in settings:
        raise ValueError("faceBox requires tracked composition")
    values = [settings["protectedTop"], settings["feather"]]
    if any(type(value) not in (int, float) for value in values):
        raise ValueError("Body layer fractions must be numbers")
    # Validate before expensive GPU inference, including tiny-image boundaries.
    from body_layers import protect_upper_portrait
    from PIL import Image
    protect_upper_portrait(Image.new("RGB", (32, 768)), Image.new("RGB", (32, 768)), *values)
    if "faceClip" in settings or "faceCrop" in settings:
        if (
            not isinstance(settings.get("faceClip"), str)
            or not Path(settings["faceClip"]).is_file()
            or settings.get("faceCrop") != "upper-square"
        ):
            raise ValueError("Face layer requires an existing faceClip and faceCrop: upper-square")
    return settings


def motion_settings(job):
    path = job / "body-motion.json"
    if not path.exists():
        return {"returnToSourcePose": False}
    settings = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(settings, dict)
        or "returnToSourcePose" not in settings
        or set(settings) - {"returnToSourcePose", "poseStrength", "frames"}
        or type(settings["returnToSourcePose"]) is not bool
    ):
        raise ValueError("body-motion.json requires a boolean returnToSourcePose")
    if "poseStrength" in settings:
        strength = settings["poseStrength"]
        if (
            not settings["returnToSourcePose"]
            or type(strength) not in (float, int)
            or not math.isfinite(strength) or not 0 < strength <= 1
        ):
            raise ValueError("poseStrength requires enabled pose conditioning and a finite number in (0, 1]")
    if "frames" in settings:
        frames = settings["frames"]
        if type(frames) is not int or not 33 <= frames <= 97 or (frames - 1) % 8:
            raise ValueError("frames must be an integer from 33 to 97 of the form 8k+1")
    return settings


def main():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Body rendering is restricted to the cloud worker")
    job = Path(sys.argv[1]).resolve()
    portraits = list(job.glob("portrait.*"))
    if len(portraits) != 1 or not (job / "script.txt").is_file():
        raise ValueError("Expected exactly one portrait and a speech script")
    layers = layer_settings(job)
    motion = motion_settings(job)
    frame_count = motion.get("frames", 97)
    face_clip = layers.get("faceClip") if layers else None
    from body_layers import face_references, face_timeline, motion_frame_indices, protect_upper_portrait
    audio = Path(face_clip) if face_clip else prepare_speech(job, frame_count / 24)
    prompt = motion_prompt(job)
    negative = negative_prompt(job)
    from PIL import Image
    with Image.open(portraits[0]) as source:
        width, height = frame_size(*source.size)
        source_alpha = "A" in source.getbands() or "transparency" in source.info
        image = prepare_body_image(source, (width, height))
    if face_clip and (layers["protectedTop"] + layers["feather"]) * height > width:
        if layers.get("mode", "fixed") == "fixed":
            raise ValueError("Face layer boundary exceeds the upper-square portrait crop")
    output_count, output_fps = face_timeline(face_clip) if face_clip else (frame_count, 24)
    references = face_references(face_clip, image, output_count, output_fps) if face_clip else None
    if face_clip:
        verify_video(str(face_clip))
    tracked = layers is not None and layers.get("mode") == "tracked"
    if tracked:
        from body_layers import HeadTracker
        box = layers["faceBox"]
        if (box[1] + box[3]) * height > width:
            raise ValueError("Tracked faceBox exceeds the upper-square face crop")
        HeadTracker(image, box)
    import torch
    from transformers import BitsAndBytesConfig, T5EncoderModel, T5TokenizerFast
    from diffusers import LTXImageToVideoPipeline
    from diffusers.utils import export_to_video

    if not torch.cuda.is_available():
        raise RuntimeError("A remote CUDA GPU is required for full-body rendering")
    print("Loading quantized text encoder on cloud GPU", flush=True)
    encoder = T5EncoderModel.from_pretrained(
        MODEL, subfolder="text_encoder", revision=REVISION,
        quantization_config=BitsAndBytesConfig(load_in_8bit=True),
        device_map={"": 0}, torch_dtype=torch.float32,
    )
    tokenizer = T5TokenizerFast.from_pretrained(MODEL, subfolder="tokenizer", revision=REVISION)
    inputs = tokenizer([prompt, negative], padding="max_length", max_length=128, truncation=True, return_tensors="pt")
    with torch.inference_mode():
        embeds = encoder(inputs.input_ids.to("cuda"))[0].to(dtype=torch.float16)
    masks = inputs.attention_mask.bool().to("cuda")
    if not torch.isfinite(embeds).all():
        raise RuntimeError("Text encoder produced non-finite conditioning")
    del encoder, tokenizer
    gc.collect()
    torch.cuda.empty_cache()

    print("Loading full-body image-to-video model", flush=True)
    pipeline_type = LTXImageToVideoPipeline
    conditioning = {"image": image}
    if motion["returnToSourcePose"]:
        from diffusers import LTXConditionPipeline
        from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition
        pipeline_type = LTXConditionPipeline
        conditioning = {
            "conditions": [
                LTXVideoCondition(image=image, frame_index=0, strength=1.0),
                LTXVideoCondition(image=image, frame_index=frame_count - 1, strength=motion.get("poseStrength", 1.0)),
            ],
            "image_cond_noise_scale": 0.0,
            "max_sequence_length": 128,
        }
    pipe = pipeline_type.from_pretrained(
        VIDEO_MODEL, revision=VIDEO_REVISION, text_encoder=None, tokenizer=None,
        torch_dtype=torch.float16, low_cpu_mem_usage=True,
    )
    pipe.enable_model_cpu_offload()
    pipe.vae.enable_tiling()
    print(f"Generating requested motion at {width}x{height}; no local GPU is used", flush=True)
    frames = pipe(
        **conditioning, prompt_embeds=embeds[:1], negative_prompt_embeds=embeds[1:],
        prompt_attention_mask=masks[:1], negative_prompt_attention_mask=masks[1:],
        width=width, height=height, num_frames=frame_count, num_inference_steps=30,
        decode_timestep=0.05, decode_noise_scale=0.025,
        guidance_scale=3.0, generator=torch.Generator("cuda").manual_seed(7),
    ).frames[0]
    silent = job / "body-silent.mp4"
    import numpy as np
    for frame in frames:
        pixels = np.asarray(frame)
        if not np.isfinite(pixels).all() or float(pixels.std()) < 1:
            raise RuntimeError("Body model produced invalid/blank frames; output rejected")
    if layers:
        indices = motion_frame_indices(len(frames), output_count)
        if tracked:
            from body_layers import tracked_face_composite
            frames = tracked_face_composite(
                [frames[index] for index in indices], references, image,
                layers["faceBox"], layers["feather"],
            )
        else:
            frames = [
                protect_upper_portrait(
                    frames[motion_index], references[index] if references else image,
                    layers["protectedTop"], layers["feather"],
                )
                for index, motion_index in enumerate(indices)
            ]
    export_to_video(frames, str(silent), fps=output_fps, quality=9)
    del pipe, frames
    gc.collect()
    torch.cuda.empty_cache()
    video = job / "video.mp4"
    audio_options = ["-c:a", "copy"] if face_clip else [
        "-c:a", "aac", "-af", "apad", "-t", str(frame_count / 24),
    ]
    subprocess.run([
        "ffmpeg", "-y", "-i", str(silent), "-i", str(audio),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *audio_options,
        "-movflags", "+faststart", str(video),
    ], check=True, timeout=120)
    verify_video(str(video))
    (job / "body-settings.json").write_text(json.dumps({
        "model": VIDEO_MODEL, "revision": VIDEO_REVISION,
        "textEncoderModel": MODEL, "textEncoderRevision": REVISION, "prompt": prompt,
        "negativePrompt": negative,
        "seed": 7, "fps": output_fps, "frames": output_count,
        "bodyGenerationFrames": frame_count, "bodyGenerationFps": 24,
        "bodyRetimedToFace": face_clip is not None,
        "width": width, "height": height, "precision": "float16", "encodingQuality": 9,
        "sourceHadAlpha": source_alpha, "previewBackground": "black",
        "requiresVisualMotionReview": True,
        "motionSettings": motion,
        "bodyLayers": layers,
        "fixedSourcePortrait": layers is not None and face_clip is None,
        "independentFaceEngine": face_clip is not None,
        "lipSync": face_clip is not None,
    }, indent=2), encoding="utf-8")
    print("BODY_VIDEO_READY", video, flush=True)


if __name__ == "__main__":
    main()
