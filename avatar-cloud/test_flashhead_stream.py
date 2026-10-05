import hashlib
from pathlib import Path
import tempfile
import unittest
import wave

from benchmark_flashhead_stream import validate_inputs


class FlashHeadStreamInputTests(unittest.TestCase):
    def test_original_reference_and_complete_speech_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            portrait = root / "portrait.png"
            portrait.write_bytes(b"original")
            audio = root / "speech.wav"
            samples = b"\x00\x20" * 16000
            with wave.open(str(audio), "wb") as writer:
                writer.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                writer.writeframes(samples)
            digest = hashlib.sha256(portrait.read_bytes()).hexdigest()
            payload, duration = validate_inputs(portrait, audio, digest)
            self.assertEqual(payload, samples)
            self.assertEqual(duration, 1)
            with self.assertRaisesRegex(ValueError, "portrait"):
                validate_inputs(portrait, audio, "0" * 64)
            self.assertEqual(portrait.read_bytes(), b"original")

    def test_format_duration_and_silence_fail_before_model_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            portrait = root / "portrait.png"
            portrait.write_bytes(b"original")
            digest = hashlib.sha256(portrait.read_bytes()).hexdigest()
            audio = root / "speech.wav"
            for rate, frames, audible, expected in [
                (24000, 24000, True, "16000"),
                (16000, 31 * 16000, True, "0.2-30"),
                (16000, 16000, False, "silent"),
            ]:
                with wave.open(str(audio), "wb") as writer:
                    writer.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                    writer.writeframes((b"\x00\x20" if audible else b"\x00\x00") * frames)
                with self.assertRaisesRegex(ValueError, expected):
                    validate_inputs(portrait, audio, digest)


if __name__ == "__main__":
    unittest.main()
