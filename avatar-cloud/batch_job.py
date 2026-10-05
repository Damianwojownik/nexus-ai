"""Read the app's portable face request; inference stays in the cloud."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from worker import MAX_BODY, validate_job


def prepare_request(source, root):
    source = Path(source)
    if source.stat().st_size > MAX_BODY:
        raise ValueError("Request must be at most 8 MB")
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"version", "kind", "requestId", "mime", "image", "text"}:
        raise ValueError("Unsupported batch request fields")
    if type(value["version"]) is not int or value["version"] != 1 or value["kind"] != "nexus-face-job":
        raise ValueError("Unsupported batch request version or kind")
    request_id = value["requestId"]
    if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
        raise ValueError("Invalid request ID")
    image, extension, text = validate_job(value)
    if len(text) > 300:
        raise ValueError("Colab batch script must contain 1 to 300 characters")
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    job = root / ("batch-" + request_id)
    job.mkdir()
    (job / ("portrait" + extension)).write_bytes(image)
    (job / "script.txt").write_text(text, encoding="utf-8")
    (job / "batch-request.json").write_text(json.dumps({
        "version": 1, "kind": "nexus-face-job", "requestId": request_id,
    }, indent=2), encoding="utf-8")
    return job


def main():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Batch inference requires a Linux cloud worker; desktop rendering is blocked")
    parser = argparse.ArgumentParser()
    parser.add_argument("request")
    parser.add_argument("root")
    args = parser.parse_args()
    job = prepare_request(args.request, args.root)
    with (job / "render.log").open("w", encoding="utf-8") as log:
        subprocess.run(
            [sys.executable, str(Path(__file__).with_name("render.py")), str(job)],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1800,
        )
    if not (job / "video.mp4").is_file():
        raise RuntimeError("Renderer did not produce video.mp4; inspect render.log")
    print("BATCH_VIDEO_READY", job / "video.mp4")


if __name__ == "__main__":
    main()
