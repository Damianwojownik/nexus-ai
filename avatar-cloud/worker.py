"""Authenticated cloud-only job server. Importing it never imports CUDA."""
import base64
import binascii
import hmac
import json
import logging
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
import io
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 8 * 1024 * 1024
TTL = 3600


def validate_job_audio(value):
    if "audio" not in value:
        return None
    if value.get("audioMime") != "audio/wav":
        raise ValueError("Conversation audio must be WAV")
    try:
        audio = base64.b64decode(value["audio"], validate=True)
        if len(audio) > 1024 * 1024:
            raise ValueError("Audio exceeds 1 MB")
        with wave.open(io.BytesIO(audio), "rb") as source:
            if (source.getnchannels(), source.getframerate(), source.getsampwidth(), source.getcomptype()) != (1, 16000, 2, "NONE"):
                raise ValueError("Conversation audio requires mono 16000 Hz 16-bit PCM")
            duration = source.getnframes() / 16000
            if not 0.2 <= duration <= 30:
                raise ValueError("Speech must be 0.2-30 seconds; it is never truncated")
            samples = source.readframes(source.getnframes())
            if len(samples) != source.getnframes() * 2 or not any(samples):
                raise ValueError("Speech is truncated or silent")
    except (binascii.Error, TypeError, wave.Error, EOFError) as error:
        raise ValueError("Invalid conversation WAV") from error
    return audio


def validate_job(value):
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    text = value.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 5000:
        raise ValueError("Script must contain 1 to 5000 characters")
    mime = value.get("mime")
    if mime not in ("image/png", "image/jpeg"):
        raise ValueError("PNG or JPEG required")
    try:
        image = base64.b64decode(value["image"], validate=True)
    except (KeyError, ValueError, TypeError, binascii.Error) as error:
        raise ValueError("Invalid base64 image") from error
    if not image or len(image) > 5 * 1024 * 1024:
        raise ValueError("Image must be at most 5 MB")
    signature = b"\x89PNG\r\n\x1a\n" if mime == "image/png" else b"\xff\xd8\xff"
    if not image.startswith(signature):
        raise ValueError("Image content does not match MIME type")
    return image, ".png" if mime == "image/png" else ".jpg", text.strip()


class Jobs:
    def __init__(self, root, renderer):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.renderer = renderer
        self.jobs = {}
        self.lock = threading.Lock()
        self.pending = queue.Queue(maxsize=2)
        threading.Thread(target=self.run, daemon=True).start()

    def submit(self, value):
        image, extension, text = validate_job(value)
        audio = validate_job_audio(value)
        with self.lock:
            self.cleanup()
            if self.pending.full():
                raise queue.Full()
            job_id = str(uuid.uuid4())
            directory = self.root / job_id
            directory.mkdir()
            portrait = directory / ("portrait" + extension)
            portrait.write_bytes(image)
            (directory / "script.txt").write_text(text, encoding="utf-8")
            if audio is not None:
                (directory / "speech.wav").write_bytes(audio)
            self.jobs[job_id] = {"status": "processing", "created": time.time()}
            self.pending.put_nowait(job_id)
        return job_id

    def cleanup(self):
        for job_id, job in list(self.jobs.items()):
            if job["status"] != "processing" and time.time() - job["created"] > TTL:
                shutil.rmtree(self.root / job_id)
                del self.jobs[job_id]

    def get(self, job_id):
        with self.lock:
            self.cleanup()
            job = self.jobs.get(job_id)
            return {key: job[key] for key in ("status", "error") if key in job} if job else None

    def run(self):
        while True:
            job_id = self.pending.get()
            directory = self.root / job_id
            try:
                self.renderer(directory)
                if not (directory / "video.mp4").is_file():
                    raise RuntimeError("Renderer did not produce an MP4")
                with self.lock:
                    self.jobs[job_id]["status"] = "complete"
            except Exception:
                logging.exception("Avatar render failed for job %s", job_id)
                with self.lock:
                    self.jobs[job_id].update(status="error", error="Rendering failed. Check server logs; no local GPU fallback was started.")
            finally:
                self.pending.task_done()


def render(directory):
    engine = os.environ.get("NEXUS_AVATAR_ENGINE", "liveportrait-joyvasa")
    adapter = "render.py"
    python = sys.executable
    if engine == "echomimic-v3":
        if not (directory / "speech.wav").is_file():
            raise ValueError("EchoMimic conversation requires supplied speech.wav; no replacement TTS")
        adapter = "render_echomimic.py"
        python = os.environ.get("NEXUS_RENDER_PYTHON_ECHOMIMIC_V3", sys.executable)
    elif (directory / "speech.wav").is_file():
        raise ValueError("Selected renderer does not preserve supplied conversation audio")
    with (directory / "render.log").open("w", encoding="utf-8") as log:
        subprocess.run(
            [python, str(Path(__file__).with_name(adapter)), str(directory)],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1800,
        )


def make_server(host, port, token, jobs, engine="liveportrait-joyvasa"):
    class Handler(BaseHTTPRequestHandler):
        def json(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.json(401, {"error": "Unauthorized"})
                return False
            return True

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/jobs":
                self.json(404, {"error": "Not found"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > MAX_BODY:
                    self.json(413, {"error": "Body must be between 1 byte and 8 MB"})
                    return
                value = json.loads(self.rfile.read(size))
                job_id = jobs.submit(value)
                self.json(202, {"jobId": job_id, "status": "processing"})
            except (ValueError, UnicodeError) as error:
                self.json(400, {"error": str(error)})
            except queue.Full:
                self.json(429, {"error": "Render queue is full"})
            except OSError:
                logging.exception("Avatar job storage failed")
                self.json(500, {"error": "Job storage failed"})

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/health":
                self.json(200, {"ok": True, "engine": engine, "mode": "batch",
                    **({"suppliedAudio": True, "cost": 0} if engine == "echomimic-v3" and os.environ.get("NEXUS_FREE_MODE") == "true" else {})})
                return
            parts = self.path.strip("/").split("/")
            if len(parts) not in (2, 3) or parts[0] != "jobs":
                self.json(404, {"error": "Not found"})
                return
            job = jobs.get(parts[1])
            if not job:
                self.json(404, {"error": "Job not found or expired"})
                return
            if len(parts) == 2:
                self.json(200, job)
                return
            if parts[2] != "video" or job["status"] != "complete":
                self.json(404, {"error": "Video not ready"})
                return
            try:
                path = jobs.root / parts[1] / "video.mp4"
                with path.open("rb") as video:
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(path.stat().st_size))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    shutil.copyfileobj(video, self.wfile)
            except OSError:
                logging.exception("Video streaming failed")
                self.close_connection = True

        def setup(self):
            super().setup()
            self.connection.settimeout(60)

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    if sys.platform != "linux" or os.environ.get("NEXUS_CLOUD_WORKER") != "1":
        raise SystemExit("Cloud worker must run on a Linux server with NEXUS_CLOUD_WORKER=1. Do not run on the desktop.")
    token = os.environ.get("NEXUS_AVATAR_SERVER_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("Configure a random NEXUS_AVATAR_SERVER_TOKEN of at least 32 characters")
    logging.basicConfig(level=logging.INFO)
    jobs = Jobs(os.environ.get("NEXUS_JOB_DIR", "/data/jobs"), render)
    engine = os.environ.get("NEXUS_AVATAR_ENGINE", "liveportrait-joyvasa")
    make_server("127.0.0.1" if engine == "echomimic-v3" else "0.0.0.0",
                8000, token, jobs, engine=engine).serve_forever()
