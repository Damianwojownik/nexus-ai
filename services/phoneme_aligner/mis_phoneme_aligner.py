from __future__ import annotations

import base64
import hmac
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

TOKEN = os.environ.get("MIS_ALIGNER_TOKEN", "").strip()
MFA_BIN = os.environ.get("MIS_MFA_BIN", "mfa")
FFMPEG_BIN = os.environ.get("MIS_FFMPEG_BIN", "ffmpeg")

app = FastAPI(title="Miś Phoneme Aligner", version="0.1.0-test")


class AlignRequest(BaseModel):
    language: str = Field(pattern="^(pl|en|de)$")
    transcript: str = Field(min_length=1, max_length=12000)
    audioBase64: str = Field(min_length=1)
    audioMime: Optional[str] = None


LANGUAGE_MODELS = {
    "pl": {
        "dictionary": os.environ.get("MIS_MFA_PL_DICTIONARY", "polish_mfa"),
        "acoustic": os.environ.get("MIS_MFA_PL_ACOUSTIC", "polish_mfa"),
        "g2p": os.environ.get("MIS_MFA_PL_G2P", "polish_mfa"),
    },
    "en": {
        "dictionary": os.environ.get("MIS_MFA_EN_DICTIONARY", "english_us_mfa"),
        "acoustic": os.environ.get("MIS_MFA_EN_ACOUSTIC", "english_mfa"),
        "g2p": os.environ.get("MIS_MFA_EN_G2P", "english_us_mfa"),
    },
    "de": {
        "dictionary": os.environ.get("MIS_MFA_DE_DICTIONARY", "german_mfa"),
        "acoustic": os.environ.get("MIS_MFA_DE_ACOUSTIC", "german_mfa"),
        "g2p": os.environ.get("MIS_MFA_DE_G2P", "german_mfa"),
    },
}


def _authorized(authorization: Optional[str]) -> bool:
    if not TOKEN:
        return True
    if not authorization or not authorization.lower().startswith("bearer "):
        return False
    return hmac.compare_digest(authorization[7:].strip(), TOKEN)


def _require_auth(authorization: Optional[str]) -> None:
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Invalid Miś aligner token")


def _decode_audio(value: str) -> bytes:
    clean = value.split(",", 1)[1] if "," in value and "base64" in value[:128] else value
    try:
        return base64.b64decode(clean, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="audioBase64 is invalid") from exc


def _run(cmd: list[str], timeout: int = 600) -> None:
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        tail = result.stdout[-4000:] if result.stdout else ""
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(cmd[:4])}\n{tail}")


def _normalise_audio(source: Path, target: Path) -> None:
    _run([
        FFMPEG_BIN,
        "-y",
        "-i", str(source),
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        str(target),
    ], timeout=180)


def _find_phone_entries(payload: dict) -> list[list]:
    tiers = payload.get("tiers")
    if not isinstance(tiers, dict):
        return []
    for name, tier in tiers.items():
        if "phone" not in str(name).lower() or not isinstance(tier, dict):
            continue
        entries = tier.get("entries")
        if isinstance(entries, list):
            return entries
    return []


def _align(language: str, transcript: str, audio_bytes: bytes, suffix: str) -> list[dict]:
    models = LANGUAGE_MODELS[language]
    with tempfile.TemporaryDirectory(prefix="mis-aligner-") as tmp:
        work = Path(tmp)
        raw = work / f"input{suffix or '.bin'}"
        wav = work / "speech.wav"
        text = work / "speech.txt"
        output = work / "alignment.json"

        raw.write_bytes(audio_bytes)
        text.write_text(transcript.strip() + "\n", encoding="utf-8")
        _normalise_audio(raw, wav)

        cmd = [
            MFA_BIN, "align_one",
            str(wav),
            str(text),
            models["dictionary"],
            models["acoustic"],
            str(output),
            "--output_format", "json",
            "--g2p_model_path", models["g2p"],
            "--clean",
            "--quiet",
        ]
        _run(cmd, timeout=900)

        if not output.exists():
            raise RuntimeError("MFA did not create alignment JSON")
        payload = json.loads(output.read_text(encoding="utf-8"))
        entries = _find_phone_entries(payload)
        if not entries:
            raise RuntimeError("MFA alignment contains no phone tier")

        phones = []
        for entry in entries:
            if not isinstance(entry, list) or len(entry) < 3:
                continue
            start, end, label = entry[0], entry[1], str(entry[2]).strip()
            if not label or label in {"sil", "sp", "spn"}:
                label = "sil"
            try:
                start_ms = max(0, round(float(start) * 1000))
                end_ms = max(start_ms + 1, round(float(end) * 1000))
            except (TypeError, ValueError):
                continue
            phones.append({
                "phoneme": label,
                "startMs": start_ms,
                "endMs": end_ms,
                # MFA JSON does not expose calibrated per-phone probability.
                "confidence": 1.0,
            })
        if not phones:
            raise RuntimeError("MFA produced no usable phone intervals")
        return phones


@app.get("/health")
async def health(authorization: Optional[str] = Header(default=None)):
    _require_auth(authorization)
    mfa = shutil.which(MFA_BIN)
    ffmpeg = shutil.which(FFMPEG_BIN)
    return {
        "ok": bool(mfa and ffmpeg),
        "provider": "montreal-forced-aligner",
        "experimental": True,
        "mfa": mfa,
        "ffmpeg": ffmpeg,
        "languages": sorted(LANGUAGE_MODELS.keys()),
        "models": LANGUAGE_MODELS,
    }


@app.post("/v1/align")
async def align(request: AlignRequest, authorization: Optional[str] = Header(default=None)):
    _require_auth(authorization)
    if not shutil.which(MFA_BIN):
        raise HTTPException(status_code=503, detail="MFA executable is not installed")
    if not shutil.which(FFMPEG_BIN):
        raise HTTPException(status_code=503, detail="FFmpeg executable is not installed")

    mime = (request.audioMime or "").lower()
    suffix = ".wav" if "wav" in mime else ".mp3" if "mpeg" in mime or "mp3" in mime else ".bin"
    try:
        phones = _align(
            request.language,
            request.transcript,
            _decode_audio(request.audioBase64),
            suffix,
        )
        return {
            "ok": True,
            "provider": "montreal-forced-aligner",
            "language": request.language,
            "phones": phones,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:4000]) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("MIS_ALIGNER_HOST", "127.0.0.1"),
        port=int(os.environ.get("MIS_ALIGNER_PORT", "9873")),
    )
