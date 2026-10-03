# Cel jakości i porównanie z Suno

Stan rozpoznania: 2026-10-03. Celem użytkownika jest brzmienie lepsze niż Suno.
Nie mamy nagrań porównawczych ani własnych wyników oceny modelu — nie ogłaszamy
osiągnięcia tego celu. Obudowanie istniejącego modelu interfejsem nie zmienia jego
wyuczonych zdolności muzycznych.

Oficjalne informacje Suno opisują rodzinę v6, edycję fragmentów i tekstu piosenki
oraz Studio 2.0 z MIDI, efektami, syntezą i automatyką. To szerszy produkt niż
ten moduł Nexusa. Źródło: [Suno Release Notes](https://suno.com/release-notes).

| Obszar | Ten moduł Nexusa | Weryfikacja |
| --- | --- | --- |
| Opis → wokal/instrumental | ACE-Step, własny lub przygotowany tekst | Kontrakt API; odsłuch GPU jeszcze nieprzeprowadzony |
| Kontrola | BPM, tonacja, czas, model, seed, planowanie LM | Testy przesyłanych parametrów |
| Odsłuch | Dwa warianty i osobna kopia po normalizacji | Testy panelu i eksportu |
| Sygnał | WAV/FLAC, pomiary próbek, EBU R128 | Prawdziwy FFmpeg na tonie testowym |
| Reprodukcja projektu | JSON, seedy, model, tekst, odzyskanie zadania | Testy bez ponownego generowania |
| Brzmienie lepsze od Suno | Niepotwierdzone | Wymaga porównania rzeczywistych nagrań |
| MIDI, multitrack, stem editing | Niezaimplementowane | Nie udajemy pełnego DAW |

Silnik wybrano ze względu na możliwość samodzielnego uruchomienia i interfejs
obsługujący tekst, wokal oraz instrumental. Nie dlatego, że dowiedliśmy jego
przewagi nad Suno. Używane endpointy: `/release_task`, `/query_result`, `/v1/audio`,
`/v1/models`, `/v1/create_sample`. Schematy sprawdzono w
[oficjalnym API](https://ace-step.github.io/ACE-Step-1.5/en/API) i źródłach ACE-Step
commita `ca1e85fe9430179831e6bc6be790c332190a3866`.

## Jak uczciwie sprawdzić lepsze brzmienie

1. Przygotować 12 opisów: po 2 z popu, soulu, rocka, elektroniki, akustyki i muzyki
   filmowej. W części wokalnej użyć identycznych własnych tekstów, w tym polskich.
2. W obu systemach zamówić ten sam czas, tempo i tonację. Zachować wszystkie
   wygenerowane warianty; nie wybierać tylko najlepszych wyników jednego systemu.
3. Użyć plików bezstratnych, jeśli dostępne, i porównać przy podobnej głośności.
   Głośniejsze nagranie nie musi brzmieć lepiej. Zachować surowe oryginały.
4. Losowo oznaczyć nagrania A/B, bez nazw silników. Kilku słuchaczy ocenia
   zrozumiałość śpiewu, artefakty, kompozycję, separację instrumentów i dynamikę.
5. Zapisać wyniki oraz porażki, a osobno czas generacji i zużycie GPU. Nie
   przeliczać samego RMS lub sample peak na „jakość muzyczną”.

Przed pierwszym testem GPU: sprawdzić model Base i LM 1.7B, krótki instrumental,
krótki polski wokal, dwie wersje, ZIP i normalizację. Dopiero potem zwiększać czas.
Jeśli jakość wokalu lub aranżacji nie spełnia celu, potrzebny będzie inny model,
dostrajanie albo rzeczywista praca na ścieżkach; sam eksport 24-bit tego nie naprawi.

Normalizacja korzysta z [FFmpeg loudnorm](https://ffmpeg.org/ffmpeg-filters.html#loudnorm).
Może zmienić głośność i dynamikę, ale nie odtwarza utraconych szczegółów nagrania.
