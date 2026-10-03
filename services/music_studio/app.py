from __future__ import annotations

import argparse
from dataclasses import asdict
import os
import tempfile
import threading
import time
from pathlib import Path

import gradio as gr

from .core import AceClient, LANGUAGES, MODELS, Project, Song


def build_app(client=None, root=None, poll_interval=2, wait_seconds=1800):
    client = client or AceClient()
    root = Path(root or os.getenv("NEXUS_MUSIC_OUTPUT", tempfile.mkdtemp(prefix="nexus-music-")))
    sessions, stops = {}, {}

    def snapshot(project, message):
        paths = [str(project.directory / t["file"]) for t in project.tracks]
        return (paths[0] if paths else None, paths[1] if len(paths) > 1 else None,
                project.archive() if paths else None, project.save(),
                {"song": asdict(project.song), "tracks": project.tracks,
                 "note": "Raport techniczny; jakość oceń odsłuchem."}, message, None)

    def wait(project, session_hash):
        deadline = time.monotonic() + wait_seconds
        event = stops.setdefault(session_hash, threading.Event())
        while time.monotonic() < deadline and not event.is_set():
            result = client.poll(project.task_id)
            if result is not None:
                project.collect(client, result)
                yield snapshot(project, f"Gotowe: {len(project.tracks)}/{project.song.variants} wersji. Odsłuchaj oryginały przed normalizacją.")
                return
            yield snapshot(project, "Silnik pracuje. Zapisz plik projektu, aby móc odebrać wynik później.")
            event.wait(poll_interval)
        yield snapshot(project, "Zatrzymano oczekiwanie. Silnik może nadal generować. Użyj „Odbierz wynik”, bez nowego zadania.")

    def generate(description, lyrics, instrumental, language, duration, bpm, key, model,
                 variants, seed, format, thinking, request: gr.Request):
        try:
            old = sessions.get(request.session_hash)
            if old and old.task_id and not old.tracks:
                raise ValueError("Masz oczekujące zadanie. Odbierz jego wynik lub rozpocznij nowy projekt.")
            song = Song(description, lyrics, instrumental, language, int(duration), int(bpm), key,
                        model, int(variants), int(seed), format, thinking)
            project = Project(song, root)
            sessions[request.session_hash] = project
            stops[request.session_hash] = threading.Event()
            yield snapshot(project, "Zapisano projekt. Sprawdzam model i wysyłam zadanie…")
            project.task_id = client.submit(song)
            project.save()
            yield snapshot(project, "Zadanie przyjęte. Możesz już pobrać plik projektu.")
            yield from wait(project, request.session_hash)
        except Exception as error:
            project = sessions.get(request.session_hash)
            if project and project.tracks:
                yield snapshot(project, "Wystąpił błąd. Dostępne nagrania są zachowane; możesz ponowić odbiór wyniku.")
            raise gr.Error(str(error)) from error

    def resume(project_file, request: gr.Request):
        try:
            if project_file:
                sessions[request.session_hash] = Project.restore(project_file, root)
            project = sessions.get(request.session_hash)
            if not project or not project.task_id:
                raise ValueError("Brak zadania. Wczytaj project.json lub wygeneruj utwór.")
            stops[request.session_hash] = threading.Event()
            yield from wait(project, request.session_hash)
        except Exception as error:
            raise gr.Error(str(error)) from error

    def draft(description, language):
        try:
            return (*client.draft(description, language), "Szkic gotowy. Sprawdź tekst i opis przed generowaniem.")
        except Exception as error:
            raise gr.Error(str(error)) from error

    def status():
        try:
            return "Dostępne modele: " + ", ".join(client.models()) + ". To sprawdzenie połączenia, nie test generacji."
        except Exception as error:
            return str(error)

    def stop(request: gr.Request):
        event = stops.get(request.session_hash)
        if event:
            event.set()
        return "Zatrzymuję oczekiwanie w panelu. To nie anuluje pracy GPU."

    def reset(request: gr.Request):
        sessions.pop(request.session_hash, None)
        stops.pop(request.session_hash, None)
        return None, None, None, None, {}, "Nowy projekt. Poprzednie pliki pozostają na dysku.", None

    def normalize(index, request: gr.Request):
        try:
            project = sessions.get(request.session_hash)
            if not project or int(index) >= len(project.tracks):
                raise ValueError("Najpierw wygeneruj wybraną wersję.")
            path = project.normalize(int(index))
            return path, project.archive(), project.save(), {"tracks": project.tracks}
        except Exception as error:
            raise gr.Error(str(error)) from error

    with gr.Blocks(title="Nexus · Music Studio", analytics_enabled=False) as demo:
        gr.Markdown("# Nexus · Music Studio\nOd pomysłu do piosenki. Wokal, instrumental i porównanie wersji.")
        with gr.Row():
            with gr.Column(scale=1):
                description = gr.Textbox(label="Jak ma brzmieć utwór?", lines=4,
                    placeholder="Ciepły soul, żywa perkusja, głęboki bas, intymny wokal, spokojna zwrotka i szeroki refren…")
                language = gr.Dropdown(choices=[("Polski", "pl"), ("English", "en"), ("Deutsch", "de"),
                    ("Español", "es"), ("Français", "fr"), ("Italiano", "it"), ("日本語", "ja"), ("中文", "zh")],
                    value="pl", label="Język tekstu")
                draft_button = gr.Button("Stwórz szkic tekstu i aranżacji")
                lyrics = gr.Textbox(label="Tekst piosenki", lines=10,
                    placeholder="[Verse]\nTwoja zwrotka…\n\n[Chorus]\nTwój refren…")
                instrumental = gr.Checkbox(label="Instrumental — bez wokalu", value=False)
                with gr.Row():
                    duration = gr.Slider(15, 300, value=120, step=5, label="Długość · sekundy")
                    bpm = gr.Slider(30, 300, value=100, step=1, label="Tempo · BPM")
                key = gr.Dropdown(choices=[f"{note} {scale}" for note in ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
                                           for scale in ["Major", "Minor"]], value="C Major", label="Tonacja")
                with gr.Accordion("Generowanie i zapis", open=True):
                    model = gr.Dropdown(choices=[("Base · 64 kroki", "acestep-v15-base"),
                        ("SFT · 50 kroków", "acestep-v15-sft"), ("Turbo · 8 kroków", "acestep-v15-turbo")],
                        value="acestep-v15-base", label="Model", info="Wybrany model musi działać na serwerze. Więcej kroków nie gwarantuje lepszej muzyki.")
                    thinking = gr.Checkbox(value=True, label="Planowanie muzyczne przez model językowy")
                    variants = gr.Radio([1, 2], value=2, label="Liczba wersji do porównania")
                    format = gr.Radio(["flac", "wav"], value="flac", label="Bezstratny format źródłowy")
                    seed = gr.Number(value=42, precision=0, minimum=0, maximum=2147483647, label="Seed · zmień, aby otrzymać nowe warianty")
                generate_button = gr.Button("Stwórz muzykę", variant="primary")
            with gr.Column(scale=2):
                message = gr.Textbox(label="Status", value="Sprawdź połączenie z silnikiem i opisz utwór.", interactive=False)
                connect_button = gr.Button("Sprawdź połączenie")
                audio_a = gr.Audio(label="Wersja A · oryginał", type="filepath", interactive=False)
                audio_b = gr.Audio(label="Wersja B · oryginał", type="filepath", interactive=False)
                with gr.Accordion("Wyrównanie głośności i odsłuch", open=True):
                    gr.Markdown("Opcjonalna kopia: cel −16 LUFS, szczyty −1 dBTP, WAV 24-bit. "
                                "Oryginał pozostaje nietknięty. Normalizacja nie usuwa artefaktów wokalu ani nie poprawia kompozycji.")
                    chosen = gr.Radio(choices=[("Wersja A", 0), ("Wersja B", 1)], value=0, label="Wybrana wersja")
                    normalize_button = gr.Button("Przygotuj kopię z wyrównaną głośnością")
                    normalized = gr.Audio(label="Kopia po normalizacji", type="filepath", interactive=False)
                archive = gr.File(label="Cały projekt i nagrania · ZIP", interactive=False)
                project_download = gr.File(label="Zapis projektu · pobierz też podczas generowania", interactive=False)
                with gr.Accordion("Pomiary techniczne", open=False):
                    report = gr.JSON(label="Parametry plików i pomiary sygnału")
                with gr.Accordion("Odbierz wynik później", open=False):
                    project_upload = gr.File(label="Wczytaj wcześniejszy project.json (opcjonalnie)", file_types=[".json"])
                    resume_button = gr.Button("Odbierz wynik istniejącego zadania")
                    stop_button = gr.Button("Przestań czekać · GPU nadal pracuje")
                    new_button = gr.Button("Rozpocznij nowy projekt")
        gr.Markdown("Generowanie odbywa się na skonfigurowanym serwerze GPU. "
                    "Przy Colabie pobierz ZIP przed zakończeniem sesji. Jakość muzyki i polskiego wokalu wymaga odsłuchu.")
        outputs = [audio_a, audio_b, archive, project_download, report, message, normalized]
        generate_button.click(generate, [description, lyrics, instrumental, language, duration, bpm,
            key, model, variants, seed, format, thinking], outputs, concurrency_id="music", concurrency_limit=1,
            api_visibility="private")
        resume_button.click(resume, [project_upload], outputs, concurrency_id="music", concurrency_limit=1, api_visibility="private")
        draft_button.click(draft, [description, language], [description, lyrics, message], concurrency_id="music", concurrency_limit=1, api_visibility="private")
        normalize_button.click(normalize, [chosen], [normalized, archive, project_download, report],
                               concurrency_id="music", concurrency_limit=1, api_visibility="private")
        connect_button.click(status, outputs=message, api_visibility="private")
        stop_button.click(stop, outputs=message, queue=False, api_visibility="private")
        new_button.click(reset, outputs=outputs, concurrency_id="music", concurrency_limit=1, api_visibility="private")
    demo.queue(max_size=4, default_concurrency_limit=1)
    return demo


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--share", action="store_true")
    parser.add_argument("--port", type=int, default=7862)
    args = parser.parse_args()
    password = os.getenv("NEXUS_MUSIC_PASSWORD", "")
    if args.share and len(password) < 12:
        parser.error("--share wymaga NEXUS_MUSIC_PASSWORD o długości minimum 12 znaków")
    build_app().launch(server_name="127.0.0.1", server_port=args.port, share=args.share,
                       auth=("nexus", password) if password else None, max_file_size="128kb", show_error=False)


if __name__ == "__main__":
    main()
