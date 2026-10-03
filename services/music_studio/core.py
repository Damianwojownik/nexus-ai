from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import uuid
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
import numpy as np
import soundfile as sf

MODELS = {"acestep-v15-base": 64, "acestep-v15-sft": 50, "acestep-v15-turbo": 8}
LANGUAGES = {"pl", "en", "de", "es", "fr", "it", "ja", "zh"}
MAX_AUDIO_BYTES = 300 * 1024 * 1024


@dataclass(frozen=True)
class Song:
    description: str
    lyrics: str = ""
    instrumental: bool = False
    language: str = "pl"
    duration: int = 120
    bpm: int = 100
    key: str = "C Major"
    model: str = "acestep-v15-base"
    variants: int = 2
    seed: int = 42
    format: str = "flac"
    thinking: bool = True

    def validate(self):
        if not isinstance(self.description, str) or not 3 <= len(self.description.strip()) <= 4000:
            raise ValueError("Opisz utwór: od 3 do 4000 znaków.")
        if not isinstance(self.lyrics, str) or len(self.lyrics) > 12000:
            raise ValueError("Tekst może mieć maksymalnie 12000 znaków.")
        if not self.instrumental and not self.lyrics.strip():
            raise ValueError("Wpisz tekst, użyj przycisku tworzenia tekstu lub wybierz instrumental.")
        if type(self.instrumental) is not bool or type(self.thinking) is not bool:
            raise ValueError("Niepoprawny tryb generowania.")
        for value, low, high in [(self.duration, 15, 300), (self.bpm, 30, 300),
                                  (self.variants, 1, 2), (self.seed, 0, 2147483647)]:
            if type(value) is not int or not low <= value <= high:
                raise ValueError("Niepoprawna długość, tempo, liczba wersji lub seed.")
        if self.language not in LANGUAGES or self.model not in MODELS or self.format not in {"wav", "flac"}:
            raise ValueError("Nieobsługiwany język, model lub format.")
        if not re.fullmatch(r"[A-G](?:#|b)? (?:Major|Minor)", self.key):
            raise ValueError("Tonacja powinna mieć postać C Major lub A Minor.")

    def payload(self):
        self.validate()
        return {
            "prompt": self.description.strip(),
            "lyrics": "[Instrumental]" if self.instrumental else self.lyrics.strip(),
            "vocal_language": "unknown" if self.instrumental else self.language,
            "audio_duration": self.duration, "bpm": self.bpm, "key_scale": self.key,
            "time_signature": "4", "model": self.model, "batch_size": self.variants,
            "audio_format": self.format, "inference_steps": MODELS[self.model],
            "thinking": self.thinking, "guidance_scale": 7.0,
            "seed": self.seed, "use_random_seed": False, "task_type": "text2music",
            # Preserve the reviewed lyrics, caption and requested musical metadata.
            "use_format": False, "use_cot_caption": False, "use_cot_language": False,
        }


