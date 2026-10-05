import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from expression_edit import preserve_motion_frame, read_expression_inputs, validate_face_region
import render_expression


class ExpressionEditTests(unittest.TestCase):
    def test_nonfinite_expression_is_reported_not_encoded_as_black_face(self):
        latents = MagicMock()
        state = {"latents": latents}
        latents.isfinite.return_value.all.return_value.item.return_value = True
        self.assertIs(render_expression.check_expression_step(None, 0, None, state), state)
        latents.isfinite.return_value.all.return_value.item.return_value = False
        with self.assertRaisesRegex(RuntimeError, "non-finite latents at step 2"):
            render_expression.check_expression_step(None, 2, None, state)

    def test_desktop_is_rejected_before_loading_models(self):
        with patch.object(render_expression.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "cloud worker"):
                render_expression.render(Path("unused"))

    def test_existing_output_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / "expression.mp4").write_bytes(b"existing")
            with patch.object(render_expression.sys, "platform", "linux"):
                with patch.dict(render_expression.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                    with self.assertRaisesRegex(ValueError, "already exists"):
                        render_expression.render(job)
            self.assertEqual((job / "expression.mp4").read_bytes(), b"existing")

    def test_missing_prompt_cleaner_fails_before_loading_gpu_models(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(render_expression.sys, "platform", "linux"):
                with patch.dict(render_expression.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                    with patch.object(render_expression.importlib.util, "find_spec", return_value=None):
                        with self.assertRaisesRegex(RuntimeError, "requires ftfy"):
                            render_expression.render(Path(directory))

    def test_generated_hand_is_discarded_and_master_motion_preserved(self):
        for index in range(5):
            source = np.full((32, 32, 3), 20 + index * 10, dtype=np.uint8)
            edited = np.full_like(source, 240)
            mask = np.zeros((32, 32), dtype=np.uint8)
            mask[4:10, 8:16] = 255
            result = preserve_motion_frame(source, edited, mask, [4, 2, 20, 12])
            np.testing.assert_array_equal(result[mask == 0], source[mask == 0])
            np.testing.assert_array_equal(result[mask == 255], edited[mask == 255])

    def test_mask_cannot_edit_hand_outside_authorized_face(self):
        pixels = np.zeros((32, 32, 3), dtype=np.uint8)
        mask = np.zeros((32, 32), dtype=np.uint8)
        mask[25, 10] = 255
        with self.assertRaisesRegex(ValueError, "outside"):
            preserve_motion_frame(pixels, pixels, mask, [4, 2, 20, 12])

    def test_inactive_expression_frame_is_exact_original(self):
        source = np.full((32, 32, 3), 77, dtype=np.uint8)
        result = preserve_motion_frame(source, source + 100, np.zeros((32, 32), dtype=np.uint8), [4, 2, 20, 12])
        np.testing.assert_array_equal(result, source)

    def test_soft_edges_and_invalid_inputs(self):
        source = np.full((32, 32, 3), 20, dtype=np.uint8)
        edited = np.full_like(source, 200)
        mask = np.zeros((32, 32), dtype=np.uint8)
        mask[4:10, 8:16] = 128
        self.assertEqual(preserve_motion_frame(source, edited, mask, [4, 2, 20, 12])[5, 9, 0], 110)
        for invalid in (mask.astype(float), mask[:16], np.stack([mask] * 3, axis=-1)):
            with self.subTest(shape=invalid.shape), self.assertRaises(ValueError):
                preserve_motion_frame(source, edited, invalid, [4, 2, 20, 12])

    def test_invalid_face_regions(self):
        for region in ([True, 2, 4, 4], [1, 2, 0, 4], [-1, 2, 4, 4], [30, 2, 4, 4], [1, 2, 4], "face"):
            with self.subTest(region=region), self.assertRaises(ValueError):
                validate_face_region(region, 32, 32)

    def write_clip(self, path, count, fps=24, mask=False, grayscale=True, active_mask=True):
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"FFV1"), fps, (32, 32))
        self.assertTrue(writer.isOpened())
        try:
            for index in range(count):
                pixels = np.zeros((32, 32, 3), dtype=np.uint8)
                if mask and active_mask and index == 16:
                    pixels[4:10, 8:16] = 255 if grayscale else (255, 0, 0)
                elif not mask:
                    pixels[:] = index
                writer.write(pixels)
        finally:
            writer.release()

    def test_shared_timeline_and_temporal_mask_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            source, mask = job / "source.avi", job / "mask.avi"
            self.write_clip(source, 33)
            self.write_clip(mask, 33, mask=True)
            (job / "expression-edit.json").write_text(json.dumps({
                "sourceClip": str(source), "maskClip": str(mask), "faceRegion": [4, 2, 20, 12],
            }))
            _, frames, masks, fps = read_expression_inputs(job)
            self.assertEqual((len(frames), len(masks), fps), (33, 33, 24))
            self.assertFalse(np.any(masks[0]))
            self.assertTrue(np.any(masks[16]))
            for count, rate, grayscale in ((37, 24, True), (33, 25, True), (33, 24, False)):
                self.write_clip(mask, count, fps=rate, mask=True, grayscale=grayscale)
                with self.subTest(count=count, rate=rate, grayscale=grayscale), self.assertRaises(ValueError):
                    read_expression_inputs(job)
            self.write_clip(mask, 33, mask=True, active_mask=False)
            with self.assertRaisesRegex(ValueError, "no authorized edits"):
                read_expression_inputs(job)


if __name__ == "__main__":
    unittest.main()
