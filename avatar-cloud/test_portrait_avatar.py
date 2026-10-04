from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
import portrait_avatar


class PortraitAvatarTests(unittest.TestCase):
    def test_requires_image_approval_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "job"
            with self.assertRaisesRegex(ValueError, "Review"):
                portrait_avatar.render_avatar("missing.png", "Hello", output, directory,
                                              [.3, .04, .4, .27], False)
            self.assertFalse(output.exists())

    def test_rejects_invalid_text_and_face_box(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "job"
            for text in ("", " ", "x" * 301):
                with self.assertRaises(ValueError):
                    portrait_avatar.render_avatar("missing.png", text, output, directory,
                                                  [.3, .04, .4, .27], True)
            with self.assertRaises(ValueError):
                portrait_avatar.render_avatar("missing.png", "Hello", output, directory,
                                              [2, .04, .4, .27], True)
            self.assertFalse(output.exists())

    def test_failed_stage_exposes_log_and_does_not_report_success(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "stage.log"
            with patch.object(portrait_avatar.subprocess, "run") as run:
                run.return_value.returncode = 2
                with self.assertRaisesRegex(RuntimeError, "stage.log"):
                    portrait_avatar.run_stage(["renderer"], log, {})
            self.assertTrue(log.exists())

    def test_face_failure_stops_before_body(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "portrait.png"
            Image.new("RGB", (32, 48)).save(image)
            with patch.object(portrait_avatar, "run_stage", side_effect=RuntimeError("face failed")) as stage:
                with self.assertRaisesRegex(RuntimeError, "face failed"):
                    portrait_avatar.render_avatar(image, "Hello", root / "job", root,
                                                  [.3, .04, .4, .27], True)
            self.assertEqual(stage.call_count, 1)
            self.assertFalse((root / "job/body/video.mp4").exists())

    def test_desktop_execution_is_blocked(self):
        with patch.object(portrait_avatar.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "Linux GPU"):
                portrait_avatar.main()

    def test_approved_image_reaches_face_and_body_then_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "approved.png"
            Image.new("RGB", (64, 96), "blue").save(image)
            output = root / "new-job"

            def stage(command, log, env):
                self.assertEqual(env["NEXUS_CLOUD_WORKER"], "1")
                if log.name == "face.log":
                    clip = output / "face/batch-test"
                    clip.mkdir()
                    (clip / "video.mp4").write_bytes(b"face")
                elif log.name == "face-crop.log":
                    (output / "body/face-square.mp4").write_bytes(b"cropped")
                elif log.name == "body.log":
                    (output / "body/video.mp4").write_bytes(b"body")

            with patch.object(portrait_avatar, "run_stage", side_effect=stage) as runner, \
                    patch("render.verify_video") as verify:
                movie = portrait_avatar.render_avatar(
                    image, "Hello", output, root, [.3, .04, .4, .27], True,
                )
            self.assertEqual(runner.call_count, 3)
            verify.assert_called_once_with(str(movie))
            import json
            request = json.loads((output / "face-request.json").read_text())
            self.assertEqual(request["text"], "Hello")
            self.assertEqual(request["mime"], "image/png")
            settings = json.loads((output / "body/body-layers.json").read_text())
            self.assertEqual(settings["mode"], "tracked")
            self.assertEqual(settings["faceBox"], [.3, .04, .4, .27])
            manifest = json.loads((output / "workflow.json").read_text())
            self.assertTrue(manifest["requiresVideoHandReview"])


if __name__ == "__main__":
    unittest.main()