class AceClient:
    def __init__(self, base_url=None, token=None, transport=None):
        self.base_url = (base_url or os.getenv("NEXUS_MUSIC_API_URL", "http://127.0.0.1:8001")).rstrip("/")
        parsed = urlsplit(self.base_url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("Adres silnika musi być adresem http(s) bez ścieżki i danych logowania.")
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Zdalny silnik wymaga HTTPS.")
        token = token if token is not None else os.getenv("NEXUS_MUSIC_API_TOKEN", "")
        self.http = httpx.Client(
            timeout=httpx.Timeout(30, connect=10), follow_redirects=False,
            headers={"Authorization": f"Bearer {token}"} if token else {}, transport=transport,
        )

    def call(self, method, path, body=None, timeout=30):
        try:
            response = self.http.request(method, self.base_url + path, json=body, timeout=timeout)
            response.raise_for_status()
            value = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RuntimeError(
                "Silnik muzyczny nie odpowiedział poprawnie. Sprawdź jego uruchomienie, adres i token. "
                "Przy błędzie wysyłania zadanie mogło już trafić do kolejki; nie ponawiam go automatycznie."
            ) from error
        if not isinstance(value, dict) or value.get("code") != 200 or value.get("error"):
            raise RuntimeError("Silnik zgłosił błąd. Sprawdź jego log, dostępność modelu i pamięć GPU.")
        return value.get("data")

    def models(self):
        data = self.call("GET", "/v1/models")
        if not isinstance(data, dict):
            raise RuntimeError("Serwer nie zwrócił listy modeli.")
        return [m["name"] for m in data.get("models", []) if isinstance(m, dict) and m.get("name")]

    def draft(self, description, language):
        if not isinstance(description, str) or not 3 <= len(description.strip()) <= 4000 or language not in LANGUAGES:
            raise ValueError("Wpisz opis utworu i wybierz język.")
        data = self.call("POST", "/v1/create_sample", {
            "query": description, "instrumental": False, "vocal_language": language,
        }, timeout=300)
        if not isinstance(data, dict) or not data.get("lyrics"):
            raise RuntimeError("Silnik nie zwrócił tekstu. Sprawdź, czy model językowy jest uruchomiony.")
        return data.get("caption") or description, data["lyrics"]

    def submit(self, song):
        payload = song.payload()
        if song.model not in self.models():
            raise ValueError("Wybrany model nie jest dostępny. Uruchom go na serwerze lub wybierz inny w panelu.")
        data = self.call("POST", "/release_task", payload)
        if not isinstance(data, dict) or not isinstance(data.get("task_id"), str):
            raise RuntimeError("Silnik nie zwrócił identyfikatora zadania.")
        return data["task_id"]

    def poll(self, task_id):
        data = self.call("POST", "/query_result", {"task_id_list": [task_id]})
        row = next((r for r in data if isinstance(r, dict) and r.get("task_id") == task_id), None) if isinstance(data, list) else None
        if row is None:
            raise RuntimeError("Silnik nie zna tego zadania. Mogło wygasnąć lub pochodzić z innego serwera.")
        if row.get("status") == 2:
            raise RuntimeError("Generowanie zakończyło się błędem. Sprawdź pamięć GPU i log silnika.")
        if row.get("status") == 0:
            return None
        if row.get("status") != 1:
            raise RuntimeError("Nieznany status zadania.")
        results = row.get("result")
        try:
            results = json.loads(results) if isinstance(results, str) else results
        except ValueError as error:
            raise RuntimeError("Niepoprawna odpowiedź z wynikami.") from error
        if not isinstance(results, list) or not 1 <= len(results) <= 2:
            raise RuntimeError("Silnik zwrócił niepoprawną liczbę nagrań.")
        if not all(isinstance(r, dict) and isinstance(r.get("file"), str) for r in results):
            raise RuntimeError("W odpowiedzi brakuje plików audio.")
        return results

    def download(self, url, target):
        full = urljoin(self.base_url + "/", url)
        parsed, origin = urlsplit(full), urlsplit(self.base_url)
        if ((parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc)
                or parsed.path != "/v1/audio" or not parsed.query or parsed.fragment):
            raise RuntimeError("Odrzucono plik spoza skonfigurowanego serwera audio.")
        temp = target.with_suffix(".part")
        try:
            with self.http.stream("GET", full, timeout=120) as response:
                response.raise_for_status()
                size = 0
                with temp.open("wb") as handle:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > MAX_AUDIO_BYTES:
                            raise ValueError("Plik audio przekroczył limit 300 MB.")
                        handle.write(chunk)
            report = inspect_audio(temp)
            temp.replace(target)
            return report
        finally:
            temp.unlink(missing_ok=True)


def inspect_audio(path):
    try:
        info = sf.info(path)
        if info.format not in {"WAV", "WAVEX", "FLAC"} or not 0 < info.duration <= 610 or not 1 <= info.channels <= 2:
            raise ValueError("Nieobsługiwane lub niepoprawne nagranie.")
        peak, energy, clipped, count = 0.0, 0.0, 0, 0
        for block in sf.blocks(path, blocksize=65536, dtype="float32", always_2d=True):
            if not np.isfinite(block).all():
                raise ValueError("Nagranie zawiera niepoprawne próbki.")
            peak = max(peak, float(np.abs(block).max(initial=0)))
            energy += float(np.square(block.astype(np.float64)).sum())
            clipped += int((np.abs(block) >= 0.9999).sum())
            count += block.size
        rms = math.sqrt(energy / max(count, 1))
        return {
            "sample_rate": info.samplerate, "channels": info.channels,
            "duration_seconds": round(info.duration, 3), "encoding": info.subtype,
            "sample_peak_dbfs": round(20 * math.log10(peak), 2) if peak > 0 else None,
            "rms_dbfs": round(20 * math.log10(rms), 2) if rms > 0 else None,
            "near_full_scale_samples": clipped, "silence": peak < 1e-5,
            "note": "Pomiary techniczne, nie ocena muzyki ani porównanie z Suno. Sample peak nie jest true peak.",
        }
    except (RuntimeError, sf.LibsndfileError) as error:
        raise ValueError("Silnik nie zwrócił poprawnego pliku WAV/FLAC.") from error


def normalize_audio(source, target):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("Do wyrównania głośności potrzebny jest FFmpeg.")
    info = inspect_audio(source)
    if info["silence"]:
        raise ValueError("Nagranie jest ciche/puste. Nie będę wzmacniać pustego sygnału.")
    common = [ffmpeg, "-hide_banner", "-nostdin", "-i", str(source)]
    measurement = subprocess.run(common + ["-af", "loudnorm=I=-16:TP=-1:LRA=11:print_format=json",
                                           "-f", "null", "-"], capture_output=True, text=True, timeout=300)
    if measurement.returncode:
        raise RuntimeError("Nie udało się zmierzyć głośności.")
    try:
        stats = json.loads(measurement.stderr[measurement.stderr.rfind("{"):])
        values = {key: float(stats[key]) for key in ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]}
        if not all(math.isfinite(v) for v in values.values()):
            raise ValueError("nonfinite")
    except (ValueError, KeyError) as error:
        raise ValueError("Nie można wyznaczyć głośności tego nagrania.") from error
    filt = (
        "loudnorm=I=-16:TP=-1:LRA=11:linear=true:print_format=json"
        f":measured_I={values['input_i']}:measured_TP={values['input_tp']}"
        f":measured_LRA={values['input_lra']}:measured_thresh={values['input_thresh']}"
        f":offset={values['target_offset']}"
    )
    result = subprocess.run(common + ["-af", filt, "-ar", str(info["sample_rate"]),
                                      "-c:a", "pcm_s24le", "-y", str(target)],
                            capture_output=True, text=True, timeout=300)
    if result.returncode:
        target.unlink(missing_ok=True)
        raise RuntimeError("Nie udało się zapisać wersji z wyrównaną głośnością.")
    normalized_stats = json.loads(result.stderr[result.stderr.rfind("{"):])
    return {"target_lufs": -16, "target_true_peak_dbtp": -1,
            "measurement": normalized_stats, "audio": inspect_audio(target),
            "note": "Kopia z normalizacją EBU R128; oryginał bez zmian. Nie usuwa artefaktów modelu."}


