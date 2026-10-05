"""Explicit, reference-locked offline EchoMimic experiment, up to 180 seconds."""
import argparse
import asyncio
import hashlib
import logging
import os
from pathlib import Path
import re
import sys

from render_echomimic import render_job


def verify_reference(job, expected_hash):
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise ValueError("Provide the lowercase SHA-256 of the original portrait")
    portraits = [job / name for name in ("portrait.png", "portrait.jpg")
                 if (job / name).is_file()]
    if len(portraits) != 1:
        raise ValueError("Provide exactly one original portrait PNG/JPEG")
    if hashlib.sha256(portraits[0].read_bytes()).hexdigest() != expected_hash:
        raise ValueError("Original portrait SHA-256 mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path)
    parser.add_argument("--reference-sha256", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative-prompt", required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Long EchoMimic rendering requires an authorized Linux cloud worker")
    if not args.prompt.strip() or not args.negative_prompt.strip():
        raise ValueError("Both generation prompts must be nonempty")
    verify_reference(args.job, args.reference_sha256)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    asyncio.run(render_job(
        args.job, max_audio_seconds=180,
        prompt=args.prompt, negative_prompt=args.negative_prompt,
    ))


if __name__ == "__main__":
    main()
