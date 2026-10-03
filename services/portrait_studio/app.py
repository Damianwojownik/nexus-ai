from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

import gradio as gr

from .core import BY_ID, VARIANTS, PortraitEngine, PortraitSession, Settings


def build_app(engine=None, output_root=None):
    engine = engine or PortraitEngine(
        os.getenv("NEXUS_PORTRAIT_PROFILE", "full"),
        os.getenv("NEXUS_PORTRAIT_OFFLOAD", "sequential"),
    )
    output_root = Path(output_root or tempfile.mkdtemp(prefix="nexus-portraits-"))
    sessions = {}

    def get_session(request):
        return sessions.get(request.session_hash)

    def generate(paths, size, background, steps, seed, request: gr.Request, progress=gr.Progress()):
        if not paths:
            raise gr.Error("Najpierw wgraj zdjęcie osoby.")
        try:
            session = PortraitSession(
                paths, Settings(int(steps), int(seed), size, background), output_root,
                profile=engine.memory_profile,
            )
        except (ValueError, OSError) as error:
            raise gr.Error(str(error)) from error
        sessions[request.session_hash] = session
        yield [], None, "Przygotowuję model. Pierwsze uruchomienie pobiera duże pliki i może potrwać."
        for index, variant in enumerate(VARIANTS):
            if session.stop_requested.is_set():
                yield session.gallery(), session.archive(), f"Zatrzymano. Zachowano {len(session.records)}/10 zdjęć."
                return
            try:
                progress(index / 10, desc=f"{index + 1}/10 · {variant.label}")
                session.generate_one(variant.id, engine, progress=lambda p: progress(
                    (index + p) / 10, desc=f"{index + 1}/10 · {variant.label}",
                ))
            except Exception as error:
                # Stop on error instead of repeating expensive failing calls.
                yield session.gallery(), session.archive(), (
                    f"Zatrzymano przy ujęciu „{variant.label}”. Gotowe: {len(session.records)}/10. "
                    "Wcześniejsze zdjęcia są zachowane. Możesz ponowić wybrane ujęcie."
                )
                raise gr.Error(str(error)) from error
            yield session.gallery(), session.archive(), f"Gotowe: {index + 1}/10 · {variant.label}"
        yield session.gallery(), session.archive(), (
            "Gotowe: 10/10. Obejrzyj twarz, oczy i dłonie w powiększeniu. "
            "Jeżeli ujęcie wymaga poprawy, wygeneruj je ponownie poniżej."
        )

    def retry(variant_id, request: gr.Request, progress=gr.Progress()):
        session = get_session(request)
        if session is None:
            raise gr.Error("Najpierw rozpocznij generowanie zestawu.")
        if variant_id not in BY_ID:
            raise gr.Error("Wybierz ujęcie do ponownego wygenerowania.")
        try:
            session.generate_one(variant_id, engine, retry=True, progress=lambda p: progress(p, desc="Nowe ujęcie"))
        except Exception as error:
            raise gr.Error(str(error)) from error
        return session.gallery(), session.archive(), f"Gotowe: {len(session.records)}/10 · nowe ujęcie: {BY_ID[variant_id].label}"

    def release(request: gr.Request):
        # Release references on disconnect; retain generated files for local recovery.
        sessions.pop(request.session_hash, None)

    def stop(request: gr.Request):
        session = get_session(request)
        if session is not None:
            session.stop_requested.set()
        return "Zatrzymam generowanie po bieżącym ujęciu. Gotowe zdjęcia zostaną zachowane."

    with gr.Blocks(title="Nexus · Studio portretów", analytics_enabled=False) as demo:
        gr.Markdown("# Nexus · Studio portretów\nJedna osoba. Dziesięć emocji i póz.")
        gr.Markdown(
            "Wgraj ostre zdjęcie **jednej osoby**, bez filtrów, z dobrze widoczną twarzą. "
            "Do póz z rękami najlepiej użyć zdjęcia całej sylwetki. Opcjonalnie dodaj jeszcze "
            "dwa zdjęcia tej samej osoby. Ubiór pochodzi z pierwszego zdjęcia."
        )
        with gr.Row():
            with gr.Column(scale=1):
                photos = gr.File(label="Zdjęcia źródłowe · 1–3 pliki", file_count="multiple",
                                 file_types=[".jpg", ".jpeg", ".png", ".webp"], type="filepath")
                size = gr.Radio(choices=[("Portret · 1024 × 1536", "1024x1536"),
                                         ("Kwadrat · 1024 × 1024", "1024x1024"),
                                         ("Poziomo · 1536 × 1024", "1536x1024")],
                                value="1024x1536", label="Format")
                background = gr.Radio(choices=[("Zachowaj tło", "original"), ("Szare studio", "studio")],
                                      value="original", label="Tło")
                with gr.Accordion("Ustawienia zaawansowane", open=False):
                    steps = gr.Slider(20, 60, value=40, step=1, label="Kroki generowania",
                                      info="Więcej kroków oznacza dłuższe obliczenia; nie gwarantuje lepszego zdjęcia.")
                    seed = gr.Number(value=42, precision=0, minimum=0, maximum=2147483647, label="Seed zestawu")
                start = gr.Button("Wygeneruj 10 zdjęć", variant="primary")
                stop_button = gr.Button("Zatrzymaj po bieżącym ujęciu")
                gr.Markdown("Zdjęcia powstają na GPU obsługującym studio. Zapis: PNG bez stratnej kompresji.")
            with gr.Column(scale=2):
                status = gr.Textbox(value="Czekam na zdjęcie.", label="Postęp", interactive=False)
                gallery = gr.Gallery(label="Twój zestaw", columns=2, height=650, format="png", interactive=False)
                download = gr.File(label="Pobierz zestaw ZIP", interactive=False)
                with gr.Row():
                    variant = gr.Dropdown(choices=[(v.label, v.id) for v in VARIANTS],
                                          value=VARIANTS[0].id, label="Ujęcie do poprawy")
                    regenerate = gr.Button("Wygeneruj to ujęcie ponownie")
        gr.Markdown(
            "**10 ujęć:** " + " · ".join(v.label for v in VARIANTS) +
            "\n\nModel stara się zachować wygląd osoby, lecz wynik wymaga oceny. "
            "Nie stosujemy automatycznego wygładzania ani zmiany rysów twarzy."
        )
        start.click(generate, [photos, size, background, steps, seed], [gallery, download, status],
                    concurrency_limit=1, concurrency_id="portrait-gpu", api_visibility="private")
        regenerate.click(retry, [variant], [gallery, download, status], concurrency_limit=1,
                         concurrency_id="portrait-gpu", api_visibility="private")
        stop_button.click(stop, outputs=status, queue=False, api_visibility="private")
        demo.unload(release)
    demo.queue(max_size=4, default_concurrency_limit=1)
    return demo


def main():
    parser = argparse.ArgumentParser(description="Nexus portrait studio")
    parser.add_argument("--share", action="store_true", help="Authenticated temporary Gradio link")
    parser.add_argument("--port", type=int, default=7861)
    args = parser.parse_args()
    password = os.getenv("NEXUS_PORTRAIT_PASSWORD", "")
    if args.share and len(password) < 12:
        parser.error("--share requires NEXUS_PORTRAIT_PASSWORD with at least 12 characters")
    build_app().launch(server_name="127.0.0.1", server_port=args.port, share=args.share,
                       auth=("nexus", password) if password else None,
                       max_file_size="20mb", show_error=False)


if __name__ == "__main__":
    main()
