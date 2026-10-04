import sys
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import render_flashhead as engine
import setup_flashhead_models as setup
import setup_flashhead_cloud as cloud_setup
import flashhead_worker


class FlashHeadTests(unittest.TestCase):
    def test_windows_refused_before_importing_cuda(self):
        with patch.object(engine.sys, "platform", "win32"):
            for operation in (engine.require_cloud, setup.main, cloud_setup.main, flashhead_worker.main):
                with self.assertRaisesRegex(RuntimeError, "cloud worker"):
                    operation()

    def test_gpu_requirements(self):
        torch = MagicMock()
        torch.cuda.is_available.return_value = False
        with self.assertRaisesRegex(RuntimeError, "CUDA"):
            engine.validate_gpu(torch)
        torch.cuda.is_available.return_value = True
        for capability, memory in ((7, 16), (8, 8)):
            torch.cuda.get_device_capability.return_value = (capability, 0)
            torch.cuda.get_device_properties.return_value.total_memory = memory * 1024**3
            with self.assertRaisesRegex(RuntimeError, "Ampere"):
                engine.validate_gpu(torch)
        torch.cuda.get_device_capability.return_value = (8, 9)
        torch.cuda.get_device_properties.return_value.total_memory = 24 * 1024**3
        engine.validate_gpu(torch)

    def test_download_requires_consent(self):
        with patch.object(engine.sys, "platform", "linux"), patch.dict(
                engine.os.environ, {"NEXUS_CLOUD_WORKER": "1"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "CONSENT"):
                setup.main()
            with self.assertRaisesRegex(RuntimeError, "Authorize"):
                cloud_setup.main()

    def test_invalid_job_before_torch(self):
        with tempfile.TemporaryDirectory() as root, patch.object(engine, "require_cloud"):
            job = Path(root)
            with self.assertRaisesRegex(ValueError, "exactly one"):
                engine.render_job(job)
            (job / "portrait.png").write_bytes(b"image")
            (job / "portrait.jpg").write_bytes(b"image")
            (job / "script.txt").write_text("Hello")
            with self.assertRaisesRegex(ValueError, "exactly one"):
                engine.render_job(job)

    def test_speech_never_truncated(self):
        with tempfile.TemporaryDirectory() as root:
            job = Path(root)
            (job / "script.txt").write_text("a" * 301)
            with self.assertRaisesRegex(ValueError, "never truncated"):
                engine.prepare_speech(job)

    def test_speech_duration_limit(self):
        with tempfile.TemporaryDirectory() as root, patch.object(engine.subprocess, "run"):
            job = Path(root)
            (job / "script.txt").write_text("Hello")
            audio = MagicMock()
            audio.__enter__.return_value = audio
            audio.getnframes.return_value = 31000
            audio.getframerate.return_value = 1000
            with patch.object(engine.wave, "open", return_value=audio):
                with self.assertRaisesRegex(ValueError, "30 seconds"):
                    engine.prepare_speech(job)

    def test_render_validates_output_before_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            job = Path(root) / "job"
            job.mkdir()
            (job / "portrait.png").write_bytes(b"image")
            (job / "script.txt").write_text("Hello")
            upstream = Path(root) / "engine"
            for directory in ("models/SoulX-FlashHead-1_3B/Model_Lite",
                              "models/SoulX-FlashHead-1_3B/VAE_LTX", "models/wav2vec2-base-960h"):
                (upstream / directory).mkdir(parents=True, exist_ok=True)
            (upstream / "generate_video.py").write_text("")
            def generate(command, **kwargs):
                self.assertEqual(command[command.index("--model_type") + 1], "lite")
                self.assertEqual(command[command.index("--save_file") + 1], str(job / "video.mp4"))
                self.assertEqual(kwargs["cwd"], upstream)
                self.assertEqual(kwargs["env"]["MPLBACKEND"], "Agg")
                (job / "video.mp4").write_bytes(b"test")
            with patch.object(engine, "require_cloud"), patch.object(engine, "validate_gpu"), \
                    patch.object(engine, "prepare_speech", return_value=job / "speech.wav"), \
                    patch.dict(sys.modules, {"torch": types.SimpleNamespace()}), \
                    patch.dict(engine.os.environ, {"NEXUS_FLASHHEAD_DIR": str(upstream)}), \
                    patch.object(engine.subprocess, "run", side_effect=generate), \
                    patch.object(engine, "verify_video", side_effect=RuntimeError("static")):
                with self.assertRaisesRegex(RuntimeError, "static"):
                    engine.render_job(job)
                self.assertFalse((job / "engine.json").exists())
            (job / "video.mp4").unlink()
            with patch.object(engine, "require_cloud"), patch.object(engine, "validate_gpu"), \
                    patch.object(engine, "prepare_speech", return_value=job / "speech.wav"), \
                    patch.dict(sys.modules, {"torch": types.SimpleNamespace()}), \
                    patch.dict(engine.os.environ, {"NEXUS_FLASHHEAD_DIR": str(upstream)}), \
                    patch.object(engine.subprocess, "run", side_effect=generate), \
                    patch.object(engine, "verify_video") as verify:
                engine.render_job(job)
                verify.assert_called_once_with(str(job / "video.mp4"))
                self.assertFalse(json.loads((job / "engine.json").read_text())["liveStream"])

    def test_missing_models_are_explicit(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(RuntimeError, "weights are missing"):
                engine.require_models(Path(root))

    def test_quality_is_explicit_and_validated(self):
        with patch.dict(engine.os.environ, {}, clear=True):
            self.assertEqual(engine.model_type(), "lite")
        with patch.dict(engine.os.environ, {"NEXUS_FLASHHEAD_MODEL": "pro"}):
            self.assertEqual(engine.model_type(), "pro")
        with patch.dict(engine.os.environ, {"NEXUS_FLASHHEAD_MODEL": "ultra"}):
            with self.assertRaisesRegex(ValueError, "lite or pro"):
                engine.model_type()
        command = engine.inference_command(Path("engine"), Path("job"), Path("portrait.png"),
                                           Path("speech.wav"), "pro")
        self.assertEqual(command[command.index("--model_type") + 1], "pro")

    def test_pro_requires_pro_weights_not_lite(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root)
            (repo / "generate_video.py").write_text("")
            for folder in ("Model_Lite", "VAE_LTX"):
                (repo / "models/SoulX-FlashHead-1_3B" / folder).mkdir(parents=True)
            (repo / "models/wav2vec2-base-960h").mkdir()
            with self.assertRaisesRegex(RuntimeError, "weights are missing"):
                engine.require_models(repo, "pro")
            (repo / "models/SoulX-FlashHead-1_3B/Model_Pro").mkdir()
            vae = repo / "models/SoulX-FlashHead-1_3B/VAE_Wan"
            vae.mkdir()
            (vae / "Wan2.1_VAE.pth").write_bytes(b"weights")
            engine.require_models(repo, "pro")


if __name__ == "__main__":
    unittest.main()
