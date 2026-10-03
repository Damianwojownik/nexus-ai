from __future__ import annotations

import hashlib
import json
import secrets
import threading
import uuid
import warnings
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from PIL import Image, ImageOps, UnidentifiedImageError

MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 30_000_000
NEGATIVE = (
    "different person, altered facial identity, changed age, plastic skin, beauty filter, "
    "deformed hands, extra fingers, missing fingers, extra limbs, duplicate person, "
    "collage, text, watermark, blurry face, oversharpening"
)


@dataclass(frozen=True)
class Variant:
    id: str
    label: str
    instruction: str
    pose: bool = False


VARIANTS = (
    Variant("01-neutral", "Neutralnie", "Relaxed neutral expression, lips gently closed, eyes naturally open."),
    Variant("02-soft-smile", "Lekki uśmiech", "A gentle, natural closed-mouth smile; eyes open."),
    Variant("03-big-smile", "Szeroki uśmiech", "A warm, broad natural smile with realistic teeth; eyes open."),
    Variant("04-sad", "Smutek", "A subtle sad expression, slightly lowered mouth corners, eyes open; no tears."),
    Variant("05-eyes-closed", "Oczy zamknięte", "Both eyelids fully and naturally closed, relaxed neutral mouth."),
    Variant("06-eyes-open", "Oczy otwarte", "Both eyes clearly open, attentive direct gaze, relaxed neutral mouth; no exaggerated expression."),
    Variant("07-arms-out", "Ręce na boki", "Both arms extended sideways at shoulder height, relaxed open hands fully visible; eyes open.", True),
    Variant("08-arms-up", "Ręce w górę", "Both arms raised overhead in a relaxed V, both hands fully visible; eyes open and gentle smile.", True),
    Variant("09-arms-crossed", "Skrzyżowane ręce", "Arms naturally crossed at chest level, relaxed shoulders; eyes open and neutral expression.", True),
    Variant("10-wave", "Machanie", "One hand raised beside the head in a friendly open-palm wave, the other arm relaxed; eyes open and gentle smile.", True),
)
BY_ID = {v.id: v for v in VARIANTS}


@dataclass(frozen=True)
class Settings:
    steps: int = 40
    seed: int = 42
    size: str = "1024x1536"
    background: str = "original"

    def validate(self):
        if type(self.steps) is not int or not 20 <= self.steps <= 60:
            raise ValueError("Liczba kroków musi wynosić 20–60.")
        if type(self.seed) is not int or not 0 <= self.seed <= 2_147_483_647:
            raise ValueError("Seed musi być liczbą całkowitą od 0 do 2147483647.")
        if self.size not in {"1024x1024", "1024x1536", "1536x1024"}:
            raise ValueError("Nieobsługiwany format zdjęcia.")
        if self.background not in {"original", "studio"}:
            raise ValueError("Nieobsługiwane tło.")


def read_reference(path: str | Path) -> Image.Image:
    path = Path(path)
    if path.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError("Zdjęcie jest za duże. Maksymalnie 20 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("Wgraj zdjęcie JPG, PNG lub WebP.")
                if source.width * source.height > MAX_PIXELS:
                    raise ValueError("Maksymalna wielkość zdjęcia to 30 megapikseli.")
                if min(source.size) < 256:
                    raise ValueError("Zdjęcie musi mieć co najmniej 256 pikseli na każdym boku.")
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                # Fresh image prevents EXIF/GPS metadata being copied into outputs.
                clean = Image.new("RGB", image.size)
                clean.paste(image)
                return clean
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ValueError("Nie można odczytać zdjęcia. Wgraj poprawny JPG, PNG lub WebP.") from error


def prompt_for(variant: Variant, settings: Settings, reference_count: int) -> str:
    background = (
        "Preserve the original background and lighting; extend the scene only when needed to fit the pose."
        if settings.background == "original" else
        "Use a plain warm-grey studio background and soft natural portrait lighting."
    )
    framing = (
        "Frame the same person from head to at least mid-thigh; leave ample space above and on both sides "
        "for the complete requested arms and hands. Do not crop fingers."
        if variant.pose else
        "Keep a head-and-shoulders portrait with the entire head visible."
    )
    references = (
        "All reference photos show the SAME person. Use image 1 for clothing and overall appearance; "
        "use the other references only to clarify that person's facial identity."
        if reference_count > 1 else "The input photograph is the identity and appearance reference."
    )
    return (
        f"Edit the reference photograph into ONE realistic photograph of the exact same person. {references} "
        "Preserve facial proportions, age, skin tone, distinctive features, hairstyle, hair color, "
        "body build, clothing and accessories. Do not beautify, change identity or invent a uniform. "
        f"Requested change: {variant.instruction} {framing} {background} "
        "Natural skin texture, sharp facial detail, anatomically plausible hands and joints. "
        "One person only. No grid, collage, captions or watermark."
    )


class PortraitEngine:
    """Lazy GPU loader. A single process-wide instance serializes all inference."""

    def __init__(self, memory_profile: str = "full", offload: str = "sequential"):
        if memory_profile not in {"full", "4bit"} or offload not in {"sequential", "model", "none"}:
            raise ValueError("Invalid memory profile or offload mode")
        self.memory_profile = memory_profile
        self.offload = offload
        self.pipe = None
        self.lock = threading.Lock()

    def _load(self):
        if self.pipe is not None:
            return self.pipe
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("Brak GPU CUDA. Uruchom studio w środowisku z GPU, np. Colab.")
        from diffusers import QwenImageEditPlusPipeline
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        kwargs = {"torch_dtype": dtype}
        if self.memory_profile == "4bit":
            from diffusers import BitsAndBytesConfig, QwenImageTransformer2DModel
            from transformers import BitsAndBytesConfig as TextQuantization
            from transformers import Qwen2_5_VLForConditionalGeneration
            kwargs["transformer"] = QwenImageTransformer2DModel.from_pretrained(
                MODEL_ID, subfolder="transformer", torch_dtype=dtype,
                quantization_config=BitsAndBytesConfig(
                    load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype,
                ),
            )
            kwargs["text_encoder"] = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                MODEL_ID, subfolder="text_encoder", torch_dtype=dtype,
                quantization_config=TextQuantization(
                    load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype,
                ),
            )
        pipe = QwenImageEditPlusPipeline.from_pretrained(MODEL_ID, **kwargs)
        pipe.vae.enable_slicing()
        pipe.vae.enable_tiling()
        if self.offload == "sequential":
            pipe.enable_sequential_cpu_offload()
        elif self.offload == "model":
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")
        self.pipe = pipe
        return pipe

    def render(self, references, prompt, settings, seed, progress=None):
        import torch
        settings.validate()
        with self.lock:
            pipe = self._load()
            width, height = map(int, settings.size.split("x"))

            def on_step(_pipe, step, _timestep, values):
                if progress:
                    progress((step + 1) / settings.steps)
                return values

            try:
                with torch.inference_mode():
                    return pipe(
                        image=[image.copy() for image in references], prompt=prompt,
                        negative_prompt=NEGATIVE, true_cfg_scale=4.0,
                        num_inference_steps=settings.steps, width=width, height=height,
                        num_images_per_prompt=1, output_type="pil",
                        generator=torch.Generator(device="cpu").manual_seed(seed),
                        callback_on_step_end=on_step,
                    ).images[0]
            except torch.cuda.OutOfMemoryError as error:
                torch.cuda.empty_cache()
                raise RuntimeError(
                    "Za mało pamięci GPU. Spróbuj formatu 1024×1024 lub uruchom ponownie "
                    "studio z profilem 4bit i offloadem sequential."
                ) from error


