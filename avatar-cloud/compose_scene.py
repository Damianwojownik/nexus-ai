"""Cloud-only final composition; neither character nor background is regenerated."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys


def compose(job):
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Scene composition is restricted to the remote cloud worker")
    import cv2
    import numpy as np
    from scene_layers import compose_scene_frame

    settings = json.loads((job / "scene.json").read_text(encoding="utf-8"))
    if not isinstance(settings, dict) or set(settings) != {"characterClip", "backgroundClip", "matteClip"}:
        raise ValueError("scene.json requires characterClip, backgroundClip and matteClip")
    paths = []
    for key in ("characterClip", "backgroundClip", "matteClip"):
        value = settings[key]
        if not isinstance(value, str) or not Path(value).is_file():
            raise ValueError(f"{key} must point to an existing video")
        paths.append(Path(value))
    silent = job / "scene-silent.mp4"
    output = job / "scene.mp4"
    if silent.exists() or output.exists():
        raise ValueError("Scene output already exists; use a new job")
    captures = [cv2.VideoCapture(str(path)) for path in paths]
    try:
        if not all(capture.isOpened() for capture in captures):
            raise RuntimeError("Cannot decode every scene layer")
        rates = [capture.get(cv2.CAP_PROP_FPS) for capture in captures]
        sizes = [
            (int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
            for capture in captures
        ]
        if (
            any(not math.isfinite(rate) or rate <= 0 for rate in rates)
            or any(abs(rate - rates[0]) > .001 for rate in rates)
            or any(size != sizes[0] for size in sizes)
            or any(size <= 0 or size % 2 for size in sizes[0])
        ):
            raise ValueError("Scene layers must match resolution/FPS and cover the entire character clip")
        counts = []
        for capture in captures:
            count = 0
            while capture.read()[0]:
                count += 1
            if not capture.set(cv2.CAP_PROP_POS_FRAMES, 0):
                raise RuntimeError("Cannot rewind a scene layer after timeline validation")
            counts.append(count)
        if not counts[0] or any(count < counts[0] for count in counts):
            raise ValueError("Scene layers must cover the entire decoded character clip")
        width, height = sizes[0]
        count = counts[0]
        with (job / "scene.log").open("w") as log:
            with subprocess.Popen([
                "ffmpeg", "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", f"{width}x{height}", "-r", str(rates[0]), "-i", "pipe:0",
                "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(silent),
            ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log) as encoder:
                for index in range(count):
                    layers = []
                    for capture in captures:
                        ok, frame = capture.read()
                        if not ok:
                            raise RuntimeError(f"Scene layer ended unexpectedly at frame {index}")
                        layers.append(frame)
                    mask = layers[2]
                    if not np.array_equal(mask[:, :, 0], mask[:, :, 1]) or not np.array_equal(mask[:, :, 0], mask[:, :, 2]):
                        raise ValueError("Matte clip must contain grayscale masks, not an RGB portrait")
                    pixels = compose_scene_frame(
                        cv2.cvtColor(layers[0], cv2.COLOR_BGR2RGB),
                        cv2.cvtColor(layers[1], cv2.COLOR_BGR2RGB), mask[:, :, 0],
                    )
                    encoder.stdin.write(pixels.tobytes())
            if encoder.returncode:
                raise RuntimeError(f"Scene encoder failed: see {job / 'scene.log'}")
        subprocess.run([
            "ffmpeg", "-v", "error", "-n", "-i", str(silent), "-i", str(paths[0]),
            "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
            "-t", str(count / rates[0]), "-movflags", "+faststart", str(output),
        ], check=True, timeout=120)
        (job / "scene-settings.json").write_text(json.dumps({
            **settings, "fps": rates[0], "frames": count,
            "width": width, "height": height,
            "characterRegenerated": False, "backgroundRegenerated": False,
            "requiresVisualMatteReview": True,
        }, indent=2), encoding="utf-8")
        return output
    finally:
        for capture in captures:
            capture.release()


if __name__ == "__main__":
    print("SCENE_READY", compose(Path(sys.argv[1]).resolve()))
