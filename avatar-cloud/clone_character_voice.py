"""Consent-gated offline voice sample, isolated from the avatar environment."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import threading
import time
from typing import TYPE_CHECKING
import wave

if TYPE_CHECKING:
    from torch import Tensor

MODEL_REVISION = "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
CODE_REVISION = "5de7a54aa4e5e2baadb0182dde554908b48b85c2"


def validate_reference(reference: Path) -> float:
    with wave.open(str(reference), "rb") as audio:
        if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                or audio.getframerate() != 24000 or audio.getcomptype() != "NONE"):
            raise ValueError("Reference must be mono 24 kHz 16-bit PCM WAV")
        count = audio.getnframes()
        duration = count / audio.getframerate()
        if not 6 <= duration <= 30:
            raise ValueError("Reference must contain 6-30 seconds")
        data = audio.readframes(count)
    if len(data) != count * 2:
        raise ValueError("Reference WAV is truncated")
    samples = [value for (value,) in struct.iter_unpack("<h", data)]
    if max(samples) - min(samples) < 10:
        raise ValueError("Reference is silent or contains only a DC signal")
    return duration


def validate_consent(consent: bool) -> None:
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Voice test requires an authorized Linux cloud worker")
    if not consent:
        raise ValueError("Explicit voice rights/consent confirmation required")


def validate_text(text: str, language: str) -> str:
    text = text.strip()
    if not 1 <= len(text) <= 300:
        raise ValueError("Speech text must contain 1-300 characters")
    if language not in ("pl", "en", "de"):
        raise ValueError("Supported test languages: pl, en, de")
    return text


class CharacterVoiceSession:
    def __init__(self, reference: Path, consent: bool):
        validate_consent(consent)
        validate_reference(reference)
        self._reference_sha256 = hashlib.sha256(reference.read_bytes()).hexdigest()
        self._lock = threading.Lock()
        import torch
        from huggingface_hub import snapshot_download
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        if not torch.cuda.is_available():
            raise RuntimeError("Cloud GPU required; no automatic CPU fallback")
        checkpoint = snapshot_download(
            "ResembleAI/chatterbox", revision=MODEL_REVISION,
            allow_patterns=[
                "ve.pt", "t3_mtl23ls_v3.safetensors", "s3gen.pt",
                "grapheme_mtl_merged_expanded_v1.json", "conds.pt",
                "Cangjie5_TC.json", "README.md",
            ],
        )
        self._model = ChatterboxMultilingualTTS.from_local(
            checkpoint, device="cuda", t3_model="v3",
        )
        self._model.prepare_conditionals(str(reference), exaggeration=0.5)
        if hashlib.sha256(reference.read_bytes()).hexdigest() != self._reference_sha256:
            raise RuntimeError("Reference changed during voice preparation")
        self._speaker_sha256 = self._speaker_digest()
        self.sr: int = self._model.sr

    @property
    def reference_sha256(self) -> str:
        return self._reference_sha256

    def _speaker_digest(self) -> str:
        conditionals = self._model.conds
        if conditionals is None:
            raise RuntimeError("Voice conditioning is missing")
        data = conditionals.t3.speaker_emb.detach().cpu().numpy().tobytes()
        return hashlib.sha256(data).hexdigest()

    def synthesize(self, text: str, language: str) -> Tensor:
        text = validate_text(text, language)
        import torch

        with self._lock:
            if self._speaker_digest() != self._speaker_sha256:
                raise RuntimeError("Voice identity conditioning changed")
            torch.manual_seed(20261004)
            waveform = self._model.generate(
                text, language_id=language, exaggeration=0.5, cfg_weight=0.5,
            )
            if self._speaker_digest() != self._speaker_sha256:
                raise RuntimeError("Voice identity conditioning changed during generation")
            return waveform


def generate_voice(reference: Path, output: Path, text: str, language: str,
                   consent: bool, session: CharacterVoiceSession | None = None) -> Path:
    validate_consent(consent)
    text = validate_text(text, language)
    reference = reference.resolve()
    reference_duration = validate_reference(reference)
    reference_sha256 = hashlib.sha256(reference.read_bytes()).hexdigest()
    if session is not None and session.reference_sha256 != reference_sha256:
        raise ValueError("Session reference does not match the requested character voice")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source = output / "reference.wav"
    shutil.copyfile(reference, source)
    (output / "request.json").write_text(json.dumps({
        "text": text, "language": language, "consentConfirmedByOperator": True,
        "referenceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "referenceDurationSeconds": reference_duration,
        "singleSpeakerVerified": False, "requiresListeningReview": True,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    import numpy as np
    import soundfile as sf
    voice = session if session is not None else CharacterVoiceSession(source, consent)
    started = time.perf_counter()
    waveform = voice.synthesize(text, language)
    elapsed = time.perf_counter() - started
    samples = waveform.squeeze(0).detach().cpu().numpy()
    if (samples.ndim != 1 or not np.isfinite(samples).all()
            or not 0.2 <= len(samples) / voice.sr <= 30
            or float(np.max(np.abs(samples))) < 0.0001):
        raise RuntimeError("Voice model produced invalid, silent or oversized audio")
    speech = output / "speech.wav"
    sf.write(str(speech), samples, voice.sr, subtype="PCM_16")
    (output / "voice.json").write_text(json.dumps({
        "engine": "chatterbox-multilingual-v3", "codeRevision": CODE_REVISION,
        "modelRevision": MODEL_REVISION, "mode": "offline-reference-conditioned-test",
        "sampleRate": voice.sr, "durationSeconds": len(samples) / voice.sr,
        "generationSecondsExcludingModelAndReferenceLoading": elapsed,
        "sessionReused": session is not None,
        "speakerConditioningUnchanged": True,
        "audioSha256": hashlib.sha256(speech.read_bytes()).hexdigest(),
        "watermarkPreserved": True, "voiceSimilarityVerified": False,
        "requiresListeningReview": True, "liveConversationReady": False,
    }, indent=2), encoding="utf-8")
    return speech


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--text", required=True, action="append")
    parser.add_argument("--language", choices=("pl", "en", "de"), default="pl")
    parser.add_argument("--voice-consent", action="store_true")
    args = parser.parse_args()
    if len(args.text) == 1:
        result = generate_voice(
            args.reference, args.output, args.text[0], args.language, args.voice_consent,
        )
        print(f"VOICE_TEST_READY {result}", flush=True)
    else:
        validate_consent(args.voice_consent)
        for text in args.text:
            validate_text(text, args.language)
        validate_reference(args.reference)
        args.output.mkdir(parents=True, exist_ok=False)
        voice_session = CharacterVoiceSession(args.reference, args.voice_consent)
        for index, text in enumerate(args.text):
            result = generate_voice(
                args.reference, args.output / f"turn-{index:03d}",
                text, args.language, args.voice_consent, voice_session,
            )
            print(f"VOICE_TEST_READY {result}", flush=True)
