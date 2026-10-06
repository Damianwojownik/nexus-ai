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
    """Persistent MuseTalk 1.5 renderer for the pinned Nexus identity.

    A canonical still works immediately. For more natural motion, an explicitly
    approved base video of the same Nexus identity can be configured. The base
    frames are prepared once; live calls only infer the audio-driven face region.
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
        base_video = os.environ.get("NEXUS_LIVE_BASE_VIDEO", "").strip()
        self.base_video = Path(base_video).resolve() if base_video else None
        self.base_video_sha256 = os.environ.get("NEXUS_LIVE_BASE_VIDEO_SHA256", "").strip().lower()
        self.max_base_frames = int(os.environ.get("NEXUS_LIVE_BASE_MAX_FRAMES", "250"))
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
        self._render_lock = threading.RLock()
        self._idle_lock = threading.Lock()
        self._idle_cursor = 0
        self._render_cursor = 0

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

        self.base_frames: list[object] = []
        self.bboxes: list[list[int]] = []
        self.masks: list[object] = []
        self.mask_crop_boxes: list[object] = []
        self.latents: list[object] = []

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def _validate_config(self) -> None:
        if not self.musetalk_dir.is_dir():
            raise RuntimeError(
                f"MuseTalk checkout missing at {self.musetalk_dir}; run the Nexus live installer first"
            )
        if not self.reference.is_file():
            raise RuntimeError(f"Nexus librarian reference missing: {self.reference}")
        digest = self._sha256(self.reference)
        if digest != LIBRARIAN_SHA256:
            raise RuntimeError(
                f"Nexus librarian identity hash mismatch: expected {LIBRARIAN_SHA256}, got {digest}"
            )
        if self.base_video is not None:
            if not self.base_video.is_file():
                raise RuntimeError(f"Nexus live base video does not exist: {self.base_video}")
            if not self.base_video_sha256 or len(self.base_video_sha256) != 64:
                raise RuntimeError(
                    "NEXUS_LIVE_BASE_VIDEO requires NEXUS_LIVE_BASE_VIDEO_SHA256 from an approved asset"
                )
            actual = self._sha256(self.base_video)
            if actual != self.base_video_sha256:
                raise RuntimeError(
                    f"Nexus live base video hash mismatch: expected {self.base_video_sha256}, got {actual}"
                )
        if self.max_base_frames < 1 or self.max_base_frames > 1000:
            raise RuntimeError("NEXUS_LIVE_BASE_MAX_FRAMES must be within 1..1000")
        if self.fps < 12 or self.fps > 30:
            raise RuntimeError("NEXUS_LIVE_RENDER_FPS must be between 12 and 30")
        if self.batch_size < 1 or self.batch_size > 32:
            raise RuntimeError("NEXUS_MUSETALK_BATCH_SIZE must be between 1 and 32")
        if self.output_width < 0 or self.output_height < 0:
            raise RuntimeError("live output dimensions cannot be negative")
        if bool(self.output_width) != bool(self.output_height):
            raise RuntimeError("set both NEXUS_LIVE_OUTPUT_WIDTH and NEXUS_LIVE_OUTPUT_HEIGHT, or neither")

    def _extract_base_paths(self, cv2, temp_dir: str) -> list[str]:
        if self.base_video is None:
            return [str(self.reference)]

        capture = cv2.VideoCapture(str(self.base_video))
        if not capture.isOpened():
            raise RuntimeError("Nexus live base video could not be opened")
        source_fps = float(capture.get(cv2.CAP_PROP_FPS) or self.fps)
        if source_fps <= 0:
            source_fps = float(self.fps)
        step = source_fps / self.fps
        next_source_index = 0.0
        source_index = 0
        output: list[str] = []
        try:
            while len(output) < self.max_base_frames:
                ok, frame = capture.read()
                if not ok:
                    break
                if source_index + 1e-6 >= next_source_index:
                    target = Path(temp_dir) / f"{len(output):06d}.png"
                    if not cv2.imwrite(str(target), frame):
                        raise RuntimeError("failed to materialize Nexus base-video frame")
                    output.append(str(target))
                    next_source_index += step
                source_index += 1
        finally:
            capture.release()
        if not output:
            raise RuntimeError("Nexus live base video yielded no frames")
        return output

    def load(self) -> None:
        with self._render_lock:
            if self.ready:
                return
            self._validate_config()
            started = time.perf_counter()
            old_cwd = Path.cwd()
            for import_path in (self.musetalk_dir, self.musetalk_dir / "musetalk" / "utils"):
                value = str(import_path)
                if value not in sys.path:
                    sys.path.insert(0, value)
            try:
                os.chdir(self.musetalk_dir)
                import cv2
                import numpy as np
                import torch
                from transformers import WhisperModel
                from musetalk.utils.audio_processor import AudioProcessor
                from musetalk.utils.blending import get_image_blending, get_image_prepare_material
                from musetalk.utils.face_parsing import FaceParsing
                import musetalk.utils.preprocessing as preprocessing
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
                with tempfile.TemporaryDirectory(prefix="nexus-live-base-") as temp_dir:
                    paths = self._extract_base_paths(cv2, temp_dir)
                    coord_list, frame_list = preprocessing.get_landmark_and_bbox(paths, 0)

                if not coord_list or len(coord_list) != len(frame_list):
                    raise RuntimeError("Nexus base preprocessing returned inconsistent face/frame data")

                base_frames: list[object] = []
                bboxes: list[list[int]] = []
                masks: list[object] = []
                mask_crop_boxes: list[object] = []
                latents: list[object] = []
                for index, (bbox, frame) in enumerate(zip(coord_list, frame_list)):
                    if not bbox or len(bbox) != 4 or tuple(float(value) for value in bbox) == (0.0, 0.0, 0.0, 0.0):
                        raise RuntimeError(f"Nexus face was not detected in base frame {index}")
                    x1, y1, x2, y2 = [int(v) for v in bbox]
                    y2 = min(frame.shape[0], y2 + self.extra_margin)
                    if x2 <= x1 or y2 <= y1:
                        raise RuntimeError(f"Nexus base frame {index} produced an invalid face bounding box")
                    crop = frame[y1:y2, x1:x2]
                    crop = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
                    latent = vae.get_latents_for_unet(crop)
                    mask, mask_crop_box = get_image_prepare_material(
                        frame, [x1, y1, x2, y2], fp=fp, mode=self.parsing_mode
                    )
                    base_frames.append(frame)
                    bboxes.append([x1, y1, x2, y2])
                    masks.append(mask)
                    mask_crop_boxes.append(mask_crop_box)
                    latents.append(latent)

                if not base_frames:
                    raise RuntimeError("Nexus live identity produced no usable base frames")

                # Pose/face detectors are preparation-only. Release their GPU references
                # before the persistent talking model begins serving sessions.
                try:
                    preprocessing.model = None
                    preprocessing.fa = None
                    del fp
                    torch.cuda.empty_cache()
                except Exception:
                    pass

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
                self.base_frames = base_frames
                self.bboxes = bboxes
                self.masks = masks
                self.mask_crop_boxes = mask_crop_boxes
                self.latents = latents
                self._idle_cursor = 0
                self._render_cursor = 0
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
        if not self.ready or not self.base_frames:
            raise RuntimeError("MuseTalk engine is not ready")
        with self._idle_lock:
            index = self._idle_cursor % len(self.base_frames)
            self._idle_cursor = (self._idle_cursor + 1) % len(self.base_frames)
        return self._resize(self.base_frames[index].copy())

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

        with self._render_lock:
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

                indices = [
                    (self._render_cursor + offset) % len(self.latents)
                    for offset in range(len(whisper_chunks))
                ]
                window_latents = [self.latents[index] for index in indices]
                generator = self.datagen(
                    whisper_chunks,
                    window_latents,
                    self.batch_size,
                    delay_frame=0,
                    device=self.device,
                )

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
                        index = indices[frames % len(indices)]
                        x1, y1, x2, y2 = self.bboxes[index]
                        mouth = self.cv2.resize(
                            predicted.astype(self.np.uint8), (x2 - x1, y2 - y1)
                        )
                        combined = self.get_image_blending(
                            self.base_frames[index].copy(),
                            mouth,
                            self.bboxes[index],
                            self.masks[index],
                            self.mask_crop_boxes[index],
                        )
                        emit(self._resize(combined))
                        frames += 1
                self._render_cursor = (self._render_cursor + frames) % len(self.latents)
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

    def visual_info(self) -> dict[str, object]:
        return {
            "baseMode": "approved-video" if self.base_video is not None else "canonical-still",
            "baseFrames": len(self.base_frames),
            "baseVideoSha256": self.base_video_sha256 if self.base_video is not None else None,
            "referenceSha256": LIBRARIAN_SHA256,
        }
