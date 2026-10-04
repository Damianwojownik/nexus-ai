import types
import unittest
from unittest.mock import MagicMock, patch

import render
import render_body


class RenderTests(unittest.TestCase):
    def test_desktop_refused_before_loading_models(self):
        with patch.object(render.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "cloud worker"):
                render.main()

    def test_body_desktop_refused_before_loading_models(self):
        with patch.object(render_body.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "cloud worker"):
                render_body.main()

    def test_body_requires_portrait_and_script_before_loading_models(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as job:
            with patch.object(render_body.sys, "platform", "linux"):
                with patch.dict(render_body.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                    with patch.object(render_body.sys, "argv", ["render_body.py", job]):
                        with self.assertRaisesRegex(ValueError, "portrait and a speech script"):
                            render_body.main()

    def test_body_speech_is_not_silently_truncated(self):
        from pathlib import Path
        speech = MagicMock()
        speech.__enter__.return_value = speech
        speech.getframerate.return_value = 100
        with patch.object(render_body.subprocess, "run"):
            with patch.object(render_body.wave, "open", return_value=speech):
                for frames in (0, 405):
                    speech.getnframes.return_value = frames
                    with self.assertRaisesRegex(ValueError, "shorten the script"):
                        render_body.prepare_speech(Path("job"))
                speech.getnframes.return_value = 367
                self.assertEqual(render_body.prepare_speech(Path("job")), Path("job") / "speech.wav")

    def test_motion_dimensions_preserve_portrait_aspect(self):
        self.assertEqual(render_body.frame_size(768, 1152), (512, 768))
        self.assertEqual(render_body.frame_size(768, 960), (608, 768))
        with self.assertRaises(ValueError):
            render_body.frame_size(0, 960)

    def test_short_preview_rejects_speech_instead_of_trimming(self):
        from pathlib import Path
        speech = MagicMock()
        speech.__enter__.return_value = speech
        speech.getframerate.return_value = 100
        speech.getnframes.return_value = 210
        with patch.object(render_body.subprocess, "run"), patch.object(render_body.wave, "open", return_value=speech):
            with self.assertRaisesRegex(ValueError, "2.04.*shorten"):
                render_body.prepare_speech(Path("job"), 49 / 24)

    def test_motion_prompt_override_validated(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as folder:
            job = Path(folder)
            self.assertEqual(render_body.motion_prompt(job), render_body.PROMPT)
            (job / "motion.txt").write_text("Gentle head and wrist movement", encoding="utf-8")
            self.assertEqual(render_body.motion_prompt(job), "Gentle head and wrist movement")
            (job / "motion.txt").write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "1-2000"):
                render_body.motion_prompt(job)

    def check_clip(self, streams="video\naudio\n", frames=90, readable=True, difference=1):
        cv2 = MagicMock()
        numpy = MagicMock()
        capture = cv2.VideoCapture.return_value
        capture.get.return_value = frames
        capture.read.return_value = (readable, object())
        numpy.mean.return_value = difference
        with patch.dict("sys.modules", {"cv2": cv2, "numpy": numpy}):
            with patch.object(render.subprocess, "run", return_value=types.SimpleNamespace(stdout=streams)):
                try:
                    render.verify_video("video.mp4")
                finally:
                    if {"audio", "video"}.issubset(set(streams.splitlines())):
                        capture.release.assert_called_once()

    def test_requires_audio_and_video(self):
        with self.assertRaisesRegex(RuntimeError, "both animated video and speech"):
            self.check_clip(streams="video\n")

    def test_rejects_unreadable_or_single_frame(self):
        for frames, readable in ((1, True), (90, False)):
            with self.subTest(frames=frames, readable=readable):
                with self.assertRaisesRegex(RuntimeError, "no readable animation frames"):
                    self.check_clip(frames=frames, readable=readable)

    def test_rejects_static_and_accepts_changed_frames(self):
        with self.assertRaisesRegex(RuntimeError, "static"):
            self.check_clip(difference=0.1)
        self.check_clip(difference=0.11)


if __name__ == "__main__":
    unittest.main()
