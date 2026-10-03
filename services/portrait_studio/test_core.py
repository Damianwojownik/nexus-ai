"""CPU tests exercise the workflow, not visual quality of the real GPU model."""
import json
import zipfile

import pytest
from PIL import Image

from .core import PortraitSession, Settings, VARIANTS, read_reference


class FakeEngine:
    memory_profile = "test-only"

    def __init__(self):
        self.calls = []
        self.fail = False

    def render(self, references, prompt, settings, seed, progress=None):
        self.calls.append((references[0].getpixel((0, 0)), prompt, seed))
        if self.fail:
            raise RuntimeError("test GPU failure")
        if progress:
            progress(1.0)
        return Image.new("RGB", (256, 384), (seed % 255, 0, 0))


@pytest.fixture
def reference(tmp_path):
    path = tmp_path / "source.png"
    Image.new("RGB", (512, 768), (15, 25, 35)).save(path)
    return path


def test_ten_separate_outputs_always_use_original(reference, tmp_path):
    session = PortraitSession([reference], Settings(seed=100), tmp_path / "out")
    engine = FakeEngine()
    for variant in VARIANTS:
        session.generate_one(variant.id, engine)
    assert len(session.records) == len(session.gallery()) == 10
    assert [call[0] for call in engine.calls] == [(15, 25, 35)] * 10
    assert [call[2] for call in engine.calls] == list(range(100, 110))
    assert len({call[1] for call in engine.calls}) == 10
    with zipfile.ZipFile(session.archive()) as archive:
        assert sorted(archive.namelist()) == sorted([v.id + ".png" for v in VARIANTS] + ["manifest.json"])
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["completed"] == 10
        assert len(manifest["images"]) == 10
        assert manifest["images"][0]["width"] == 256  # actual output size, not requested size
        assert all(record["filename"] in archive.namelist() for record in manifest["images"])


def test_retry_changes_only_selected_take_and_keeps_previous(reference, tmp_path):
    session = PortraitSession([reference], Settings(), tmp_path / "out")
    engine = FakeEngine()
    for variant in VARIANTS[:2]:
        session.generate_one(variant.id, engine)
    first, second = (dict(session.records[v.id]) for v in VARIANTS[:2])
    session.generate_one(VARIANTS[0].id, engine, retry=True)
    assert session.records[VARIANTS[1].id] == second
    assert session.records[VARIANTS[0].id]["filename"] != first["filename"]
    assert (session.directory / first["filename"]).exists()
    assert engine.calls[-1][0] == (15, 25, 35)


def test_failure_retains_outputs_and_records_error(reference, tmp_path):
    session = PortraitSession([reference], Settings(), tmp_path / "out")
    engine = FakeEngine()
    session.generate_one(VARIANTS[0].id, engine)
    engine.fail = True
    with pytest.raises(RuntimeError):
        session.generate_one(VARIANTS[1].id, engine)
    manifest = json.loads((session.directory / "manifest.json").read_text())
    assert manifest["completed"] == 1
    assert VARIANTS[1].id in manifest["errors"]
    assert session.archive() is not None
    engine.fail = False
    session.generate_one(VARIANTS[1].id, engine, retry=True)
    assert not session.errors


def test_sessions_are_isolated(reference, tmp_path):
    a = PortraitSession([reference], Settings(), tmp_path)
    b = PortraitSession([reference], Settings(), tmp_path)
    assert a.directory != b.directory
    a.generate_one(VARIANTS[0].id, FakeEngine())
    assert b.records == {} and b.archive() is None


def test_invalid_uploads_and_settings_are_rejected(reference, tmp_path):
    with pytest.raises(ValueError):
        PortraitSession([], Settings(), tmp_path)
    with pytest.raises(ValueError):
        PortraitSession([reference] * 4, Settings(), tmp_path)
    with pytest.raises(ValueError):
        Settings(size="8000x8000").validate()
    with pytest.raises(ValueError):
        Settings(seed=-1).validate()
    with pytest.raises(ValueError):
        Settings(steps=4).validate()
    fake = tmp_path / "fake.jpg"
    fake.write_text("this is not a photo")
    with pytest.raises(ValueError):
        read_reference(fake)
    Image.new("RGB", (32, 32)).save(fake)
    with pytest.raises(ValueError):
        read_reference(fake)


def test_exif_orientation_is_applied_and_metadata_removed(tmp_path):
    path = tmp_path / "rotated.jpg"
    source = Image.new("RGB", (300, 500))
    exif = source.getexif()
    exif[274] = 6
    exif[270] = "private metadata"
    source.save(path, exif=exif)
    result = read_reference(path)
    assert result.size == (500, 300)
    assert not result.getexif()


def test_app_builds_without_loading_models(tmp_path):
    from .app import build_app
    engine = FakeEngine()
    demo = build_app(engine, tmp_path)
    assert demo.title == "Nexus · Studio portretów"
    assert engine.calls == []


def test_ui_callbacks_generate_retry_and_stop(reference, tmp_path):
    import gradio as gr
    from .app import build_app
    engine = FakeEngine()
    demo = build_app(engine, tmp_path)
    callbacks = {f.fn.__name__: f.fn for f in demo.fns.values() if f.fn}
    request = gr.Request(session_hash="session-a")
    progress = lambda *args, **kwargs: None
    updates = list(callbacks["generate"]([str(reference)], "1024x1536", "original", 40, 42,
                                         request, progress))
    assert len(updates[-1][0]) == 10
    assert "10/10" in updates[-1][2]
    updated = callbacks["retry"](VARIANTS[0].id, request, progress)
    assert len(updated[0]) == 10
    assert len(engine.calls) == 11
    with pytest.raises(gr.Error):
        callbacks["retry"](VARIANTS[0].id, gr.Request(session_hash="session-b"), progress)
    generator = callbacks["generate"]([str(reference)], "1024x1536", "original", 40, 42,
                                       request, progress)
    next(generator)
    next(generator)
    callbacks["stop"](request)
    last = list(generator)[-1]
    assert len(last[0]) == 1 and "Zatrzymano" in last[2]
