"""Explicit cloud-only model download; never runs at import or worker startup."""
import os
from pathlib import Path

from render_flashhead import model_type, require_cloud


def main():
    require_cloud()
    if os.environ.get("NEXUS_MODEL_DOWNLOAD_CONSENT") != "1":
        raise RuntimeError("Set NEXUS_MODEL_DOWNLOAD_CONSENT=1 to authorize cloud model downloads")
    engine = Path(os.environ.get("NEXUS_FLASHHEAD_DIR", "/opt/SoulX-FlashHead"))
    if not (engine / "generate_video.py").is_file():
        raise RuntimeError("Install the pinned FlashHead code before downloading models")
    from huggingface_hub import snapshot_download
    quality = model_type()
    patterns = ["Model_Pro/**", "VAE_Wan/**"] if quality == "pro" else ["Model_Lite/**", "VAE_LTX/**"]
    snapshot_download("Soul-AILab/SoulX-FlashHead-1_3B",
                      allow_patterns=patterns + ["README.md", "LICENSE*"],
                      local_dir=engine / "models/SoulX-FlashHead-1_3B")
    snapshot_download("facebook/wav2vec2-base-960h",
                      local_dir=engine / "models/wav2vec2-base-960h")


if __name__ == "__main__":
    main()
