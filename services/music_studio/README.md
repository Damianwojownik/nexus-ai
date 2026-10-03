# Nexus · Music Studio

Program do tworzenia piosenek i instrumentali, inspirowany przepływem pracy Suno.
Panel Nexusa łączy się z **własnym serwerem ACE-Step 1.5**. Nie korzysta z API Suno,
nie trenuje nowego modelu i nie ma potwierdzonej przewagi brzmienia nad Suno.

## Co można zrobić

- Opisać gatunek, instrumenty, nastrój, wokal i rozwój aranżacji.
- Utworzyć szkic tekstu oraz aranżacji przez model językowy, poprawić go ręcznie
  i dopiero wtedy wygenerować audio. Obsługiwany wybór polskiego języka.
- Tworzyć utwory z własnym tekstem lub instrumentale, 15–300 sekund, 30–300 BPM.
- Wybrać tonację, seed, model Base/SFT/Turbo i jedną albo dwie wersje do odsłuchu.
- Pobierać oryginały WAV/FLAC i ZIP projektu, z parametrami oraz metadanymi wyniku.
- Zatrzymać **oczekiwanie** w panelu, a potem odebrać to samo zadanie bez ponownej
  generacji. Plik `project.json` pozwala odzyskać wynik także po restarcie panelu,
  dopóki zadanie i pliki istnieją na tym samym serwerze ACE-Step.
- Sprawdzić sample rate, kanały, kodowanie, sample peak, RMS, ciszę i liczbę próbek
  bliskich pełnej skali. Są to pomiary sygnału, nie ocena estetyki lub wokalu.
- Utworzyć **osobną kopię** z dwupassową normalizacją EBU R128 przez FFmpeg:
  cel −16 LUFS, −1 dBTP, LRA 11, zapis PCM 24-bit z oryginalnym sample rate.
  Raport pokazuje uzyskane pomiary i tryb normalizacji. FFmpeg może użyć trybu
  dynamicznego, gdy liniowy nie spełnia ograniczeń. Oryginał pozostaje bez zmian.

Normalizacja nie naprawia artefaktów śpiewu, nie poprawia kompozycji i nie odzyskuje
informacji z przesterowanego źródła. Zwiększenie bit depth nie tworzy nowych detali.
Base/64 kroki to profil dający kontrolę nad generacją, nie obietnica wygranej z Turbo.

## Najprościej: Colab

Otwórz [`Nexus_Music_Studio.ipynb`](../../notebooks/Nexus_Music_Studio.ipynb), wybierz
GPU i uruchom komórki po kolei. Notebook tworzy osobne środowisko silnika poprzez
`uv sync --frozen` oraz chroniony hasłem panel. Kod ACE-Step jest przypięty do
commita `ca1e85fe9430179831e6bc6be790c332190a3866`.

Instalacja i pierwszy start pobierają duże pakiety oraz modele. Potrzebne są GPU,
RAM, wolny dysk i internet. Warianty, długi utwór oraz LM zwiększają zużycie pamięci.
Nie uruchamiaj jednocześnie dużego generatora wideo/zdjęć na tym samym GPU.
Przy OOM zmniejsz czas do 30–60 s, wybierz jedną wersję i użyj offloadu; ewentualnie
uruchom mniejszy LM 0.6B. Brak opłat API nie oznacza darmowego GPU w każdym planie.

**Nie wykonano jeszcze generacji GPU w tym środowisku.** Zgodność sterownika,
ładowanie modeli i jakość śpiewu należy sprawdzić na docelowym GPU.

## Lokalnie — dwa procesy, osobne środowiska

1. Zainstaluj serwer według [oficjalnej instrukcji ACE-Step](https://github.com/ace-step/ACE-Step-1.5).
   Z katalogu ACE-Step uruchom `uv sync --frozen`, a potem `uv run acestep-api`.
   Preferuj wskazany wyżej commit, na którym sprawdzono kontrakt API.
2. Ustaw konfigurację silnika przed uruchomieniem:

```text
ACESTEP_CONFIG_PATH=acestep-v15-base
ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B
ACESTEP_INIT_LLM=true
ACESTEP_LM_BACKEND=pt
ACESTEP_OFFLOAD_TO_CPU=true
ACESTEP_LM_OFFLOAD_TO_CPU=true
ACESTEP_API_HOST=127.0.0.1
ACESTEP_API_PORT=8001
ACESTEP_API_KEY=<własny silny token>
```

3. W osobnym środowisku Pythona, z katalogu Nexusa:

```bash
python -m pip install -r services/music_studio/requirements.txt
python -m services.music_studio.app
```

Panel: `http://127.0.0.1:7862`. W środowisku panelu ustaw:

| Zmienna | Znaczenie |
| --- | --- |
| `NEXUS_MUSIC_API_URL` | Domyślnie `http://127.0.0.1:8001`; zdalnie wymagane HTTPS |
| `NEXUS_MUSIC_API_TOKEN` | Ten sam token co `ACESTEP_API_KEY`; nigdy nie wpisuj go do repo |
| `NEXUS_MUSIC_OUTPUT` | Opcjonalny trwały katalog projektów; domyślnie katalog tymczasowy |
| `NEXUS_MUSIC_PASSWORD` | Hasło panelu; co najmniej 12 znaków wymagane z `--share` |

FFmpeg musi być w PATH do normalizacji; generowanie/eksport działa bez niego.
Nie instaluj zależności serwera ACE-Step w środowisku studia portretów — mają
osobne wymagania. Notebook muzyczny zapewnia tę separację.

## Zapis i odzyskiwanie

Każdy projekt ma osobny katalog. ZIP zawiera oryginały, opcjonalne kopie po
normalizacji i `project.json`. Ten JSON zawiera tekst i opis piosenki: traktuj go
jak część prywatnego projektu. Token silnika nie jest zapisywany w plikach.

Po przerwaniu oczekiwania wybierz **Odbierz wynik istniejącego zadania**. Po
restarcie panelu wczytaj pobrany `project.json`. Nie importujemy ścieżek audio z JSON;
pliki pobierane są z konkretnego serwera przez `/v1/audio`. Wygasłego zadania
nie da się odzyskać samym JSON — pobieraj ZIP przed końcem Colaba.

Timeout podczas `release_task` może oznaczać, że serwer przyjął zadanie, ale nie
odesłał identyfikatora. Program nie ponawia automatycznie takiego żądania.

## Weryfikacja

```bash
python -m pip install pytest
python -m pytest services/music_studio/test_music.py -q
```

Testy korzystają z lokalnego symulatora API i tonu testowego, **nie muzyki AI**.
Sprawdzają wysłanie/polling/pobranie, seedy i tekst, brak automatycznego ponawiania
generacji, odzyskiwanie, ZIP, odrzucanie obcych adresów/niepoprawnego audio,
callbacki panelu i rzeczywiste przetwarzanie FFmpeg. GPU nie jest potrzebne.
W tej sesji przeszło 13 testów, uruchomiony panel zwrócił HTTP 200 dla strony
i konfiguracji, a wszystkie komórki kodu notebooka skompilowały się.

## Granice wersji

To oddzielne studio, jeszcze bez przycisku w głównym czacie Nexusa. Nie ma
multitrack DAW, edycji MIDI, klonowania głosu, separacji stemów ani podmiany fragmentu
utworu. Porównanie z Suno i plan odsłuchów: [SUNO-COMPARISON.md](SUNO-COMPARISON.md).