class PortraitSession:
    """One isolated output folder per photo set, immutable original references."""

    def __init__(self, paths, settings: Settings, output_root: Path, profile="full"):
        settings.validate()
        if not 1 <= len(paths) <= 3:
            raise ValueError("Wgraj od 1 do 3 zdjęć tej samej osoby.")
        self.references = [read_reference(path) for path in paths]
        self.settings = settings
        self.directory = output_root / uuid.uuid4().hex
        self.directory.mkdir(parents=True, exist_ok=False)
        self.records = {}
        self.errors = {}
        self.profile = profile
        self.stop_requested = threading.Event()
        self.write_manifest()

    def write_manifest(self):
        manifest = {
            "schema_version": 1, "model": MODEL_ID, "memory_profile": self.profile,
            "settings": asdict(self.settings), "negative_prompt": NEGATIVE,
            "reference_sha256": [hashlib.sha256(im.tobytes()).hexdigest() for im in self.references],
            "completed": len(self.records), "expected": 10,
            "images": [self.records[v.id] for v in VARIANTS if v.id in self.records],
            "errors": self.errors,
            "quality_review": "Human review required: identity, eyes, expression, fingers, framing.",
        }
        temp = self.directory / "manifest.tmp"
        temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.directory / "manifest.json")

    def generate_one(self, variant_id: str, engine, *, retry=False, progress: Callable | None = None):
        variant = BY_ID[variant_id]
        index = next(i for i, v in enumerate(VARIANTS) if v.id == variant_id)
        seed = secrets.randbelow(2_147_483_648) if retry else (self.settings.seed + index) % 2_147_483_648
        prompt = prompt_for(variant, self.settings, len(self.references))
        try:
            result = engine.render(self.references, prompt, self.settings, seed, progress)
            if not isinstance(result, Image.Image) or min(result.size) < 256:
                raise RuntimeError("Silnik nie zwrócił poprawnego zdjęcia.")
            filename = f"{variant.id}-{uuid.uuid4().hex[:8]}.png"
            result.convert("RGB").save(self.directory / filename, format="PNG")
            # Keep previous takes on disk; only the selected take goes into the ZIP.
            self.records[variant.id] = {
                "variant": variant.id, "label": variant.label, "filename": filename,
                "seed": seed, "prompt": prompt, "width": result.width, "height": result.height,
            }
            self.errors.pop(variant.id, None)
        except Exception as error:
            self.errors[variant.id] = str(error)
            raise
        finally:
            self.write_manifest()

    def gallery(self):
        return [(str(self.directory / self.records[v.id]["filename"]), v.label)
                for v in VARIANTS if v.id in self.records]

    def archive(self) -> str | None:
        if not self.records:
            return None
        target = self.directory / f"nexus-{len(self.records):02d}-zdjec-{uuid.uuid4().hex[:8]}.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for record in self.records.values():
                archive.write(self.directory / record["filename"], f"{record['variant']}.png")
            manifest = json.loads((self.directory / "manifest.json").read_text(encoding="utf-8"))
            for record in manifest["images"]:
                record["filename"] = f"{record['variant']}.png"
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        return str(target)
