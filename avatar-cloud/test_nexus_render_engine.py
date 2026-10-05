import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import nexus_render_engine as engine


class NexusRenderEngineTests(unittest.TestCase):
    def prepare(self, root, jobs=None):
        for name in ("face", "expression"):
            (root / name).mkdir()
        (root / "render-plan.json").write_text(json.dumps({
            "version": 1, "jobs": jobs if jobs is not None else [
                {"engine": "faster-liveportrait", "directory": "face"},
                {"engine": "vace-expression", "directory": "expression"},
            ],
        }))

    def test_cloud_guard_before_creating_files(self):
        with patch.object(engine.sys, "platform", "win32"):
            with self.assertRaisesRegex(RuntimeError, "desktop inference"):
                engine.run_batch(Path("unused"))

    def test_plan_rejects_unimplemented_engine_without_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.prepare(root, [{"engine": "musetalk-lips", "directory": "face"}])
            with self.assertRaisesRegex(ValueError, "not integrated"):
                engine.read_plan(root)

    def test_path_duplicate_and_existing_output_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.prepare(root)
            job = {"engine": "vace-expression", "directory": "expression"}
            for jobs in ([{**job, "directory": ".."}], [job, job], [{**job, "directory": str(root)}]):
                (root / "render-plan.json").write_text(json.dumps({"version": 1, "jobs": jobs}))
                with self.subTest(jobs=jobs), self.assertRaises(ValueError):
                    engine.read_plan(root)
            (root / "render-plan.json").write_text(json.dumps({"version": 1, "jobs": [job]}))
            (root / "expression" / "expression.mp4").write_bytes(b"accepted")
            with self.assertRaises(FileExistsError):
                engine.read_plan(root)

    def test_sequential_jobs_persist_rendered_not_visual_approval(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.prepare(root)
            calls = []

            def render(command, **kwargs):
                calls.append(command)
                directory = Path(command[-1])
                filename = "expression.mp4" if directory.name == "expression" else "video.mp4"
                (directory / filename).write_bytes(b"render")

            with patch.object(engine.sys, "platform", "linux"), patch.dict(engine.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                with patch.object(engine.subprocess, "run", side_effect=render):
                    with patch.object(engine, "probe_output", return_value={"sha256": "digest", "streams": []}):
                        engine.run_batch(root)
            state = json.loads((root / "render-state.json").read_text())
            self.assertEqual([Path(call[1]).name for call in calls], ["render.py", "render_expression.py"])
            self.assertEqual(state["status"], "rendered")
            self.assertFalse(state["visualApproval"])
            self.assertTrue(all(job["status"] == "rendered" for job in state["jobs"]))
            self.assertFalse((root / "render.lock").exists())

    def test_failure_blocks_remaining_jobs_and_preserves_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.prepare(root)
            with patch.object(engine.sys, "platform", "linux"), patch.dict(engine.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                with patch.object(engine.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["model"])):
                    with self.assertRaises(subprocess.CalledProcessError):
                        engine.run_batch(root)
                with self.assertRaisesRegex(FileExistsError, "history"):
                    engine.run_batch(root)
            state = json.loads((root / "render-state.json").read_text())
            self.assertEqual([job["status"] for job in state["jobs"]], ["error", "blocked"])
            self.assertFalse((root / "render.lock").exists())

    def test_lock_is_not_stolen(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "render.lock").write_text("other process")
            with patch.object(engine.sys, "platform", "linux"), patch.dict(engine.os.environ, {"NEXUS_CLOUD_WORKER": "1"}):
                with self.assertRaises(FileExistsError):
                    engine.run_batch(root)
            self.assertEqual((root / "render.lock").read_text(), "other process")

    def test_missing_and_undecodable_video_cannot_succeed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "video.mp4"
            with self.assertRaisesRegex(RuntimeError, "nonempty"):
                engine.probe_output(path)
            path.write_bytes(b"not a video")
            result = subprocess.CompletedProcess([], 0, stdout='{"streams": []}')
            with patch.object(engine.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(RuntimeError, "decodable"):
                    engine.probe_output(path)

    @unittest.skipUnless(
        sys.platform == "linux" and shutil.which("ffmpeg") and shutil.which("ffprobe"),
        "Remote Linux/ffmpeg integration",
    )
    def test_real_adapter_subprocess_queue_and_output_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            clips = {}
            for name, color in (("actor", "red"), ("background", "blue"), ("matte", "white")):
                clips[name] = root / (name + ".mkv")
                command = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color={color}:s=64x64:r=24:d=0.5"]
                if name == "actor":
                    command += [
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
                        "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest",
                    ]
                subprocess.run(
                    command + ["-frames:v", "12", "-c:v", "ffv1", str(clips[name])],
                    check=True, timeout=30,
                )
            jobs = [{"engine": "scene-composer", "directory": name} for name in ("scene-one", "scene-two")]
            (root / "render-plan.json").write_text(json.dumps({"version": 1, "jobs": jobs}))
            for job in jobs:
                directory = root / job["directory"]
                directory.mkdir()
                (directory / "scene.json").write_text(json.dumps({
                    "characterClip": str(clips["actor"]), "backgroundClip": str(clips["background"]),
                    "matteClip": str(clips["matte"]),
                }))
            env = {"NEXUS_CLOUD_WORKER": "1", "NEXUS_RENDER_PYTHON_SCENE_COMPOSER": sys.executable}
            with patch.dict(os.environ, env):
                try:
                    engine.run_batch(root)
                except subprocess.CalledProcessError:
                    self.fail((root / "scene-one" / "nexus-render.log").read_text())
            state = json.loads((root / "render-state.json").read_text())
            self.assertEqual(state["status"], "rendered")
            for record in state["jobs"]:
                self.assertEqual(record["status"], "rendered")
                self.assertEqual({stream["codec_type"] for stream in record["streams"]}, {"video", "audio"})
                self.assertEqual(int(record["streams"][0]["nb_read_frames"]), 12)
                self.assertEqual(len(record["sha256"]), 64)
                self.assertTrue((root / record["directory"] / "nexus-render.log").is_file())


if __name__ == "__main__":
    unittest.main()
