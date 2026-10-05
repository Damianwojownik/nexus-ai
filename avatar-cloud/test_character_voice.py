import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave

import clone_character_voice as voice


class CharacterVoiceTests(unittest.TestCase):
    def reference(self, root, *, rate=24000, channels=1, seconds=6, silence=False):
        path = root / "reference.wav"
        samples = [
            0 if silence else int(2000 * math.sin(2 * math.pi * 200 * n / rate))
            for n in range(int(rate * seconds) * channels)
        ]
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(channels)
            audio.setsampwidth(2)
            audio.setframerate(rate)
            audio.writeframes(struct.pack(f"<{len(samples)}h", *samples))
        return path

    def test_accepts_expected_reference_and_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(
                voice.validate_reference(self.reference(Path(directory))), 6,
            )

    def test_rejects_wrong_format_short_or_silent_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for options in (
                {"rate": 16000}, {"channels": 2}, {"seconds": 5}, {"silence": True},
            ):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    voice.validate_reference(self.reference(root, **options))

    def test_rejects_truncated_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.reference(Path(directory))
            path.write_bytes(path.read_bytes()[:-100])
            with self.assertRaisesRegex(ValueError, "truncated"):
                voice.validate_reference(path)

    def test_rejects_a_session_bound_to_another_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = self.reference(root)
            session = Mock(spec=voice.CharacterVoiceSession, reference_sha256="other")
            with patch.object(voice.sys, "platform", "linux"), patch.dict(
                voice.os.environ, {"NEXUS_CLOUD_WORKER": "1"}
            ), self.assertRaisesRegex(ValueError, "Session reference"):
                voice.generate_voice(reference, root / "job", "Hi", "en", True, session)
            self.assertFalse((root / "job").exists())

    def test_text_boundaries_and_language(self):
        self.assertEqual(voice.validate_text("x" * 300, "pl"), "x" * 300)
        with self.assertRaisesRegex(ValueError, "1-300"):
            voice.validate_text("x" * 301, "pl")

    def test_requires_cloud_and_consent_before_loading_models(self):
        with patch.object(voice.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "Linux cloud"):
                voice.generate_voice(Path("missing"), Path("unused"), "Hi", "en", True)
        with patch.object(voice.sys, "platform", "linux"), patch.dict(
            voice.os.environ, {"NEXUS_CLOUD_WORKER": "1"}
        ):
            with self.assertRaisesRegex(ValueError, "consent"):
                voice.generate_voice(Path("missing"), Path("unused"), "Hi", "en", False)
            with self.assertRaisesRegex(ValueError, "1-300"):
                voice.generate_voice(Path("missing"), Path("unused"), " ", "en", True)
            with self.assertRaisesRegex(ValueError, "languages"):
                voice.generate_voice(Path("missing"), Path("unused"), "Hi", "xx", True)

    def test_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = self.reference(root)
            output = root / "job"
            output.mkdir()
            preserved = output / "speech.wav"
            preserved.write_bytes(b"preserved")
            with patch.object(voice.sys, "platform", "linux"), patch.dict(
                voice.os.environ, {"NEXUS_CLOUD_WORKER": "1"}
            ), self.assertRaises(FileExistsError):
                voice.generate_voice(reference, output, "Hi", "en", True)
            self.assertEqual(preserved.read_bytes(), b"preserved")


if __name__ == "__main__":
    unittest.main()
