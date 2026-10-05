"""Miś Engine v1 — TEST / EXPERIMENTAL.

Direct articulation injection for FasterLivePortrait motion templates.

This module intentionally controls only mouth-related expression coordinates.
FasterLivePortrait does not expose an animal-safe tongue retargeting model, so
tongue, teeth and airflow remain control/teaching/haptic channels and are NOT
claimed to be directly rendered by this adapter.

The lip keypoint set follows LivePortrait/FasterLivePortrait's own
animation_region="lip" indices: 6, 12, 14, 17, 19, 20.

The projection below is deliberately conservative and configurable. It starts
from audio-generated JoyVASA motion and applies small deterministic expression
corrections instead of replacing natural motion.
"""
from __future__ import annotations

import copy
import json
import pickle
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

LIP_INDICES = (6, 12, 14, 17, 19, 20)

NEUTRAL = {
    "jawOpen": 0.04,
    "lipWide": 0.18,
    "lipRound": 0.06,
    "lipProtrusion": 0.04,
    "lipPress": 0.08,
}


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def parse_controls(value: str | None) -> list[dict[str, float]]:
    if not value:
        return []
    raw = json.loads(value)
    if not isinstance(raw, list):
        raise ValueError("articulation_json must be a JSON array")

    controls: list[dict[str, float]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"articulation_json[{index}] must be an object")
        at_ms = float(item.get("atMs", 0.0))
        if not np.isfinite(at_ms) or at_ms < 0:
            raise ValueError(f"articulation_json[{index}].atMs is invalid")
        control = {"atMs": at_ms}
        for key in NEUTRAL:
            raw_value = float(item.get(key, NEUTRAL[key]))
            if not np.isfinite(raw_value):
                raise ValueError(f"articulation_json[{index}].{key} is invalid")
            control[key] = _clamp(raw_value)
        controls.append(control)

    controls.sort(key=lambda x: x["atMs"])
    return controls


def _interpolate(a: dict[str, float], b: dict[str, float], t: float) -> dict[str, float]:
    t = _clamp(t)
    out = {"atMs": a["atMs"] + (b["atMs"] - a["atMs"]) * t}
    for key in NEUTRAL:
        out[key] = a[key] + (b[key] - a[key]) * t
    return out


def sample_control(controls: list[dict[str, float]], at_ms: float) -> dict[str, float]:
    if not controls:
        return {"atMs": at_ms, **NEUTRAL}
    if at_ms <= controls[0]["atMs"]:
        return controls[0]
    if at_ms >= controls[-1]["atMs"]:
        return controls[-1]

    lo = 0
    hi = len(controls) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if controls[mid]["atMs"] <= at_ms:
            lo = mid
        else:
            hi = mid

    a, b = controls[lo], controls[hi]
    span = max(1e-6, b["atMs"] - a["atMs"])
    return _interpolate(a, b, (at_ms - a["atMs"]) / span)


def apply_articulation_to_exp(
    exp: np.ndarray,
    control: dict[str, float],
    strength: float = 0.35,
) -> np.ndarray:
    """Apply a small mouth correction to a LivePortrait 21x3 expression tensor."""
    if exp.ndim != 3 or exp.shape[1] < 21 or exp.shape[2] < 3:
        raise ValueError(f"Unexpected FasterLivePortrait exp shape: {exp.shape}")

    out = exp.copy()
    s = _clamp(strength, 0.0, 1.0)

    jaw = (control["jawOpen"] - NEUTRAL["jawOpen"]) * s
    wide = (control["lipWide"] - NEUTRAL["lipWide"]) * s
    rounded = (control["lipRound"] - NEUTRAL["lipRound"]) * s
    protrude = (control["lipProtrusion"] - NEUTRAL["lipProtrusion"]) * s
    press = max(0.0, control["lipPress"] - NEUTRAL["lipPress"]) * s

    mouth_amount = jaw * 28.0
    out[:, 19, 1] += mouth_amount * 0.001
    out[:, 19, 2] += mouth_amount * 0.0001
    out[:, 17, 1] -= mouth_amount * 0.0001

    eee_amount = wide * 12.0
    out[:, 20, 2] -= eee_amount * 0.001
    out[:, 20, 1] -= eee_amount * 0.001
    out[:, 14, 1] -= eee_amount * 0.001

    woo_amount = (rounded * 0.7 + protrude * 0.3) * 12.0
    out[:, 14, 1] += woo_amount * 0.001
    out[:, 17, 2] -= woo_amount * 0.0005

    press_amount = press * 24.0
    out[:, 19, 1] -= press_amount * 0.001
    out[:, 20, 1] += press_amount * 0.00025
    out[:, 14, 1] += press_amount * 0.00025

    return out.astype(np.float32, copy=False)


