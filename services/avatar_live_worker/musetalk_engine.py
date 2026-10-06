from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


LIBRARIAN_SHA256 = "5810f3518ad5ac9a326ae720797c9c9117fb8160f94f00caeec019a260ea2e04"
MUSETALK_UPSTREAM_COMMIT = "0a89dec45a0192b824e3cf4daf96c239440c5ed8"


@dataclass
class MuseTalkMetrics:
    model_load_ms: float = 0.0
    avatar_prepare_ms: float = 0.0
    last_render_ms: float = 0.0
    last_render_frames: int = 0
    last_render_fps: float = 0.0
    total_frames: int = 0


class MuseTalkEngine:
    """Persistent MuseTalk 1.5 renderer.

    Models and the canonical Nexus identity are loaded once. Each call consumes a
    short PCM16LE window and emits complete BGR frames through the supplied sink.
    No MP4 is created in the live path.
    """

    def __init__(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        self.musetalk_dir = Path(
            os.environ.get("NEXUS_MUSETALK_DIR", str(repo_root / ".tools" / "MuseTalk"))
        ).resolve()
        self.reference = Path(
            os.environ.get(
                "NEXUS_LIVE_AVATAR_REFERENCE",
                str(repo_root / "public" / "avatars" / "references" / "nexus-librarian" /
                    "nexus-librarian-front-facing.jpeg"),
            )
        ).resolve()
        self.fps = int(os.environ.get("NEXUS_LIVE_RENDER_FPS", "25"))
        self.batch_size = int(os.environ.get("NEXUS_MUSETALK_BATCH_SIZE", "8"))
        self.extra_margin = int(os.environ.get("NEXUS_MUSETALK_EXTRA_MARGIN", "10"))
        self.parsing_mode = os.environ.get("NEXUS_MUSETALK_PARSING_MODE", "jaw").strip() or "jaw"
        self.gpu_id = int(os.environ.get("NEXUS_LIVE_GPU_ID", "0"))
        self.output_width = int(os.environ.get("NEXUS_LIVE_OUTPUT_WIDTH", "0"))
        self.output_height = int(os.environ.get("NEXUS_LIVE_OUTPUT_HEIGHT", "0"))
        self.metrics = MuseTalkMetrics()
        self.ready = False
        self.error: str | None = None
        self._lock = threading.RLock()

        self.cv2 = None
        self.np = None
        self.torch = None
        self.device = None
        self.vae = None
        self.unet = None
        self.pe = None
        self.whisper = None
        self.audio_processor = None
        self.timesteps = None
        self.weight_dtype = None
        self.datagen = None
        self.get_image_blending = None

        self.base_frame = None
        self.bbox = None
        self.mask = None
        self.mask_crop_box = None
        self.latent = None

    def _validate_config(self) -> None:
        if not self.musetalk_dir.is_dir():
            raise RuntimeError(
                f"MuseTalk checkout missing at {self.musetalk_dir}; run the Nexus live installer first"
            )
        if not self.reference.is_file():
            raise RuntimeError(f"Nexus librarian reference missing: {self.reference}")
        digest = hashlib.sha256(self.reference.read_bytes()).hexdigest()
        if digest != LIBRARIAN_SHA256:
            raise RuntimeError(
                f"Nexus librarian identity hash mismatch: expected {LIBRARIAN_SHA256}, got {digest}"
            )
        if self.fps < 12 or self.fps > 30:
            raise RuntimeError("NEXUS_LIVE_RENDER_FPS must be between 12 and 30")
        if self.batch_size < 1 or self.batch_size > 32:
            raise RuntimeError("NEXUS_MUSETALK_BATCH_SIZE must be between 1 and 32")
        if self.output_width < 0 or self.output_height < 0:
            raise RuntimeError("live output dimensions cannot be negative")
        if bool(self.output_width) != bool(self.output_height):
            raise RuntimeError("set both NEXUS_LIVE_OUTPUT_WIDTH and NEXUS_LIVE_OUTPUT_HEIGHT, or neither")

    def load(self) -> None:
        with self._lock:
            if self.ready:
                return
            self._validate_config()
            started = time.perf_counter()
            old_cwd = Path.cwd()
            sys.path.insert(0, str(self.musetalk_dir))
            try:
                os.chdir(self.musetalk_dir)
                import cv2
                import numpy as np
                import torch
                from transformers import WhisperModel
                from musetalk.utils.audio_processor import AudioProcessor
                from musetalk.utils.blending import get_image_blending, get_image_prepare_material
                from musetalk.utils.face_parsing import FaceParsing
                from musetalk.utils.preprocessing import get_landmark_and_bbox
                from musetalk.utils.utils import datagen, load_all_model

                if not torch.cuda.is_available():
                    raise RuntimeError("MuseTalk live worker requires an NVIDIA CUDA GPU")
                self.device = torch.device(f"cuda:{self.gpu_id}")
                props = torch.cuda.get_device_properties(self.device)
                min_vram_gb = float(os.environ.get("NEXUS_LIVE_MIN_VRAM_GB", "10"))
                vram_gb = props.total_memory / 1024**3
                if vram_gb < min_vram_gb:
                    raise RuntimeError(
                        f"GPU has {vram_gb:.1f} GiB VRAM; configured live minimum is {min_vram_gb:.1f} GiB"
                    )

                model_dir = self.musetalk_dir / "models"
                unet_path = model_dir / "musetalkV15" / "unet.pth"
                unet_config = model_dir / "musetalkV15" / "musetalk.json"
                whisper_dir = model_dir / "whisper"
                for required in (
                    unet_path,
                    unet_config,
                    whisper_dir / "config.json",
                    model_dir / "sd-vae" / "config.json",
                    model_dir / "face-parse-bisent" / "79999_iter.pth",
                ):
                    if not required.exists():
                        raise RuntimeError(f"MuseTalk model asset missing: {required}")

                vae, unet, pe = load_all_model(
                    unet_model_path=str(unet_path),
                    vae_type="sd-vae",
                    unet_config=str(unet_config),
                    device=self.device,
                )
                timesteps = torch.tensor([0], device=self.device)
                pe = pe.half().to(self.device)
                vae.vae = vae.vae.half().to(self.device)
                unet.model = unet.model.half().to(self.device)
                weight_dtype = unet.model.dtype

                audio_processor = AudioProcessor(feature_extractor_path=str(whisper_dir))
                whisper = WhisperModel.from_pretrained(str(whisper_dir))
                whisper = whisper.to(device=self.device, dtype=weight_dtype).eval()
                whisper.requires_grad_(False)

                fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
                prep_started = time.perf_counter()
                coord_list, frame_list = get_landmark_and_bbox([str(self.reference)], 0)
                if len(coord_list) != 1 or len(frame_list) != 1:
                    raise RuntimeError("Nexus reference preprocessing did not produce exactly one face frame")
                bbox = coord_list[0]
                frame = frame_list[0]
                if not bbox or len(bbox) != 4:
                    raise RuntimeError("Nexus reference face was not detected")
                x1, y1, x2, y2 = [int(v) for v in bbox]
                y2 = min(frame.shape[0], y2 + self.extra_margin)
                if x2 <= x1 or y2 <= y1:
                    raise RuntimeError("Nexus reference produced an invalid face bounding box")
                crop = frame[y1:y2, x1:x2]
                crop = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
                latent = vae.get_latents_for_unet(crop)
                mask, mask_crop_box = get_image_prepare_material(
                    frame, [x1, y1, x2, y2], fp=fp, mode=self.parsing_mode
                )

                self.cv2 = cv2
                self.np = np
                self.torch = torch
                self.vae = vae
                self.unet = unet
                self.pe = pe
                self.timesteps = timesteps
                self.audio_processor = audio_processor
                self.whisper = whisper
                self.weight_dtype = weight_dtype
                self.datagen = datagen
                self.get_image_blending = get_image_blending
                self.base_frame = frame
                self.bbox = [x1, y1, x2, y2]
                self.mask = mask
                self.mask_crop_box = mask_crop_box
                self.latent = latent
                self.metrics.avatar_prepare_ms = (time.perf_counter() - prep_started) * 1000
                self.metrics.model_load_ms = (time.perf_counter() - started) * 1000
                self.ready = True
                self.error = None
            except Exception as exc:
                self.error = str(exc)
                self.ready = False
                raise
            finally:
                os.chdir(old_cwd)

    def idle_frame(self):
        if not self.ready or self.base_frame is None:
            raise RuntimeError("MuseTalk engine is not ready")
        frame = self.base_frame.copy()
        return self._resize(frame)

    def _resize(self, frame):
        if self.output_width and self.output_height:
            return self.cv2.resize(
                frame, (self.output_width, self.output_height), interpolation=self.cv2.INTER_AREA
            )
        return frame

    def _write_pcm_wave(self, pcm16le: bytes) -> str:
        handle = tempfile.NamedTemporaryFile(prefix="nexus-live-", suffix=".wav", delete=False)
        path = handle.name
        handle.close()
        with wave.open(path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(pcm16le)
        return path

    def render_pcm(
        self,
        pcm16le: bytes,
        emit: Callable[[object], None],
        still_current: Callable[[], bool] | None = None,
    ) -> int:
        if not self.ready:
            raise RuntimeError(self.error or "MuseTalk engine is not ready")
        if not pcm16le or len(pcm16le) % 2:
            raise ValueError("MuseTalk PCM must contain complete signed 16-bit samples")
        if len(pcm16le) < 640 * 2:
            raise ValueError("MuseTalk live windows must contain at least 40 ms of 16 kHz PCM")
        still_current = still_current or (lambda: True)

        with self._lock:
            if not still_current():
                return 0
            wav_path = self._write_pcm_wave(pcm16le)
            started = time.perf_counter()
            frames = 0
            old_cwd = Path.cwd()
            try:
                os.chdir(self.musetalk_dir)
                whisper_input_features, librosa_length = self.audio_processor.get_audio_feature(
                    wav_path, weight_dtype=self.weight_dtype
                )
                whisper_chunks = self.audio_processor.get_whisper_chunk(
                    whisper_input_features,
                    self.device,
                    self.weight_dtype,
                    self.whisper,
                    librosa_length,
                    fps=self.fps,
                    audio_padding_length_left=2,
                    audio_padding_length_right=2,
                )
                if len(whisper_chunks) == 0:
                    return 0

                generator = self.datagen(
                    whisper_chunks,
                    [self.latent],
                    self.batch_size,
                    delay_frame=0,
                    device=self.device,
                )
                x1, y1, x2, y2 = self.bbox
                for whisper_batch, latent_batch in generator:
                    if not still_current():
                        break
                    whisper_batch = whisper_batch.to(
                        device=self.device, dtype=self.unet.model.dtype
                    )
                    audio_feature_batch = self.pe(whisper_batch)
                    latent_batch = latent_batch.to(
                        device=self.device, dtype=self.unet.model.dtype
                    )
                    pred_latents = self.unet.model(
                        latent_batch,
                        self.timesteps,
                        encoder_hidden_states=audio_feature_batch,
                    ).sample
                    pred_latents = pred_latents.to(
                        device=self.device, dtype=self.vae.vae.dtype
                    )
                    recon = self.vae.decode_latents(pred_latents)
                    for predicted in recon:
                        if not still_current():
                            break
                        mouth = self.cv2.resize(
                            predicted.astype(self.np.uint8), (x2 - x1, y2 - y1)
                        )
                        combined = self.get_image_blending(
                            self.base_frame.copy(),
                            mouth,
                            self.bbox,
                            self.mask,
                            self.mask_crop_box,
                        )
                        emit(self._resize(combined))
                        frames += 1
            finally:
                os.chdir(old_cwd)
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass

            elapsed = max(1e-6, time.perf_counter() - started)
            self.metrics.last_render_ms = elapsed * 1000
            self.metrics.last_render_frames = frames
            self.metrics.last_render_fps = frames / elapsed
            self.metrics.total_frames += frames
            return frames

    def gpu_info(self) -> dict[str, object]:
        if not self.ready or self.torch is None or self.device is None:
            return {}
        props = self.torch.cuda.get_device_properties(self.device)
        allocated = self.torch.cuda.memory_allocated(self.device)
        reserved = self.torch.cuda.memory_reserved(self.device)
        return {
            "name": props.name,
            "vramGiB": round(props.total_memory / 1024**3, 2),
            "allocatedGiB": round(allocated / 1024**3, 2),
            "reservedGiB": round(reserved / 1024**3, 2),
        }
