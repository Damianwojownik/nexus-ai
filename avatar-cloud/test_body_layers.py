import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from body_layers import face_references, face_timeline, motion_frame_indices, protect_upper_portrait
from body_layers import HeadTracker, tracked_face_composite, validate_face_box
from render_body import layer_settings, motion_settings, negative_prompt, prepare_body_image, NEGATIVE


class BodyLayerTests(unittest.TestCase):
    def setUp(self):
        self.source = Image.fromarray(np.full((100, 64, 3), 40, dtype=np.uint8))
        self.frame = Image.fromarray(np.full((100, 64, 3), 220, dtype=np.uint8))

    def test_tracked_alignment_follows_head_without_moving_background(self):
        import cv2
        rng = np.random.default_rng(19)
        pixels = rng.integers(0, 256, (192, 128, 3), dtype=np.uint8)
        source = Image.fromarray(pixels)
        box = [.2, .15, .6, .5]
        frames = []
        faces = []
        for offset in (0, 2, 4, 6):
            body = cv2.warpAffine(pixels, np.float32([[1, 0, offset], [0, 1, 0]]), (128, 192))
            face = pixels.copy()
            face[92:100, 55:73] = [250, 0, 0]
            frames.append(Image.fromarray(body))
            faces.append(Image.fromarray(face))
        result = tracked_face_composite(frames, faces, source, box, .1)
        for offset, body, frame in zip((0, 2, 4, 6), frames, result):
            rendered = np.asarray(frame)
            np.testing.assert_array_equal(rendered[140:], np.asarray(body)[140:])
            np.testing.assert_allclose(rendered[95, 62 + offset], [250, 0, 0], atol=2)

    def test_tracked_alignment_accounts_for_face_clip_head_motion(self):
        import cv2
        pixels = np.random.default_rng(9).integers(0, 256, (192, 128, 3), dtype=np.uint8)
        source = Image.fromarray(pixels)
        face = cv2.warpAffine(pixels, np.float32([[1, 0, 3], [0, 1, 0]]), (128, 192))
        result = tracked_face_composite([source], [Image.fromarray(face)], source, [.2, .15, .6, .5], .1)
        np.testing.assert_allclose(np.asarray(result[0])[65:85, 45:80], pixels[65:85, 45:80], atol=3)

    def test_tracking_rejects_featureless_source_and_lost_head(self):
        with self.assertRaisesRegex(RuntimeError, "textured"):
            HeadTracker(self.source, [.1, .1, .8, .5])
        pixels = np.random.default_rng(4).integers(0, 256, (192, 128, 3), dtype=np.uint8)
        tracker = HeadTracker(Image.fromarray(pixels), [.2, .15, .6, .5])
        with self.assertRaises(RuntimeError):
            tracker.advance(Image.fromarray(np.zeros_like(pixels)))

    def test_tracking_replenishes_features_after_verified_alignment(self):
        pixels = np.random.default_rng(14).integers(0, 256, (192, 128, 3), dtype=np.uint8)
        source = Image.fromarray(pixels)
        tracker = HeadTracker(source, [.2, .15, .6, .5])
        tracker.points = tracker.points[:20]
        tracker.anchors = tracker.anchors[:20]
        matrix = tracker.advance(source)
        self.assertGreater(len(tracker.points), 20)
        np.testing.assert_allclose(matrix, [[1, 0, 0], [0, 1, 0]], atol=.01)

    def test_face_box_rejects_invalid_values(self):
        for box in (None, [], [.2, .1, .9, .4], [True, 0, .5, .5], [0, 0, float("nan"), .5]):
            with self.subTest(box=box), self.assertRaises(ValueError):
                validate_face_box(box)

    def test_tracked_config_requires_face_and_explicit_box(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            face = job / "face.mp4"
            face.touch()
            settings = {
                "mode": "tracked", "protectedTop": .32, "feather": .1,
                "faceClip": str(face), "faceCrop": "upper-square",
                "faceBox": [.2, .15, .6, .5],
            }
            path = job / "body-layers.json"
            path.write_text(json.dumps(settings))
            self.assertEqual(layer_settings(job), settings)
            del settings["faceBox"]
            path.write_text(json.dumps(settings))
            with self.assertRaises(ValueError):
                layer_settings(job)

    def test_preserves_exact_upper_pixels_and_full_body_motion(self):
        result = np.asarray(protect_upper_portrait(self.frame, self.source, .32, .06))
        np.testing.assert_array_equal(result[:32], np.asarray(self.source)[:32])
        np.testing.assert_array_equal(result[38:], np.asarray(self.frame)[38:])
        self.assertTrue(np.all(np.diff(result[31:39, 0, 0].astype(int)) > 0))

    def test_preserves_textured_source(self):
        source = Image.fromarray(np.random.default_rng(7).integers(0, 256, (100, 64, 3), dtype=np.uint8))
        result = np.asarray(protect_upper_portrait(self.frame, source, .32, .06))
        np.testing.assert_array_equal(result[:32], np.asarray(source)[:32])

    def test_rejects_invalid_boundaries(self):
        for top, feather in [(0, .1), (.5, 0), (.9, .2), (float("nan"), .1), (.3, float("inf"))]:
            with self.subTest(top=top, feather=feather), self.assertRaises(ValueError):
                protect_upper_portrait(self.frame, self.source, top, feather)

    def test_rejects_mismatched_images_and_pixel_types(self):
        with self.assertRaises(ValueError):
            protect_upper_portrait(self.frame.resize((32, 100)), self.source, .32, .06)
        with self.assertRaises(ValueError):
            protect_upper_portrait(np.zeros((100, 64, 3)), self.source, .32, .06)

    def test_layer_settings_are_explicit_and_strict(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.assertIsNone(layer_settings(job))
            path = job / "body-layers.json"
            settings = {"protectedTop": .32, "feather": .06}
            path.write_text(json.dumps(settings))
            self.assertEqual(layer_settings(job), settings)
            for invalid in [{"protectedTop": True, "feather": .06}, {"protectedTop": .32}, [], {"protectedTop": .95, "feather": .1}]:
                path.write_text(json.dumps(invalid))
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    layer_settings(job)

    def test_face_clip_requires_explicit_crop_and_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            face = job / "face.mp4"
            face.touch()
            settings = {"protectedTop": .32, "feather": .06, "faceClip": str(face), "faceCrop": "upper-square"}
            (job / "body-layers.json").write_text(json.dumps(settings))
            self.assertEqual(layer_settings(job), settings)
            del settings["faceCrop"]
            (job / "body-layers.json").write_text(json.dumps(settings))
            with self.assertRaises(ValueError):
                layer_settings(job)

    @patch("body_layers.cv2.VideoCapture")
    def test_face_frames_sample_time_and_keep_lower_reference(self, capture):
        cap = capture.return_value
        cap.isOpened.return_value = True
        cap.get.return_value = 25
        cap.read.side_effect = [
            (True, np.full((64, 64, 3), value, dtype=np.uint8))
            for value in range(30)
        ]
        references = face_references("face.mp4", self.source, 25, 24)
        self.assertEqual(cap.read.call_count, 26)
        self.assertTrue(np.all(np.asarray(references[-1])[:64] == 25))
        self.assertTrue(np.all(np.asarray(references[-1])[64:] == 40))
        cap.release.assert_called_once()

    @patch("body_layers.cv2.VideoCapture")
    def test_short_face_clip_fails_without_frozen_frame_fallback(self, capture):
        cap = capture.return_value
        cap.isOpened.return_value = True
        cap.get.return_value = 25
        cap.read.return_value = (False, None)
        with self.assertRaisesRegex(RuntimeError, "shorter"):
            face_references("face.mp4", self.source, 97, 24)
        cap.release.assert_called_once()

    def test_return_pose_is_opt_in_and_requires_boolean(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.assertEqual(motion_settings(job), {"returnToSourcePose": False})
            for value in [True, False]:
                (job / "body-motion.json").write_text(json.dumps({"returnToSourcePose": value}))
                self.assertEqual(motion_settings(job), {"returnToSourcePose": value})
            for value in [1, "yes", None]:
                (job / "body-motion.json").write_text(json.dumps({"returnToSourcePose": value}))
                with self.assertRaises(ValueError):
                    motion_settings(job)

    def test_retiming_covers_whole_gesture_without_cutting_face_timeline(self):
        indices = motion_frame_indices(97, 125)
        self.assertEqual(len(indices), 125)
        self.assertEqual((indices[0], indices[-1]), (0, 96))
        self.assertTrue(all(a <= b for a, b in zip(indices, indices[1:])))
        self.assertEqual(motion_frame_indices(97, 97), list(range(97)))
        with self.assertRaises(ValueError):
            motion_frame_indices(1, 125)

    @patch("body_layers.cv2.VideoCapture")
    def test_full_face_timeline_is_used(self, capture):
        cap = capture.return_value
        cap.isOpened.return_value = True
        cap.get.side_effect = [125, 25]
        self.assertEqual(face_timeline("face.mp4"), (125, 25))
        cap.release.assert_called_once()

    def test_pose_strength_is_explicit_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            path = job / "body-motion.json"
            settings = {"returnToSourcePose": True, "poseStrength": .65}
            path.write_text(json.dumps(settings))
            self.assertEqual(motion_settings(job), settings)
            for value in [0, -1, 1.1, True, float("nan"), float("inf"), "0.65"]:
                path.write_text(json.dumps({"returnToSourcePose": True, "poseStrength": value}))
                with self.subTest(value=value), self.assertRaises(ValueError):
                    motion_settings(job)
            path.write_text(json.dumps({"returnToSourcePose": False, "poseStrength": .65}))
            with self.assertRaises(ValueError):
                motion_settings(job)

    def test_short_preview_frames_preserve_default_and_validate_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.assertNotIn("frames", motion_settings(job))
            path = job / "body-motion.json"
            for frames in [33, 49, 65, 97]:
                path.write_text(json.dumps({"returnToSourcePose": False, "frames": frames}))
                self.assertEqual(motion_settings(job)["frames"], frames)
            for frames in [1, 32, 48, 98, True, 49.0]:
                path.write_text(json.dumps({"returnToSourcePose": False, "frames": frames}))
                with self.subTest(frames=frames), self.assertRaises(ValueError):
                    motion_settings(job)

    def test_negative_prompt_override_does_not_affect_default(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.assertEqual(negative_prompt(job), NEGATIVE)
            path = job / "negative.txt"
            path.write_text("extra fingers, warped wrist")
            self.assertEqual(negative_prompt(job), "extra fingers, warped wrist")
            for value in [" ", "x" * 2001]:
                path.write_text(value)
                with self.assertRaises(ValueError):
                    negative_prompt(job)

    def test_transparent_source_is_composited_not_discarded(self):
        source = Image.new("RGBA", (64, 64), (255, 255, 255, 0))
        source.putpixel((32, 32), (0, 200, 0, 128))
        result = prepare_body_image(source, (64, 64))
        self.assertEqual(result.mode, "RGB")
        self.assertEqual(result.getpixel((0, 0)), (0, 0, 0))
        self.assertEqual(result.getpixel((32, 32)), (0, 100, 0))

    def test_opaque_source_pixels_are_unchanged(self):
        source = Image.fromarray(np.random.default_rng(9).integers(0, 256, (100, 64, 3), dtype=np.uint8))
        result = prepare_body_image(source, source.size)
        np.testing.assert_array_equal(np.asarray(result), np.asarray(source))


if __name__ == "__main__":
    unittest.main()
