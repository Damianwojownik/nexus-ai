"""Sequential, cloud-only batch controller for interchangeable avatar adapters."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ADAPTERS = {
    "faster-liveportrait": ("render.py", "video.mp4"),
    "flashhead": ("render_flashhead.py", "video.mp4"),
    "ltx-body": ("render_body.py", "video.mp4"),
    "vace-expression": ("render_expression.py", "expression.mp4"),
    "scene-composer": ("compose_scene.py", "scene.mp4"),
    "echomimic-v3": ("render_echomimic.py", "video.mp4"),
}
PLANNED = {"wan2.2-cinema", "musetalk-lips", "vace-body"}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_plan(root):
    value = json.loads((root / "render-plan.json").read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"version", "jobs"}:
        raise ValueError("render-plan.json requires only version and jobs")
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Unsupported render plan version")
    jobs = value["jobs"]
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= 16:
        raise ValueError("Render queue must contain 1 to 16 jobs")
    resolved = []
    for item in jobs:
        if not isinstance(item, dict) or set(item) != {"engine", "directory"}:
            raise ValueError("Each job requires only engine and directory")
        engine, name = item["engine"], item["directory"]
        if not isinstance(engine, str) or engine not in ADAPTERS:
            if isinstance(engine, str) and engine in PLANNED:
                raise ValueError(f"{engine} is planned, not integrated; no substitute will run")
            raise ValueError("Unknown render engine")
        if not isinstance(name, str) or not name or Path(name).is_absolute():
            raise ValueError("Job directory must be relative to the batch root")
        directory = (root / name).resolve()
        if directory.parent != root or not directory.is_dir():
            raise ValueError("Jobs must be distinct direct subdirectories of the batch root")
        if any(directory == previous[1] for previous in resolved):
            raise ValueError("A job directory cannot be queued twice")
        output = directory / ADAPTERS[engine][1]
        if output.exists():
            raise FileExistsError(f"Existing output preserved: {output}; use a new job")
        resolved.append((engine, directory, output))
    return resolved


def probe_output(output):
    if not output.is_file() or not output.stat().st_size:
        raise RuntimeError(f"Adapter did not produce a nonempty video: {output}")
    result = subprocess.run([
        "ffprobe", "-v", "error", "-count_frames", "-show_entries",
        "stream=codec_type,width,height,nb_read_frames,avg_frame_rate",
        "-of", "json", str(output),
    ], check=True, capture_output=True, text=True, timeout=120)
    streams = json.loads(result.stdout)["streams"]
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(videos) != 1 or int(videos[0].get("nb_read_frames", "0")) < 2:
        raise RuntimeError("Rendered file must contain one decodable video with at least two frames")
    video = videos[0]
    if int(video.get("width", 0)) <= 0 or int(video.get("height", 0)) <= 0:
        raise RuntimeError("Rendered video has invalid dimensions")
    return {"streams": streams, "sha256": sha256(output), "bytes": output.stat().st_size}


def save_state(root, state):
    temporary = root / "render-state.tmp"
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temporary.replace(root / "render-state.json")


def run_batch(root):
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Nexus Render Engine requires the Linux cloud worker; desktop inference is blocked")
    root = Path(root).resolve()
    lock = root / "render.lock"
    with lock.open("x", encoding="utf-8") as stream:
        stream.write(f"pid={os.getpid()}\n")
    try:
        if (root / "render-state.json").exists():
            raise FileExistsError("Batch history preserved; use a new batch directory for retries")
        jobs = read_plan(root)
        state = {
            "version": 1, "status": "processing", "created": time.time(),
            "visualApproval": False, "jobs": [
                {"engine": engine, "directory": directory.name, "status": "pending"}
                for engine, directory, _ in jobs
            ],
        }
        save_state(root, state)
        for index, (engine, directory, output) in enumerate(jobs):
            record = state["jobs"][index]
            record.update(status="processing", started=time.time())
            save_state(root, state)
            try:
                script = Path(__file__).with_name(ADAPTERS[engine][0])
                python = os.environ.get("NEXUS_RENDER_PYTHON_" + engine.upper().replace("-", "_"), sys.executable)
                if not Path(python).is_file():
                    raise ValueError(f"Configured interpreter does not exist for {engine}")
                with (directory / "nexus-render.log").open("x", encoding="utf-8") as log:
                    subprocess.run(
                        [python, str(script), str(directory)], check=True, timeout=3600,
                        stdout=log, stderr=subprocess.STDOUT,
                    )
                record.update(status="rendered", output=output.name, **probe_output(output))
            except (OSError, ValueError, KeyError, subprocess.SubprocessError, RuntimeError) as error:
                record.update(status="error", error=f"{type(error).__name__}: {error}")
                state["status"] = "error"
                for pending in state["jobs"][index + 1:]:
                    pending.update(status="blocked", error="Previous job failed; no further GPU jobs started")
                save_state(root, state)
                raise
            record["finished"] = time.time()
            save_state(root, state)
        state.update(status="rendered", finished=time.time())
        save_state(root, state)
        return root / "render-state.json"
    finally:
        lock.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("batch")
    args = parser.parse_args()
    print("NEXUS_RENDER_BATCH_READY", run_batch(args.batch))


if __name__ == "__main__":
    main()
