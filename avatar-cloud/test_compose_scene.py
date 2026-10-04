import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from compose_scene import compose


class SceneIntegrationTests(unittest.TestCase):
    def test_requires_cloud_before_reading_job(self):
        with patch.dict(os.environ, {"NEXUS_CLOUD_WORKER": "0"}):
            with self.assertRaisesRegex(RuntimeError, "cloud"):
                compose(Path("unused"))

    @unittest.skipUnless(sys.platform == "linux" and shutil.which("ffmpeg"), "Remote Linux/ffmpeg integration")
    def test_scene_keeps_actor_audio_and_rejects_short_background(self):
        import cv2
        import numpy as np

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
            root = Path(directory)
            clips = []
            for kind in ["actor", "background", "matte"]:
                path = root / f"{kind}.mkv"
                writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"FFV1"), 24, (64, 64))
                self.assertTrue(writer.isOpened())
                try:
                    for index in range(12):
                        pixels = np.zeros((64, 64, 3), dtype=np.uint8)
                        if kind == "matte":
                            pixels[16:48, 16:48] = 255
                        elif kind == "actor":
                            pixels[:] = [0, 0, 200 + index]
                        else:
                            pixels[:] = [100 + index * 3, 0, 0]
                        writer.write(pixels)
                finally:
                    writer.release()
                clips.append(path)
            actor_audio = root / "actor-audio.mkv"
            subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(clips[0]), "-f", "lavfi",
                "-i", "sine=frequency=440:duration=0.5", "-map", "0:v", "-map", "1:a",
                "-c:v", "copy", "-c:a", "aac", "-shortest", str(actor_audio),
            ], check=True, timeout=30)
            settings = {"characterClip": str(actor_audio), "backgroundClip": str(clips[1]), "matteClip": str(clips[2])}
            job = root / "scene"
            job.mkdir()
            (job / "scene.json").write_text(json.dumps(settings))
            video = compose(job)
            capture = cv2.VideoCapture(str(video))
            try:
                self.assertEqual(int(capture.get(cv2.CAP_PROP_FRAME_COUNT)), 12)
                ok, frame = capture.read()
                self.assertTrue(ok)
                self.assertLess(np.abs(frame[32, 32].astype(int) - [0, 0, 200]).max(), 8)
                self.assertLess(np.abs(frame[4, 4].astype(int) - [100, 0, 0]).max(), 8)
            finally:
                capture.release()
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                "stream=codec_type", "-of", "json", str(video),
            ], check=True, capture_output=True, text=True, timeout=30)
            self.assertEqual(json.loads(probe.stdout)["streams"][0]["codec_type"], "audio")
            with self.assertRaisesRegex(ValueError, "already exists"):
                compose(job)
            short = root / "short.mkv"
            subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(clips[1]), "-frames:v", "2",
                "-c:v", "ffv1", str(short),
            ], check=True, timeout=30)
            short_job = root / "short-scene"
            short_job.mkdir()
            settings["backgroundClip"] = str(short)
            (short_job / "scene.json").write_text(json.dumps(settings))
            with self.assertRaisesRegex(ValueError, "cover"):
                compose(short_job)
            self.assertFalse((short_job / "scene.mp4").exists())


if __name__ == "__main__":
    unittest.main()
