import base64
import json
import io
import wave
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from worker import Jobs, make_server, validate_job, validate_job_audio


class WorkerTests(unittest.TestCase):
    def payload(self):
        return {"image": base64.b64encode(b"\x89PNG\r\n\x1a\nTEST").decode(), "mime": "image/png", "text": "Hello"}

    def test_validation(self):
        self.assertEqual(validate_job(self.payload())[1:], (".png", "Hello"))
        for change in ({"text": ""}, {"text": "a" * 5001}, {"image": "!!!"}, {"mime": "image/jpeg"}):
            with self.assertRaises(ValueError):
                validate_job({**self.payload(), **change})

    def test_conversation_preserves_exact_wav_and_rejects_invalid_audio(self):
        stream = io.BytesIO()
        with wave.open(stream, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\x01\x00" * 16000)
        original = stream.getvalue()
        payload = {**self.payload(), "audio": base64.b64encode(original).decode(), "audioMime": "audio/wav"}
        self.assertEqual(validate_job_audio(payload), original)
        with tempfile.TemporaryDirectory() as root:
            def renderer(directory):
                self.assertEqual((directory / "speech.wav").read_bytes(), original)
                (directory / "video.mp4").write_bytes(b"TEST_VIDEO")
            jobs = Jobs(root, renderer)
            job_id = jobs.submit(payload)
            jobs.pending.join()
            self.assertEqual(jobs.get(job_id)["status"], "complete")
        for change in ({"audio": "!!!"}, {"audioMime": "audio/mp3"}, {"audio": base64.b64encode(original[:100]).decode()}):
            with self.assertRaises(ValueError):
                validate_job_audio({**payload, **change})

    def test_server_auth_job_and_video_without_inference(self):
        with tempfile.TemporaryDirectory() as root:
            def renderer(directory):
                (directory / "video.mp4").write_bytes(b"TEST_VIDEO")
            jobs = Jobs(root, renderer)
            server = make_server("127.0.0.1", 0, "test-token", jobs)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{server.server_port}"
            def request(path, data=None):
                return urllib.request.urlopen(urllib.request.Request(base + path, data, {"Authorization": "Bearer test-token", "Content-Type": "application/json"}), timeout=5)
            try:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(base + "/health", timeout=5)
                self.assertEqual(error.exception.code, 401)
                with request("/jobs", json.dumps(self.payload()).encode()) as response:
                    job_id = json.load(response)["jobId"]
                jobs.pending.join()
                with request("/jobs/" + job_id) as response:
                    self.assertEqual(json.load(response)["status"], "complete")
                with request("/jobs/" + job_id + "/video") as response:
                    self.assertEqual(response.read(), b"TEST_VIDEO")
                self.assertIsNone(jobs.get("../outside"))
            finally:
                server.shutdown()
                server.server_close()

    def test_health_reports_selected_engine(self):
        with tempfile.TemporaryDirectory() as root:
            jobs = Jobs(root, lambda directory: None)
            server = make_server("127.0.0.1", 0, "test-token", jobs, engine="soulx-flashhead-lite")
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/health",
                    headers={"Authorization": "Bearer test-token"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response), {
                        "ok": True, "engine": "soulx-flashhead-lite", "mode": "batch"})
            finally:
                server.shutdown()
                server.server_close()

    def test_renderer_failure_is_not_success(self):
        with tempfile.TemporaryDirectory() as root:
            def failed(directory):
                raise RuntimeError("test render failure")
            jobs = Jobs(root, failed)
            job_id = jobs.submit(self.payload())
            jobs.pending.join()
            self.assertEqual(jobs.get(job_id)["status"], "error")
            self.assertFalse((Path(root) / job_id / "video.mp4").exists())


if __name__ == "__main__":
    unittest.main()
