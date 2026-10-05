import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import subprocess

import render_echomimic as adapter
import nexus_render_engine as engine
import configure_echomimic as setup
import render_echomimic_long as long_adapter
import hashlib


class EchoMimicAdapterTests(unittest.TestCase):
    def test_missing_memory_patch_reports_setup_instruction(self):
        with patch.object(setup.subprocess, "run") as run:
            run.return_value = Mock(returncode=1, stderr="patch does not apply")
            with self.assertRaisesRegex(RuntimeError, "configure_echomimic.py"):
                setup.verify_memory_patch("unused")

    def test_memory_patch_setup_is_cloud_only(self):
        with patch.object(setup.sys, "platform", "win32"), patch.object(
            setup.subprocess, "run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "Linux cloud"):
                setup.configure("unused")
            run.assert_not_called()

    def test_memory_patch_setup_is_idempotent(self):
        with patch.object(setup.sys, "platform", "linux"), patch.dict(
            setup.os.environ, {"NEXUS_CLOUD_WORKER": "1"}
        ), patch.object(setup.subprocess, "run") as run:
            run.return_value = Mock(stdout=setup.NOSI_COMMIT, returncode=0)
            setup.configure("unused")
            self.assertEqual(run.call_count, 3)
            self.assertTrue(all("--check" in c.args[0] for c in run.call_args_list[1:]))

    def test_memory_patch_setup_applies_only_after_successful_check(self):
        with patch.object(setup.sys, "platform", "linux"), patch.dict(
            setup.os.environ, {"NEXUS_CLOUD_WORKER": "1"}
        ), patch.object(setup.subprocess, "run") as run:
            run.side_effect = [
                Mock(stdout=setup.NOSI_COMMIT),
                Mock(returncode=1),
                Mock(returncode=0),
                Mock(returncode=0),
                Mock(returncode=0),
            ]
            setup.configure("unused")
            self.assertEqual(run.call_count, 5)
            self.assertIn("--check", run.call_args_list[2].args[0])
            self.assertNotIn("--check", run.call_args_list[3].args[0])
            self.assertIn("--reverse", run.call_args_list[4].args[0])

    def test_memory_patch_rejects_conflicts_before_modification(self):
        failure = subprocess.CalledProcessError(1, ["git", "apply", "--check"])
        with patch.object(setup.sys, "platform", "linux"), patch.dict(
            setup.os.environ, {"NEXUS_CLOUD_WORKER": "1"}
        ), patch.object(setup.subprocess, "run") as run:
            run.side_effect = [
                Mock(stdout=setup.NOSI_COMMIT),
                Mock(returncode=1),
                failure,
            ]
            with self.assertRaises(subprocess.CalledProcessError):
                setup.configure("unused")
            self.assertEqual(run.call_count, 3)
            self.assertIn("--check", run.call_args.args[0])

    def test_cloud_guard(self):
        with patch.object(adapter.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "Linux cloud"):
                asyncio.run(adapter.render_job("unused"))

    def test_checkout_must_be_explicit(self):
        with patch.object(adapter.sys, "platform", "linux"), patch.dict(
            adapter.os.environ, {"NEXUS_CLOUD_WORKER": "1"}, clear=True
        ):
            with self.assertRaisesRegex(RuntimeError, "NEXUS_NOSI_DIR"):
                asyncio.run(adapter.render_job("unused"))

    def test_missing_inputs_and_weights_fail_before_importing_models(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            with self.assertRaisesRegex(ValueError, "speech.wav"):
                adapter.prepare_job(job, job / "repo")
            (job / "portrait.png").write_bytes(b"image")
            (job / "speech.wav").write_bytes(b"audio")
            with self.assertRaisesRegex(RuntimeError, "dependencies missing"):
                adapter.prepare_job(job, job / "repo")

    def test_existing_outputs_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            for name in ("portrait.png", "speech.wav", "video.mp4"):
                (job / name).write_bytes(b"preserved")
            with self.assertRaises(FileExistsError):
                adapter.prepare_job(job, job)
            self.assertEqual((job / "video.mp4").read_bytes(), b"preserved")

    def test_queue_dispatches_explicit_adapter(self):
        self.assertEqual(engine.ADAPTERS["echomimic-v3"],
                         ("render_echomimic.py", "video.mp4"))

    def test_frame_count_shape_and_blank_output_guards(self):
        np = Mock(uint8="uint8")
        frame = Mock(shape=(64, 64, 3), ndim=3, dtype="uint8")
        frame.std.return_value = 20
        adapter.validate_frames([frame, frame], 2, np)
        with self.assertRaisesRegex(RuntimeError, "Expected"):
            adapter.validate_frames([], 2, np)
        with self.assertRaisesRegex(RuntimeError, "Expected"):
            adapter.validate_frames([], 0, np)
        frame.std.return_value = 0
        with self.assertRaisesRegex(RuntimeError, "blank"):
            adapter.validate_frames([frame, frame], 2, np)
        frame.shape = (63, 64, 3)
        with self.assertRaisesRegex(RuntimeError, "even"):
            adapter.validate_frames([frame, frame], 2, np)

    def test_speech_format_duration_finiteness_and_silence_guards(self):
        np = Mock()
        np.isfinite.return_value.all.return_value = True
        np.max.return_value = 0.5
        audio = Mock(ndim=1)
        audio.__len__ = Mock(return_value=16000)
        adapter.validate_audio(audio, 16000, np)
        with self.assertRaisesRegex(ValueError, "16000"):
            adapter.validate_audio(audio, 22050, np)
        audio.__len__.return_value = 31 * 16000
        with self.assertRaisesRegex(ValueError, "0.2-30"):
            adapter.validate_audio(audio, 16000, np)
        audio.__len__.return_value = 16000
        np.isfinite.return_value.all.return_value = False
        with self.assertRaisesRegex(ValueError, "finite"):
            adapter.validate_audio(audio, 16000, np)
        np.isfinite.return_value.all.return_value = True
        np.max.return_value = 0
        with self.assertRaisesRegex(ValueError, "silent"):
            adapter.validate_audio(audio, 16000, np)

    def test_long_audio_requires_explicit_limit_and_remains_bounded(self):
        np = Mock()
        np.isfinite.return_value.all.return_value = True
        np.max.return_value = 0.5
        audio = Mock(ndim=1)
        audio.__len__ = Mock(return_value=180 * 16000)
        with self.assertRaisesRegex(ValueError, "0.2-30"):
            adapter.validate_audio(audio, 16000, np)
        adapter.validate_audio(audio, 16000, np, max_seconds=180)
        audio.__len__.return_value += 1
        with self.assertRaisesRegex(ValueError, "0.2-180"):
            adapter.validate_audio(audio, 16000, np, max_seconds=180)
        with self.assertRaisesRegex(ValueError, "Supported audio limits"):
            adapter.validate_audio(audio, 16000, np, max_seconds=3600)

    def test_existing_notebook_validation_patch_remains_unambiguous(self):
        source = Path(adapter.__file__).read_text(encoding="utf-8")
        self.assertEqual(source.count("validate_audio(audio, rate, np)"), 1)

    def test_long_reference_rejects_changed_missing_or_multiple_portraits(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            portrait = b"original portrait"
            digest = hashlib.sha256(portrait).hexdigest()
            with self.assertRaisesRegex(ValueError, "exactly one"):
                long_adapter.verify_reference(job, digest)
            (job / "portrait.png").write_bytes(portrait)
            long_adapter.verify_reference(job, digest)
            with self.assertRaisesRegex(ValueError, "mismatch"):
                long_adapter.verify_reference(job, "0" * 64)
            with self.assertRaisesRegex(ValueError, "lowercase"):
                long_adapter.verify_reference(job, "invalid")
            (job / "portrait.jpg").write_bytes(portrait)
            with self.assertRaisesRegex(ValueError, "exactly one"):
                long_adapter.verify_reference(job, digest)


if __name__ == "__main__":
    unittest.main()
