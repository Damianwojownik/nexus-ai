"""Build reviewed static expression references, never a new body or animation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from expression_edit import preserve_motion_frame, validate_face_region


def read_frame(path, index):
    import cv2
    if type(index) is not int or index < 0:
        raise ValueError("Frame index must be a nonnegative integer")
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise RuntimeError(f"Cannot decode expression reference video: {path}")
        for _ in range(index + 1):
            ok, frame = capture.read()
            if not ok:
                raise ValueError(f"Reference frame {index} does not exist in {path}")
        return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    finally:
        capture.release()


def build_references(job):
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Expression references require the remote cloud worker")
    import numpy as np
    from PIL import Image

    settings = json.loads((job / "expression-references.json").read_text(encoding="utf-8"))
    if not isinstance(settings, dict) or set(settings) != {"masterClip", "masterFrame", "faceRegion", "variants"}:
        raise ValueError("Reference settings require masterClip, masterFrame, faceRegion and variants")
    master = Path(settings["masterClip"])
    if not master.is_file():
        raise ValueError("masterClip must be an existing reviewed body video")
    base = read_frame(master, settings["masterFrame"])
    validate_face_region(settings["faceRegion"], base.shape[1], base.shape[0])
    variants = settings["variants"]
    if not isinstance(variants, list) or len(variants) != 2:
        raise ValueError("Provide exactly eyes_closed and smile reference variants")
    prepared = {}
    provenance = []
    for variant in variants:
        if not isinstance(variant, dict) or set(variant) != {"role", "sourceClip", "frame", "maskImage"}:
            raise ValueError("Each variant requires role, sourceClip, frame and maskImage")
        role = variant["role"]
        if not isinstance(role, str) or role not in {"eyes_closed", "smile"} or role in prepared:
            raise ValueError("Provide distinct eyes_closed and smile roles")
        source, mask_path = Path(variant["sourceClip"]), Path(variant["maskImage"])
        if not source.is_file() or not mask_path.is_file():
            raise ValueError("Variant sourceClip and maskImage must exist")
        edited = read_frame(source, variant["frame"])
        with Image.open(mask_path) as image:
            if image.mode != "L":
                raise ValueError("Reference mask must be grayscale L, not an RGB image")
            mask = np.asarray(image).copy()
        if not np.any(mask):
            raise ValueError("Reference mask cannot be empty")
        result = preserve_motion_frame(base, edited, mask, settings["faceRegion"])
        if float(np.abs(result.astype(float) - base.astype(float))[mask > 0].mean()) < 2:
            raise ValueError(f"{role} is too similar to the master; review donor frame and mask")
        prepared[role] = result
        provenance.append({
            **variant, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "maskSha256": hashlib.sha256(mask_path.read_bytes()).hexdigest(),
            "protectedPixelsExact": True,
        })
    destination = job / "references"
    destination.mkdir()
    Image.fromarray(base).save(destination / "eyes_open.png")
    for role, pixels in prepared.items():
        path = destination / (role + ".png")
        Image.fromarray(pixels).save(path)
        with Image.open(path) as saved:
            if not np.array_equal(np.asarray(saved), pixels):
                raise RuntimeError("Lossless reference PNG changed pixels")
    manifest = {
        "version": 1, "kind": "localized-expression-references",
        "masterClip": str(master), "masterFrame": settings["masterFrame"],
        "masterSha256": hashlib.sha256(master.read_bytes()).hexdigest(),
        "faceRegion": settings["faceRegion"], "variants": provenance,
        "roles": ["eyes_open", "eyes_closed", "smile"],
        "staticReferencesOnly": True, "visualApproval": False,
        "bodyRegenerated": False, "newModelInference": False,
        "requiresVisualReview": True, "requiresSameIdentityAndAlignedFace": True,
    }
    (destination / "references.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("job")
    args = parser.parse_args()
    print("EXPRESSION_REFERENCES_READY", build_references(Path(args.job).resolve()))