class Project:
    def __init__(self, song, root):
        song.validate()
        self.song = song
        self.directory = Path(root) / uuid.uuid4().hex
        self.directory.mkdir(parents=True)
        self.task_id = None
        self.tracks = []
        self.save()

    def save(self):
        value = {"schema": "nexus-music-v1", "song": asdict(self.song), "task_id": self.task_id,
                 "tracks": self.tracks, "quality_verified_by_listening": False}
        tmp = self.directory / "project.tmp"
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.directory / "project.json")
        return str(self.directory / "project.json")

    @classmethod
    def restore(cls, path, root):
        if Path(path).stat().st_size > 128 * 1024:
            raise ValueError("Plik projektu jest za duży.")
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        if value.get("schema") != "nexus-music-v1":
            raise ValueError("Nieobsługiwany plik projektu.")
        task_id = value.get("task_id")
        if task_id is not None and (not isinstance(task_id, str) or not re.fullmatch(r"[\w-]{1,128}", task_id)):
            raise ValueError("Niepoprawny identyfikator zadania.")
        project = cls(Song(**value["song"]), root)
        project.task_id = task_id
        # Never trust file paths from an uploaded JSON; fetch outputs from the known API.
        project.save()
        return project

    def collect(self, client, results):
        if len(results) > self.song.variants:
            raise ValueError("Silnik zwrócił więcej nagrań niż zamówiono.")
        for index, item in enumerate(results):
            if index < len(self.tracks):
                continue
            name = f"wersja-{index + 1}.{self.song.format}"
            metrics = client.download(item["file"], self.directory / name)
            self.tracks.append({"file": name, "metrics": metrics, "lyrics": item.get("lyrics", ""),
                                "seed": item.get("seed_value"), "dit_model": item.get("dit_model"),
                                "lm_model": item.get("lm_model")})
            self.save()

    def normalize(self, index):
        track = self.tracks[index]
        name = f"wersja-{index + 1}-normalized.wav"
        report = normalize_audio(self.directory / track["file"], self.directory / name)
        track["normalized"] = name
        track["normalization"] = report
        self.save()
        return str(self.directory / name)

    def archive(self):
        path = self.directory / f"nexus-music-{uuid.uuid4().hex[:8]}.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(self.save(), "project.json")
            for track in self.tracks:
                for key in ("file", "normalized"):
                    if track.get(key):
                        archive.write(self.directory / track[key], track[key])
        return str(path)
