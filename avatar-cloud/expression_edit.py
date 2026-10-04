"""Read a shared motion timeline and restrict facial edits to authorized pixels."""
import json
import math
from pathlib import Path

import numpy as np

from scene_layers import compose_scene_frame


def validate_face_region(region, width, height):
    if (
        not isinstance(region, list) or len(region) != 4
        or any(type(value) is not int for value in region)
    ):
        raise ValueError("faceRegion requires integer [x, y, width, height]")
    x, y, w, h = region
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
        raise ValueError("faceRegion must be inside the source frame")
    return x, y, w, h


def validate_expression_mask(mask, shape, region):
    pixels = np.asarray(mask)
    if pixels.dtype != np.uint8 or pixels.shape != shape:
        raise ValueError("Expression mask must be a same-size uint8 grayscale frame")
    x, y, w, h = validate_face_region(region, shape[1], shape[0])
    outside = pixels.copy()
    outside[y:y + h, x:x + w] = 0
    if np.any(outside):
        raise ValueError("Expression mask edits pixels outside the authorized faceRegion")
    return pixels


def preserve_motion_frame(source, edited, mask, region):
    base = np.asarray(source)
    pixels = validate_expression_mask(mask, base.shape[:2], region)
    result = compose_scene_frame(edited, base, pixels)
    if not np.array_equal(result[pixels == 0], base[pixels == 0]):
        raise RuntimeError("Facial editing changed protected motion pixels")
    return result


def read_expression_inputs(job):
    import cv2
    from PIL import Image

    settings = json.loads((job / "expression-edit.json").read_text(encoding="utf-8"))
    if not isinstance(settings, dict) or set(settings) != {"sourceClip", "maskClip", "faceRegion"}:
        raise ValueError("expression-edit.json requires sourceClip, maskClip and faceRegion")
    paths = []
    for key in ("sourceClip", "maskClip"):
        value = settings[key]
        if not isinstance(value, str) or not Path(value).is_file():
            raise ValueError(f"{key} must point to an existing video")
        paths.append(Path(value))
    captures = [cv2.VideoCapture(str(path)) for path in paths]
    try:
        if not all(capture.isOpened() for capture in captures):
            raise RuntimeError("Cannot decode source and expression mask videos")
        rates = [capture.get(cv2.CAP_PROP_FPS) for capture in captures]
        counts = [capture.get(cv2.CAP_PROP_FRAME_COUNT) for capture in captures]
        sizes = [
            (int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
            for capture in captures
        ]
        if (
            any(not math.isfinite(rate) or rate <= 0 for rate in rates)
            or abs(rates[0] - rates[1]) > .001
            or any(not math.isfinite(count) or count != int(count) for count in counts)
            or counts[0] != counts[1] or not 33 <= counts[0] <= 97
            or (int(counts[0]) - 1) % 4
            or sizes[0] != sizes[1] or any(size <= 0 or size % 16 for size in sizes[0])
        ):
            raise ValueError("Source/mask must match FPS, dimensions divisible by 16 and 33-97 frames of form 4k+1")
        region = settings["faceRegion"]
        validate_face_region(region, *sizes[0])
        sources, masks = [], []
        for index in range(int(counts[0])):
            pair = [capture.read() for capture in captures]
            if not all(ok for ok, _ in pair):
                raise RuntimeError(f"Expression input ended unexpectedly at frame {index}")
            source, mask = [frame for _, frame in pair]
            if not np.array_equal(mask[:, :, 0], mask[:, :, 1]) or not np.array_equal(mask[:, :, 0], mask[:, :, 2]):
                raise ValueError("Expression mask video must be grayscale")
            pixels = validate_expression_mask(mask[:, :, 0], source.shape[:2], region)
            sources.append(Image.fromarray(cv2.cvtColor(source, cv2.COLOR_BGR2RGB)))
            masks.append(Image.fromarray(pixels))
        if not any(np.any(mask) for mask in masks):
            raise ValueError("Expression mask contains no authorized edits")
        return settings, sources, masks, rates[0]
    finally:
        for capture in captures:
            capture.release()
