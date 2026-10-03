# Nexus · Studio portretów

Wgraj 1–3 zdjęcia tej samej osoby i wygeneruj **10 osobnych PNG**: neutralnie,
lekki uśmiech, szeroki uśmiech, smutek, oczy zamknięte, oczy otwarte, ręce na boki,
ręce w górę, skrzyżowane ręce, machanie. Panel pokazuje postęp, pozwala zatrzymać
serię po bieżącym zdjęciu, pobrać ZIP i ponowić pojedyncze ujęcie z nowym seedem.

Każde ujęcie korzysta z **oryginalnych zdjęć**, nigdy z poprzedniej generacji.
Pierwsze zdjęcie określa ubranie i wygląd. Dodatkowe zdjęcia są referencjami twarzy.
Zdjęcie całej sylwetki znacznie ułatwia pozy rąk. Zdjęcie samej twarzy nie zawiera
informacji o niewidocznym ubiorze i ciele — model musi je wtedy odtworzyć.

## Uruchom w Colabie

Otwórz [`notebooks/Nexus_Portrait_Studio.ipynb`](../../notebooks/Nexus_Portrait_Studio.ipynb).
Notebook instaluje zależności w środowisku GPU i uruchamia panel z hasłem.
Kod jest na gałęzi `feat/portrait-studio`; notebook używa tej samej gałęzi.

To osobny moduł projektu. Nie zastępuje aktualnego silnika tekst → obraz,
nie jest jeszcze przyciskiem w głównym czacie Nexusa i nie modyfikuje notebooka
`Nexus_Colab_Kaggle.ipynb` widocznego na zdjęciu — tego pliku nie ma w repozytorium.

## Uruchom lokalnie

Z katalogu głównego repozytorium, Python 3.10+ i działający PyTorch CUDA:

```bash
python -m pip install -r services/portrait_studio/requirements.txt
python -m services.portrait_studio.app
```

Otwórz `http://127.0.0.1:7861`. Brak klucza OpenAI i opłat API za zdjęcie;
obliczenia GPU, wynajem środowiska i pobieranie modeli mogą kosztować.
Nie uruchamiaj jednocześnie innych dużych modeli w tym samym GPU.

## Pamięć i jakość

Model: `Qwen/Qwen-Image-Edit-2511` przez `QwenImageEditPlusPipeline`.
Domyślnie 40 kroków, CFG 4.0, oryginalne referencje i zapis PNG.
Rozmiary: 1024×1536, 1536×1024 lub 1024×1024. Manifest zapisuje rzeczywiste
wymiary zwrócone przez model. Nie ma pozornego „4K” przez rozciągnięcie obrazu.

Zmienne środowiskowe przed startem:

| Zmienna | Domyślnie | Możliwe wartości |
| --- | --- | --- |
| `NEXUS_PORTRAIT_PROFILE` | `full` | `full`: BF16/FP16; `4bit`: NF4 dla transformera i enkodera tekstu |
| `NEXUS_PORTRAIT_OFFLOAD` | `sequential` | `sequential`: mniej VRAM, wolniej; `model`: całe komponenty na GPU; `none`: cały model na GPU |
| `NEXUS_PORTRAIT_PASSWORD` | brak | Hasło do panelu; minimum 12 znaków wymagane przy `--share` |

To duży model; pełna precyzja wymaga dziesiątek GB pamięci i miejsca na dysku.
Offload zmniejsza VRAM, ale wymaga RAM systemowego i wydłuża generowanie.
Profil 4bit zmniejsza pamięć kosztem kwantyzacji. Nie gwarantujemy dopasowania do
konkretnej karty (w szczególności GTX 970 lub standardowego Colaba).
Po zmianie profilu uruchom proces ponownie. Gdy zabraknie VRAM, spróbuj kwadratu,
profilu 4bit i offloadu sequential albo większego GPU/RAM.

## Zapis i prywatność

- Każda sesja ma osobny losowy katalog w tymczasowym katalogu systemu.
- Referencje są przetwarzane przez GPU środowiska, w którym działa panel.
- Oryginalne zdjęcia nie trafiają do ZIP; metadane EXIF są usuwane przed edycją.
- ZIP zawiera aktualne wybrane PNG oraz `manifest.json`: model, parametry,
  seedy, prompty, sumy kontrolne referencji i ewentualne błędy.
- Po błędzie można pobrać częściowy zestaw, wyraźnie oznaczony liczbą zdjęć.
- Poprzednie ujęcia pozostają na dysku; ZIP obejmuje tylko ostatni udany wariant.
- Pobierz wyniki przed końcem sesji Colaba. Pliki są tymczasowe; aplikacja
  nie wysyła ich automatycznie na Drive ani do GitHuba.
- Domyślnie panel nasłuchuje tylko lokalnie. `--share` tworzy zewnętrzny,
  tymczasowy link Gradio i wymaga hasła. Nie publikuj hasła wraz z linkiem.

## Co zostało sprawdzone

Testy CPU korzystają z jawnie sztucznego silnika i sprawdzają 10 plików,
oryginalne referencje przy każdym ujęciu, ZIP, częściowe błędy, ponowienia,
izolację sesji, EXIF, walidację wejścia i zbudowanie panelu bez ładowania modelu.

```bash
python -m pip install pytest
python -m pytest services/portrait_studio/test_core.py
```

**Do sprawdzenia na prawdziwym GPU:** pobranie i załadowanie modelu (także 4bit),
czas/pamięć, wygenerowanie 10 zdjęć i zgodność twarzy, oczu, dłoni oraz póz.
Nie ma automatycznego testu tożsamości ani rankingu estetyki. Instrukcje zachowania
wyglądu są wskazówką dla modelu, nie gwarancją. Najlepsze ujęcia wybiera człowiek;
przycisk ponowienia umożliwia poprawienie nietrafionych wyników.

## Źródła techniczne

- [Model i oficjalny przykład](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)
- [Diffusers: QwenImageEditPlusPipeline](https://huggingface.co/docs/diffusers/api/pipelines/qwenimage)
- [Kwantyzacja bitsandbytes](https://huggingface.co/docs/diffusers/quantization/bitsandbytes)
