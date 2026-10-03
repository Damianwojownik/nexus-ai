"""Protocol and DSP tests; test tones are NOT generated music or a GPU benchmark."""
import hashlib
import io
import json
import shutil
import zipfile
from dataclasses import replace

import httpx
import numpy as np
import pytest
import soundfile as sf

from .core import AceClient, Project, Song, inspect_audio, normalize_audio


@pytest.fixture
def audio_bytes():
    sample_rate = 48000
    t = np.arange(sample_rate * 4) / sample_rate
    tone = 0.04 * np.sin(2 * np.pi * 440 * t)
    buffer = io.BytesIO()
    sf.write(buffer, np.column_stack([tone, tone]), sample_rate, format="FLAC", subtype="PCM_24")
    return buffer.getvalue()


class Backend:
    def __init__(self, data):
        self.data = data
        self.posts = []
        self.ready = False
        self.failed = False

    def handle(self, request):
        path = request.url.path
        assert request.headers.get("authorization") == "Bearer test-token"
        if path == "/v1/audio":
            return httpx.Response(200, content=self.data)
        body = json.loads(request.content) if request.content else None
        if request.method == "POST":
            self.posts.append((path, body))
        if path == "/v1/models":
            data = {"models": [{"name": "acestep-v15-base"}]}
        elif path == "/release_task":
            data = {"task_id": "test-job"}
        elif path == "/v1/create_sample":
            data = {"caption": "soft soul", "lyrics": "[Verse]\nPróbny tekst"}
        elif path == "/query_result":
            rows = [{"file": f"/v1/audio?path=sample-{i}.flac", "lyrics": "words", "seed_value": str(i)} for i in range(2)]
            data = [{"task_id": "test-job", "status": 2 if self.failed else 1 if self.ready else 0,
                     "result": json.dumps(rows)}]
        else:
            return httpx.Response(404)
        return httpx.Response(200, json={"code": 200, "error": None, "data": data})


def client_for(backend):
    return AceClient("http://127.0.0.1:8001", "test-token", httpx.MockTransport(backend.handle))


def test_song_validates_and_preserves_reviewed_lyrics():
    song = Song("warm soul", "[Verse]\nHello", duration=90, bpm=110)
    payload = song.payload()
    assert payload["lyrics"] == song.lyrics
    assert payload["audio_duration"] == 90
    assert payload["inference_steps"] == 64
    assert payload["audio_format"] == "flac"
    assert payload["use_format"] is False
    assert replace(song, instrumental=True).payload()["lyrics"] == "[Instrumental]"
    for invalid in [replace(song, lyrics=""), replace(song, duration=900), replace(song, variants=8),
                    replace(song, format="mp3"), replace(song, key="../../etc"), replace(song, seed=-2)]:
        with pytest.raises(ValueError):
            invalid.payload()


def test_full_protocol_and_archive(audio_bytes, tmp_path):
    backend = Backend(audio_bytes)
    client = client_for(backend)
    song = Song("warm soul", "hello")
    project = Project(song, tmp_path)
    project.task_id = client.submit(song)
    assert client.poll(project.task_id) is None
    backend.ready = True
    project.collect(client, client.poll(project.task_id))
    assert len(project.tracks) == 2
    assert project.tracks[0]["metrics"]["sample_rate"] == 48000
    assert project.tracks[0]["metrics"]["encoding"] == "PCM_24"
    assert project.tracks[0]["metrics"]["channels"] == 2
    with zipfile.ZipFile(project.archive()) as bundle:
        assert set(bundle.namelist()) == {"project.json", "wersja-1.flac", "wersja-2.flac"}
        saved = json.loads(bundle.read("project.json"))
        assert saved["song"]["lyrics"] == "hello"
        assert "test-token" not in bundle.read("project.json").decode()


@pytest.mark.parametrize("url", ["https://evil.example/v1/audio?path=a", "//evil.example/v1/audio?path=a",
                                  "/health", "file:///tmp/secret", "/v1/audio/../health?path=a"])
def test_download_cannot_leak_token_to_other_origin(audio_bytes, tmp_path, url):
    client = client_for(Backend(audio_bytes))
    with pytest.raises(RuntimeError):
        client.download(url, tmp_path / "output.flac")
    assert not (tmp_path / "output.flac").exists()


