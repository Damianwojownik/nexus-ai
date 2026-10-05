"""Connect Portrait Studio image editing to the existing cloud avatar renderers."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def run_stage(command, log, env):
    with log.open("w", encoding="utf-8") as handle:
        result = subprocess.run(command, env=env, stdout=handle, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"Stage failed with exit code {result.returncode}; inspect {log}")


def render_avatar(image, text, output, avatar_root, face_box, approved):
    if not approved:
        raise ValueError("Review the generated face and hands before approving animation")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 300:
        raise ValueError("Speech must contain 1-300 characters")
    from body_layers import validate_face_box
    validate_face_box(face_box)
    from PIL import Image
    image = Path(image).resolve()
    with Image.open(image) as source:
        source.verify()
    output = Path(output)
    output.mkdir()
    face = output / "face"
    face.mkdir()
    body = output / "body"
    body.mkdir()
    with Image.open(image) as source:
        source.convert("RGB").save(body / "portrait.png")
    request = {
        "version": 1, "kind": "nexus-face-job", "requestId": str(uuid.uuid4()),
        "mime": "image/png",
        "image": base64.b64encode((body / "portrait.png").read_bytes()).decode("ascii"),
        "text": text.strip(),
    }
    request_file = output / "face-request.json"
    request_file.write_text(json.dumps(request), encoding="utf-8")
    root = Path(avatar_root).resolve()
    env = dict(os.environ, NEXUS_CLOUD_WORKER="1",
               NEXUS_ENGINE_DIR=str(root / "FasterLivePortrait"))
    run_stage([str(root / "venv/bin/python"), str(root / "batch_job.py"),
               str(request_file), str(face)], output / "face.log", env)
    clips = list(face.glob("batch-*/video.mp4"))
    if len(clips) != 1:
        raise RuntimeError("Face renderer must produce exactly one video")
    run_stage(["ffmpeg", "-v", "error", "-n", "-i", str(clips[0]),
               "-vf", "crop=iw:iw:0:0", "-c:v", "libx264", "-crf", "16",
               "-c:a", "copy", str(body / "face-square.mp4")],
              output / "face-crop.log", env)
    (body / "script.txt").write_text(text.strip(), encoding="utf-8")
    (body / "motion.txt").write_text(
        "Locked camera. Preserve the same person, face, clothing and background. "
        "Gentle breathing and a small head nod. Slow restrained natural wrist "
        "gesture below the face, anatomically correct hands with five fingers. "
        "Keep both hands visible and avoid finger overlap. Smooth continuous motion.",
        encoding="utf-8",
    )
    (body / "negative.txt").write_text(
        "extra fingers, missing fingers, fused fingers, distorted hands, face "
        "identity change, flicker, jerky motion, camera movement, hand covering face",
        encoding="utf-8",
    )
    (body / "body-motion.json").write_text(json.dumps({
        "frames": 97, "returnToSourcePose": False,
    }), encoding="utf-8")
    (body / "body-layers.json").write_text(json.dumps({
        "mode": "tracked", "protectedTop": .32, "feather": .1,
        "faceClip": str((body / "face-square.mp4").resolve()),
        "faceCrop": "upper-square", "faceBox": face_box,
    }), encoding="utf-8")
    run_stage([str(root / "body-venv/bin/python"), str(root / "render_body.py"),
               str(body.resolve())], output / "body.log", env)
    movie = body / "video.mp4"
    from render import verify_video
    verify_video(str(movie))
    (output / "workflow.json").write_text(json.dumps({
        "image": str(image), "imageApproved": True, "text": text.strip(),
        "video": str(movie.resolve()), "requiresVideoHandReview": True,
        "note": "Image approval does not guarantee correct fingers after motion generation.",
    }, indent=2), encoding="utf-8")
    return movie


def main():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Use the Linux GPU Colab runtime, not the desktop")
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("output")
    parser.add_argument("--text", required=True)
    parser.add_argument("--avatar-root", default="/content/nexus-avatar")
    parser.add_argument("--face-box", type=float, nargs=4, required=True,
                        help="Normalized x y width height in the full portrait")
    parser.add_argument("--approved", action="store_true")
    args = parser.parse_args()
    movie = render_avatar(args.image, args.text, args.output, args.avatar_root,
                          args.face_box, args.approved)
    print("PORTRAIT_AVATAR_READY", movie, flush=True)


if __name__ == "__main__":
    main()