def patch_motion_sequence(
    motion_template: dict[str, Any],
    controls: list[dict[str, float]],
    strength: float = 0.35,
) -> dict[str, Any]:
    patched = copy.deepcopy(motion_template)
    motions = patched.get("motion")
    if not isinstance(motions, list):
        raise ValueError("FasterLivePortrait motion template has no motion[]")

    fps = float(patched.get("output_fps") or 25.0)
    if not np.isfinite(fps) or fps <= 0:
        fps = 25.0

    for frame_index, motion in enumerate(motions):
        if not isinstance(motion, dict) or "exp" not in motion:
            continue
        exp = np.asarray(motion["exp"], dtype=np.float32)
        at_ms = frame_index * 1000.0 / fps
        motion["exp"] = apply_articulation_to_exp(
            exp,
            sample_control(controls, at_ms),
            strength,
        )

    patched["mis_articulation"] = {
        "experimental": True,
        "version": 1,
        "strength": _clamp(strength),
        "controlled": ["jawOpen", "lipWide", "lipRound", "lipProtrusion", "lipPress"],
        "not_directly_rendered": ["tongueX", "tongueY", "tongueTip", "teethGap", "voicing", "airflow", "nasal"],
    }
    return patched


def _ffmpeg() -> str:
    if platform.system().lower() == "windows":
        bundled = Path("third_party/ffmpeg-7.0.1-full_build/bin/ffmpeg.exe")
        if bundled.exists():
            return str(bundled)
    return shutil.which("ffmpeg") or "ffmpeg"


def render_controlled_audio(
    pipe: Any,
    audio_path: Path,
    source_path: Path,
    save_dir: Path,
    controls: list[dict[str, float]],
    strength: float = 0.35,
) -> Path:
    """Generate JoyVASA motion, inject Miś articulation, render, then mux audio."""
    from src.pipelines.joyvasa_audio_to_motion_pipeline import JoyVASAAudio2MotionPipeline

    save_dir.mkdir(parents=True, exist_ok=True)
    if getattr(pipe, "joyvasa_pipe", None) is None:
        pipe.joyvasa_pipe = JoyVASAAudio2MotionPipeline(
            motion_model_path=pipe.cfg.joyvasa_models.motion_model_path,
            audio_model_path=pipe.cfg.joyvasa_models.audio_model_path,
            motion_template_path=pipe.cfg.joyvasa_models.motion_template_path,
            cfg_mode=pipe.cfg.infer_params.cfg_mode,
            cfg_scale=pipe.cfg.infer_params.cfg_scale,
        )

    motion_template = pipe.joyvasa_pipe.gen_motion_sequence(str(audio_path))
    patched = patch_motion_sequence(motion_template, controls, strength)

    pkl_path = save_dir / "mis-controlled-motion.pkl"
    with pkl_path.open("wb") as handle:
        pickle.dump(patched, handle)

    org_path, _crop_path, _elapsed = pipe.run_pickle_driving(
        str(pkl_path),
        str(source_path),
        save_dir=str(save_dir),
    )

    org_path = Path(org_path)
    if not org_path.is_absolute():
        org_path = Path.cwd() / org_path

    final_path = save_dir / "mis-controlled-audio.mp4"
    cmd = [
        _ffmpeg(),
        "-y",
        "-i",
        str(org_path),
        "-i",
        str(audio_path),
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-crf",
        "17",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        str(final_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not final_path.exists():
        raise RuntimeError(f"ffmpeg articulation mux failed: {result.stderr[-1200:]}")

    return final_path.resolve()
