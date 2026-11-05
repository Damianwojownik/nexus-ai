from __future__ import annotations

from dataclasses import dataclass, asdict
import os
from typing import Dict, List


@dataclass(frozen=True)
class EngineSpec:
    id: str
    role: str
    enabled: bool
    endpoint: str
    gpu_min_vram_gb: int
    notes: str

    def public(self) -> dict:
        return asdict(self)


def _enabled(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def registry() -> Dict[str, EngineSpec]:
    return {
        "liveportrait": EngineSpec(
            id="liveportrait",
            role="portrait-motion",
            enabled=_enabled("NEXUS_ENGINE_LIVEPORTRAIT", True),
            endpoint=os.getenv("NEXUS_LIVEPORTRAIT_URL", "http://liveportrait:9872"),
            gpu_min_vram_gb=6,
            notes="Talking head / motion transfer. Current self-hosted implementation.",
        ),
        "musetalk": EngineSpec(
            id="musetalk",
            role="lip-sync",
            enabled=_enabled("NEXUS_ENGINE_MUSETALK", True),
            endpoint=os.getenv("NEXUS_MUSETALK_URL", "http://musetalk:9881"),
            gpu_min_vram_gb=8,
            notes="Dedicated high-fidelity mouth/lip-sync service.",
        ),
        "echomimic": EngineSpec(
            id="echomimic",
            role="full-body-motion",
            enabled=_enabled("NEXUS_ENGINE_ECHOMIMIC", True),
            endpoint=os.getenv("NEXUS_ECHOMIMIC_URL", "http://echomimic:9882"),
            gpu_min_vram_gb=12,
            notes="Audio/text conditioned face + body motion service.",
        ),
        "editor": EngineSpec(
            id="editor",
            role="video-editing",
            enabled=_enabled("NEXUS_ENGINE_EDITOR", False),
            endpoint=os.getenv("NEXUS_EDITOR_URL", "http://editor:9883"),
            gpu_min_vram_gb=16,
            notes="Future style/subject/background/try-on shared video transformer.",
        ),
    }


def public_registry() -> List[dict]:
    return [spec.public() for spec in registry().values()]
