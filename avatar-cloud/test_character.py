import ast
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import reference_pack
import render_rig
import verify_rig
from rig_motion import pose, settings


class CharacterTests(unittest.TestCase):
    def test_rig_blocks_desktop_before_launching_blender(self):
        with patch.object(render_rig.sys, "platform", "win32"), patch.object(render_rig.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "cloud worker"):
                render_rig.main()
            run.assert_not_called()

    def test_blender_script_syntax_and_desktop_guard(self):
        source = Path(__file__).with_name("blender_rig.py").read_text()
        ast.parse(source)
        with patch("sys.platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "cloud worker"):
                exec(compile(source, "<blender-rig>", "exec"), {"__name__": "__main__"})

    def test_explicit_cameras_and_bounded_resources(self):
        self.assertEqual(settings({})["camera"], "body")
        self.assertEqual(settings({"camera": "face", "action": "wave"})["action"], "wave")
        for config in ({"camera": "auto"}, {"action": "fly"}, {"seconds": 60},
                       {"width": 385}, {"fps": True}, {"localGpu": True}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                settings(config)

    def test_wave_moves_head_arm_wrist_and_fingers(self):
        poses = [pose(t, "wave") for t in (.4, .9, 1.5)]
        for bone in ("head", "upper_arm.L", "forearm.L", "hand.L"):
            values = [frame["joints"][bone] for frame in poses]
            self.assertGreater(max(math.dist(a, b) for a in values for b in values), .02, bone)
        self.assertIn("finger4.L", poses[0]["joints"])

    def test_walk_moves_both_knees_and_shoulders(self):
        poses = [pose(t, "walk") for t in (.2, .5, .9)]
        for bone in ("thigh.L", "thigh.R", "calf.L", "calf.R", "upper_arm.L", "upper_arm.R"):
            values = [frame["joints"][bone] for frame in poses]
            self.assertGreater(max(math.dist(a, b) for a in values for b in values), .02, bone)
        for frame in poses:
            for side in ("L", "R"):
                self.assertGreaterEqual(frame["joints"]["calf." + side][0], 0)

    def test_showcase_switch_has_no_large_joint_jump(self):
        before, after = pose(2.999), pose(3.001)
        self.assertLess(math.dist(before["joints"]["forearm.L"], after["joints"]["forearm.L"]), .16)
        for bone in ("upper_arm.L", "hand.L", "thigh.L", "calf.R"):
            self.assertLess(math.dist(before["joints"][bone], after["joints"][bone]), .01)
        self.assertEqual(pose(0)["rootZ"], 0)
        for time in (-1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                pose(time)

    def test_blink_closes_then_reopens(self):
        self.assertEqual(pose(1.5)["blink"], 1)
        self.assertEqual(pose(1)["blink"], 0)
        self.assertEqual(pose(2)["blink"], 0)

    def test_collage_boxes_cover_actual_6_by_2_image(self):
        boxes = reference_pack.crop_boxes(1152, 768)
        self.assertEqual(len(boxes), 12)
        self.assertEqual(boxes[0], (0, 0, 192, 384))
        self.assertEqual(boxes[-1], (960, 384, 1152, 768))
        self.assertEqual(len(set(reference_pack.ROLES)), 12)
        with self.assertRaisesRegex(ValueError, "64x128"):
            reference_pack.crop_boxes(100, 100)
        with self.assertRaises(ValueError):
            reference_pack.crop_boxes(1152, 768, 0, 2)

    def test_collage_rounding_preserves_border_pixels(self):
        boxes = reference_pack.crop_boxes(1153, 769)
        self.assertEqual(boxes[-1][2:], (1153, 769))
        self.assertEqual(sum((r - l) * (b - t) for l, t, r, b in boxes), 1153 * 769)

    def test_caption_inset_keeps_grid_boundaries_and_faces(self):
        boxes = reference_pack.crop_boxes(1152, 768, 6, 5, bottom=20)
        self.assertEqual(len(boxes), 30)
        self.assertEqual(boxes[0], (0, 0, 192, 133))
        self.assertEqual(boxes[6], (0, 153, 192, 287))
        self.assertEqual(boxes[-1][2:], (1152, 748))
        self.assertEqual(reference_pack.crop_boxes(1024, 768, 6, 5, bottom=36)[0],
                         (0, 0, 170, 117))
        self.assertEqual(len(set(reference_pack.COSMIC_EXPRESSIONS)), 30)
        self.assertEqual(len(set(reference_pack.COSMIC_STORYBOARD)), 30)
        for bottom in (-1, 65, True):
            with self.assertRaises(ValueError):
                reference_pack.crop_boxes(1152, 768, 6, 5, bottom)
        with self.assertRaisesRegex(ValueError, "96 pixels"):
            reference_pack.crop_boxes(1152, 768, 6, 5, bottom=64)

    def test_logo_cannot_be_selected_for_face_render(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            pack = Path(directory)
            (pack / "character.json").write_text(json.dumps({
                "version": 1, "kind": "image-references",
                "references": [{"role": "intro_logo", "type": "scene", "file": "logo.png"}],
            }))
            with patch.dict("sys.modules", {"PIL": unittest.mock.MagicMock()}):
                with self.assertRaisesRegex(ValueError, "scene/logo"):
                    reference_pack.select_reference(pack, "intro_logo", pack)

    def test_storyboard_manifest_has_safe_default_and_scene_labels(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as directory:
            imaging = MagicMock()
            imaging.Image.open.return_value.__enter__.return_value.convert.return_value.size = (1152, 1024)
            with patch.dict("sys.modules", {"PIL": imaging}):
                manifest = reference_pack.import_collage(
                    "storyboard.jpeg", Path(directory) / "new-pack", bottom=20,
                    layout="cosmic-storyboard",
                )
            self.assertEqual(manifest["grid"], [6, 5])
            self.assertEqual(manifest["defaultRole"], "eye_contact")
            self.assertEqual(manifest["captionInsetBottom"], 20)
            self.assertFalse(manifest["reconstructs3D"])
            self.assertEqual(len(manifest["references"]), 30)
            self.assertEqual(manifest["references"][0]["type"], "scene")
            self.assertEqual(manifest["references"][2]["type"], "portrait")

    def test_existing_pack_is_never_overwritten(self):
        # This check needs no imaging library, and must happen before opening the source.
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict("sys.modules", {"PIL": unittest.mock.MagicMock()}):
                with self.assertRaises(FileExistsError):
                    reference_pack.import_collage("missing.png", directory)

    def test_static_glb_is_not_accepted_as_animated_rig(self):
        import json
        import struct
        nodes = [{"name": name} for name in ["head", "spine", *[f"bone{i}" for i in range(25)]]]
        nodes[0].update(mesh=0, skin=0)
        document = {"skins": [{"joints": list(range(27))}], "nodes": nodes, "animations": []}
        text = json.dumps(document).encode()
        text += b" " * (-len(text) % 4)
        data = (struct.pack("<4sII", b"glTF", 2, 28 + len(text)) +
                struct.pack("<II", len(text), 0x4E4F534A) + text +
                struct.pack("<II", 0, 0x004E4942))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "static.glb"
            path.write_bytes(data)
            with self.assertRaisesRegex(ValueError, "no changing exported rotation"):
                verify_rig.verify(path, "idle")

    def test_export_verifier_reads_real_quaternion_samples(self):
        import json
        import struct
        binary = struct.pack("<16f", 0, 0, 0, 1, .1, 0, 0, .995,
                             0, 0, 0, 1, 0, .1, 0, .995)
        nodes = [{"name": name} for name in ["head", "spine", *[f"bone{i}" for i in range(25)]]]
        nodes[0].update(mesh=0, skin=0)
        document = {
            "skins": [{"joints": list(range(27))}], "nodes": nodes,
            "bufferViews": [{"byteOffset": 0}, {"byteOffset": 32}],
            "accessors": [{"componentType": 5126, "type": "VEC4", "bufferView": i, "count": 2} for i in range(2)],
            "animations": [{"samplers": [{"output": 0}, {"output": 1}], "channels": [
                {"sampler": i, "target": {"node": i, "path": "rotation"}} for i in range(2)]}],
        }
        text = json.dumps(document).encode()
        text += b" " * (-len(text) % 4)
        data = (struct.pack("<4sII", b"glTF", 2, 28 + len(text) + len(binary)) +
                struct.pack("<II", len(text), 0x4E4F534A) + text +
                struct.pack("<II", len(binary), 0x004E4942) + binary)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "animated.glb"
            path.write_bytes(data)
            self.assertEqual(verify_rig.verify(path, "idle")["movingJoints"], ["head", "spine"])
            with self.assertRaisesRegex(ValueError, "thigh"):
                verify_rig.verify(path, "walk")


if __name__ == "__main__":
    unittest.main()
