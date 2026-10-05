import hashlib
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import wave

from benchmark_faster_animal import CODE_REVISION, benchmark, single_source_faces, validate_inputs


class FasterAnimalInputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.portrait = self.root / "portrait.png"
        self.portrait.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        self.digest = hashlib.sha256(self.portrait.read_bytes()).hexdigest()
        self.audio = self.root / "speech.wav"
        self.write_audio()

    def write_audio(self, rate=24000, channels=1, constant=False):
        with wave.open(str(self.audio), "wb") as audio:
            audio.setnchannels(channels)
            audio.setsampwidth(2)
            audio.setframerate(rate)
            audio.writeframes(b"".join(struct.pack("<h", 500 if constant else (-500 if i % 2 else 500))
                                      for i in range(rate * channels)))

    def test_supplied_audio_formats_and_source_hash(self):
        for rate in (16000, 24000):
            self.write_audio(rate=rate)
            self.assertEqual(validate_inputs(self.portrait, self.audio, self.digest), 1)
        with self.assertRaisesRegex(ValueError, "reference hash mismatch"):
            validate_inputs(self.portrait, self.audio, "0" * 64)

    def test_rejects_stereo_wrong_rate_and_dc(self):
        for options in ({"channels": 2}, {"rate": 48000}, {"constant": True}):
            self.write_audio(**options)
            with self.assertRaises(ValueError):
                validate_inputs(self.portrait, self.audio, self.digest)

    def test_rejects_truncated_audio(self):
        self.audio.write_bytes(self.audio.read_bytes()[:-20])
        with self.assertRaisesRegex(ValueError, "truncated"):
            validate_inputs(self.portrait, self.audio, self.digest)

    def test_refuses_unauthorized_worker_before_loading_models(self):
        with patch.dict(os.environ, {"NEXUS_CLOUD_WORKER": "0"}):
            with self.assertRaisesRegex(RuntimeError, "authorized"):
                benchmark(self.root, self.root / "output", self.portrait, self.audio, self.digest)
        self.assertFalse((self.root / "output").exists())

    def test_existing_output_is_preserved(self):
        output = self.root / "output"
        output.mkdir()
        saved = output / "video.mp4"
        saved.write_bytes(b"existing user result")
        with patch("benchmark_faster_animal.sys.platform", "linux"), \
                patch.dict(os.environ, {"NEXUS_CLOUD_WORKER": "1"}), \
                patch("benchmark_faster_animal.subprocess.check_output", return_value=CODE_REVISION), \
                patch("benchmark_faster_animal.subprocess.run"):
            with self.assertRaises(FileExistsError):
                benchmark(self.root, output, self.portrait, self.audio, self.digest)
        self.assertEqual(saved.read_bytes(), b"existing user result")

    def test_source_faces_are_not_flattened_before_rendering(self):
        record = [{"scale": 1}] + [object() for _ in range(9)]
        faces = [record]
        self.assertIs(single_source_faces([faces]), faces)
        self.assertIs(single_source_faces([faces])[0], record)

    def test_rejects_incomplete_or_multiple_source_faces(self):
        record = [object() for _ in range(10)]
        for infos in ([], [[]], [[[object()]]], [[record, record]], [[record], [record]]):
            with self.assertRaisesRegex(RuntimeError, "complete animal face"):
                single_source_faces(infos)


if __name__ == "__main__":
    unittest.main()