def test_backend_failures_and_no_automatic_resubmission(audio_bytes):
    backend = Backend(audio_bytes)
    client = client_for(backend)
    backend.failed = True
    with pytest.raises(RuntimeError):
        client.poll("test-job")
    calls = []
    def timeout(request):
        calls.append(request.url.path)
        raise httpx.ReadTimeout("uncertain submission")
    client = AceClient(transport=httpx.MockTransport(timeout))
    with pytest.raises(RuntimeError):
        client.call("POST", "/release_task", {})
    assert len(calls) == 1


def test_restore_ignores_untrusted_audio_paths(audio_bytes, tmp_path):
    original = Project(Song("warm soul", instrumental=True), tmp_path)
    original.task_id = "test-job"
    filename = original.save()
    raw = json.loads(open(filename).read())
    raw["tracks"] = [{"file": "../../secret"}]
    with open(filename, "w") as handle:
        json.dump(raw, handle)
    restored = Project.restore(filename, tmp_path)
    assert restored.task_id == "test-job" and restored.tracks == []
    backend = Backend(audio_bytes)
    backend.ready = True
    client = client_for(backend)
    restored.collect(client, client.poll(restored.task_id))
    assert len(restored.tracks) == 2
    assert not any(path == "/release_task" for path, _ in backend.posts)


def test_invalid_audio_and_silence(tmp_path):
    path = tmp_path / "bad.flac"
    path.write_text("<html>error</html>")
    with pytest.raises(ValueError):
        inspect_audio(path)
    path = tmp_path / "silence.wav"
    sf.write(path, np.zeros(48000), 48000)
    assert inspect_audio(path)["silence"]
    with pytest.raises(ValueError):
        normalize_audio(path, tmp_path / "normalized.wav")


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg unavailable")
def test_real_ffmpeg_normalization_preserves_source(audio_bytes, tmp_path):
    source = tmp_path / "original.flac"
    source.write_bytes(audio_bytes)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    target = tmp_path / "normalized.wav"
    report = normalize_audio(source, target)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    assert report["audio"]["encoding"] == "PCM_24"
    assert report["audio"]["sample_rate"] == 48000
    assert abs(float(report["measurement"]["output_i"]) + 16) < 0.5
    assert float(report["measurement"]["output_tp"]) <= -0.95


def test_ui_generation_draft_and_resume(audio_bytes, tmp_path):
    import gradio as gr
    from .app import build_app
    backend = Backend(audio_bytes)
    backend.ready = True
    demo = build_app(client_for(backend), tmp_path, poll_interval=0, wait_seconds=1)
    callbacks = {f.fn.__name__: f.fn for f in demo.fns.values() if f.fn}
    request = gr.Request(session_hash="session-a")
    draft = callbacks["draft"]("Polish soul song", "pl")
    assert "Próbny tekst" in draft[1]
    updates = list(callbacks["generate"]("warm soul", "hello", False, "pl", 30, 100, "C Major",
                        "acestep-v15-base", 2, 42, "flac", True, request))
    assert updates[-1][0] and updates[-1][1] and updates[-1][2]
    assert "2/2" in updates[-1][5]
    restored = list(callbacks["resume"](updates[-1][3], gr.Request(session_hash="session-b")))
    assert restored[-1][0] and restored[-1][1]
    assert len([x for x in backend.posts if x[0] == "/release_task"]) == 1


def test_wait_timeout_preserves_job_for_resume(audio_bytes, tmp_path):
    import gradio as gr
    from .app import build_app
    backend = Backend(audio_bytes)
    demo = build_app(client_for(backend), tmp_path, poll_interval=0, wait_seconds=0)
    callbacks = {f.fn.__name__: f.fn for f in demo.fns.values() if f.fn}
    request = gr.Request(session_hash="session-a")
    outputs = list(callbacks["generate"]("warm soul", "", True, "pl", 30, 100, "C Major",
                        "acestep-v15-base", 1, 42, "flac", True, request))
    assert "Zatrzymano" in outputs[-1][5]
    assert json.loads(open(outputs[-1][3]).read())["task_id"] == "test-job"
