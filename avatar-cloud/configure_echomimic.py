"""Apply or verify the explicit low-VRAM patch for the pinned nosi checkout."""
import os
from pathlib import Path
import subprocess
import sys

NOSI_COMMIT = "a6bdb2a93ce2754dcbb1de74ac89c513b655f99f"
PATCH = Path(__file__).with_name("echomimic-low-vram.patch")


def verify_memory_patch(engine):
    result = subprocess.run(
        ["git", "-C", str(engine), "apply", "--reverse", "--check", str(PATCH)],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError(
            "EchoMimic low-VRAM patch is missing or incompatible; run "
            f"configure_echomimic.py with the pinned checkout:\n{result.stderr}"
        )


def configure(engine):
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise RuntimeError("EchoMimic setup requires a Linux cloud worker")
    engine = Path(engine).resolve()
    revision = subprocess.run(
        ["git", "-C", str(engine), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if revision != NOSI_COMMIT:
        raise RuntimeError("Unsupported nosi revision for the memory patch")
    installed = subprocess.run(
        ["git", "-C", str(engine), "apply", "--reverse", "--check", str(PATCH)],
        capture_output=True, text=True, timeout=30,
    )
    if installed.returncode:
        subprocess.run(
            ["git", "-C", str(engine), "apply", "--check", str(PATCH)],
            check=True, capture_output=True, text=True, timeout=30,
        )
        subprocess.run(
            ["git", "-C", str(engine), "apply", str(PATCH)],
            check=True, capture_output=True, text=True, timeout=30,
        )
    verify_memory_patch(engine)
    print("EchoMimic low-VRAM patch verified", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: configure_echomimic.py NOSI_CHECKOUT")
    configure(sys.argv[1])
