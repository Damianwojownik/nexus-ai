import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import expression_references as references


class ExpressionReferenceTests(unittest.TestCase):
    def test_cloud_guard(self):
        with patch.object(references.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "cloud"):
                references.build_references(Path("unused"))

    def prepare(self, job):
        for name in ("master.mp4", "donor.mp4"):
            (job / name).write_bytes(b"immutable")
        mask = np.zeros((32, 32), dtype=np.uint8)
        mask[4:10, 8:16] = 255
        Image.fromarray(mask).save(job / "mask.png")
        settings = {
            "masterClip": str(job / "master.mp4"), "masterFrame": 0, "faceRegion": [4, 2, 20, 12],
            "variants": [
                {"role": role, "sourceClip": str(job / "donor.mp4"), "frame": index,
                 "maskImage": str(job / "mask.png")}
                for index, role in enumerate(("eyes_closed", "smile"), 1)
            ],
        }
        (job / "expression-references.json").write_text(json.dumps(settings))
        return settings, mask

    def build(self, job, pixels):
        with patch.object(references.sys, "platform", "linux"):
            with patch.dict(references.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                with patch.object(references, "read_frame", side_effect=pixels):
                    return references.build_references(job)

    def test_distinct_references_keep_all_unmasked_body_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            _, mask = self.prepare(job)
            base = np.full((32, 32, 3), 20, dtype=np.uint8)
            output = self.build(job, [base, base + 40, base + 80])
            self.assertEqual((job / "master.mp4").read_bytes(), b"immutable")
            for role, value in (("eyes_open", 20), ("eyes_closed", 60), ("smile", 100)):
                with Image.open(output / (role + ".png")) as image:
                    pixels = np.asarray(image)
                np.testing.assert_array_equal(pixels[mask == 0], base[mask == 0])
                self.assertTrue(np.all(pixels[mask == 255] == value))
            manifest = json.loads((output / "references.json").read_text())
            self.assertTrue(manifest["staticReferencesOnly"])
            self.assertFalse(manifest["visualApproval"])
            self.assertFalse(manifest["newModelInference"])
            with self.assertRaises(FileExistsError):
                self.build(job, [base, base + 40, base + 80])

    def test_similar_reference_is_not_promoted(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.prepare(job)
            base = np.full((32, 32, 3), 20, dtype=np.uint8)
            with self.assertRaisesRegex(ValueError, "too similar"):
                self.build(job, [base, base + 1])
            self.assertFalse((job / "references").exists())

    def test_duplicate_role_and_mask_outside_face_fail(self):
        for duplicate in (True, False):
            with self.subTest(duplicate=duplicate), tempfile.TemporaryDirectory() as directory:
                job = Path(directory)
                settings, mask = self.prepare(job)
                if duplicate:
                    settings["variants"][1]["role"] = "eyes_closed"
                else:
                    mask[25, 10] = 255
                    Image.fromarray(mask).save(job / "mask.png")
                (job / "expression-references.json").write_text(json.dumps(settings))
                base = np.full((32, 32, 3), 20, dtype=np.uint8)
                with self.assertRaises(ValueError):
                    self.build(job, [base, base + 40, base + 80])
                self.assertFalse((job / "references").exists())

    def test_frame_index_validation(self):
        for value in (-1, True, "0"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "index"):
                references.read_frame(Path("unused"), value)


if __name__ == "__main__":
    unittest.main()
