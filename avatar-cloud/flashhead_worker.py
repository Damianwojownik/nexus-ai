"""Separate cloud entrypoint; existing LivePortrait deployments are unchanged."""
import logging
import os
from pathlib import Path
import subprocess
import sys

from render_flashhead import model_type, require_cloud, require_models, validate_gpu
from worker import Jobs, make_server


def render(directory):
    with (directory / "render.log").open("w", encoding="utf-8") as log:
        subprocess.run([sys.executable, str(Path(__file__).with_name("render_flashhead.py")),
                        str(directory)], stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=1900)


def main():
    require_cloud()
    token = os.environ.get("NEXUS_AVATAR_SERVER_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("Configure NEXUS_AVATAR_SERVER_TOKEN with at least 32 random characters")
    import torch
    validate_gpu(torch)
    quality = model_type()
    require_models(Path(os.environ.get("NEXUS_FLASHHEAD_DIR", "/opt/SoulX-FlashHead")), quality)
    logging.basicConfig(level=logging.INFO)
    jobs = Jobs(os.environ.get("NEXUS_JOB_DIR", "/data/jobs"), render)
    make_server("0.0.0.0", 8000, token, jobs, engine="soulx-flashhead-" + quality).serve_forever()


if __name__ == "__main__":
    main()
