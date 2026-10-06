from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inspect a visually approved Nexus idle/base video and print worker env values."
    )
    parser.add_argument("video")
    parser.add_argument("--min-seconds", type=float, default=3.0)
    parser.add_argument("--max-seconds", type=float, default=30.0)
    args = parser.parse_args()

    video = Path(args.video).resolve()
    if not video.is_file() or video.stat().st_size == 0:
        raise SystemExit(f"Video does not exist: {video}")

    capture = cv2.VideoCapture(str(video))
    try:
        if not capture.isOpened():
            raise SystemExit("OpenCV could not decode the supplied base video")
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    finally:
        capture.release()

    if fps <= 0 or frames <= 0 or width < 256 or height < 256:
        raise SystemExit("Base video metadata is invalid or too small")
    duration = frames / fps
    if duration < args.min_seconds or duration > args.max_seconds:
        raise SystemExit(
            f"Base video duration {duration:.2f}s is outside {args.min_seconds:.2f}..{args.max_seconds:.2f}s"
        )

    digest = sha256(video)
    report = {
        "path": str(video),
        "sha256": digest,
        "fps": round(fps, 3),
        "frames": frames,
        "durationSeconds": round(duration, 3),
        "width": width,
        "height": height,
    }
    print(json.dumps(report, indent=2))
    print()
    print("Set only after visually confirming this is the canonical Nexus identity:")
    print(f'NEXUS_LIVE_BASE_VIDEO={video}')
    print(f'NEXUS_LIVE_BASE_VIDEO_SHA256={digest}')


if __name__ == "__main__":
    main()
