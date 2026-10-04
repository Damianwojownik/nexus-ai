import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import batch_job


class BatchJobTests(unittest.TestCase):
    def payload(self):
        return {
            "version": 1, "kind": "nexus-face-job",
            "requestId": "01234567-89ab-cdef-0123-456789abcdef",
            "mime": "image/png", "image": base64.b64encode(b"\x89PNG\r\n\x1a\nTEST").decode(),
            "text": "Cześć",
        }

    def test_portable_request_and_no_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / "request.json"
            request.write_text(json.dumps(self.payload()), encoding="utf-8")
            job = batch_job.prepare_request(request, root / "jobs")
            self.assertEqual((job / "script.txt").read_text(encoding="utf-8"), "Cześć")
            self.assertEqual((job / "portrait.png").read_bytes(), b"\x89PNG\r\n\x1a\nTEST")
            self.assertEqual(json.loads((job / "batch-request.json").read_text())["requestId"], self.payload()["requestId"])
            with self.assertRaises(FileExistsError):
                batch_job.prepare_request(request, root / "jobs")

    def test_invalid_requests_create_no_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for change in ({"version": True}, {"kind": "shell"}, {"requestId": "../escape"},
                           {"text": "x" * 301}, {"image": "!!!"}, {"command": "run"}):
                request = root / "request.json"
                request.write_text(json.dumps({**self.payload(), **change}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    batch_job.prepare_request(request, root / "jobs")
                self.assertFalse((root / "jobs").exists())

    def test_desktop_blocks_before_parsing_or_subprocess(self):
        with patch.object(batch_job.sys, "platform", "win32"), patch.object(batch_job.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "desktop rendering is blocked"):
                batch_job.main()
            run.assert_not_called()

    def test_cloud_renderer_failure_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / "request.json"
            request.write_text(json.dumps(self.payload()), encoding="utf-8")
            with patch.object(batch_job.sys, "platform", "linux"), patch.dict(batch_job.os.environ, {"NEXUS_CLOUD_WORKER": "1"}), \
                    patch.object(batch_job.sys, "argv", ["batch_job.py", str(request), str(root / "jobs")]), \
                    patch.object(batch_job.subprocess, "run", side_effect=batch_job.subprocess.CalledProcessError(1, "render")):
                with self.assertRaises(batch_job.subprocess.CalledProcessError):
                    batch_job.main()
            self.assertFalse(next((root / "jobs").iterdir()).joinpath("video.mp4").exists())
