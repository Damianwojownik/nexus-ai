"""Cloud-only Blender orchestration; never run Blender on the desktop."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import wave

from render import verify_video
from rig_motion import settings
from verify_rig import verify


def main():
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("Skeletal rendering is restricted to the cloud worker")
    job = Path(sys.argv[1]).resolve()
    config = settings(json.loads((job / "rig.json").read_text(encoding="utf-8")))
    blender = shutil.which("blender")
    if not blender:
        raise RuntimeError("Install Blender in the remote runtime before rendering")
    script = (job / "script.txt").read_text(encoding="utf-8").strip()
    if not script or len(script) > 300:
        raise ValueError("Rig preview speech requires 1..300 characters")
    audio = job / "speech.wav"
    subprocess.run(["espeak-ng", "-v", "pl", "-s", "150", "-f", str(job / "script.txt"),
                    "-w", str(audio)], check=True, timeout=60)
    with wave.open(str(audio), "rb") as speech:
        duration = speech.getnframes() / speech.getframerate()
    if duration <= 0 or duration > config["seconds"]:
        raise ValueError("Speech must fit the rig preview; increase seconds or shorten the script")
    (job / "rig.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    subprocess.run([blender, "--background", "--factory-startup", "--threads", "2",
                    "--python-exit-code", "1", "--python",
                    str(Path(__file__).with_name("blender_rig.py")), "--", str(job)],
                   check=True, timeout=2400)
    exported_motion = verify(job / "character.glb", config["action"])
    (job / "export-verification.json").write_text(json.dumps(exported_motion, indent=2), encoding="utf-8")
    subprocess.run(["ffmpeg", "-y", "-i", str(job / "rig-silent.mp4"), "-i", str(audio),
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                    "-af", "apad", "-t", str(config["seconds"]), "-movflags", "+faststart",
                    str(job / "video.mp4")], check=True, timeout=120)
    verify_video(str(job / "video.mp4"))
    for filename in ("character.glb", "character.blend", "rig-report.json"):
        if not (job / filename).is_file() or (job / filename).stat().st_size == 0:
            raise RuntimeError("Missing persistent rig output: " + filename)
    print("RIG_VIDEO_READY", job / "video.mp4", flush=True)


if __name__ == "__main__":
    main()
