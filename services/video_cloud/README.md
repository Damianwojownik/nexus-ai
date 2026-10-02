# Nexus Video Cloud Engine

Warstwa orkiestracji do własnej generacji wideo na GPU.

## Założenie

Nexus -> Video Cloud API -> Redis -> router -> własne workery GPU -> storage/CDN.

Silnik sam nie nakłada limitu liczby generacji. Fizyczne limity nadal wynikają z mocy GPU, miejsca na dysku, transferu i kosztu infrastruktury.

## Obsługiwane klasy zadań

- text-to-video
- image-to-video
- speech-to-video
- character-animate

Router potrafi kierować zadania do:
- Wan2.2
- HunyuanVideo

Oficjalne otwarte stosy oferują obecnie m.in. T2V/I2V, warianty audio-driven i character animation, więc są dobrym fundamentem pod własną chmurę.

## Start orkiestratora

```bash
cd services/video_cloud
docker compose up -d
curl http://localhost:8080/health
```

## Podłączenie workerów GPU

```bash
export NEXUS_VIDEO_WAN_URL=http://wan-worker:9001
export NEXUS_VIDEO_HUNYUAN_URL=http://hunyuan-worker:9002
docker compose up -d
```

Każdy worker GPU ma wystawiać:

`POST /generate`

i przyjmować JSON z promptem, trybem, rozdzielczością, FPS, długością, seedem oraz opcjonalnym image_url/audio_url.

Odpowiedź:

```json
{
  "video_url": "https://storage.example/result.mp4",
  "poster_url": "https://storage.example/poster.jpg",
  "metadata": {"model": "wan2.2"}
}
```

## Jakość

Długie filmy należy generować scenami/ujęciami, zachowując reference frame/character identity między ujęciami, a następnie składać timeline. To daje stabilniejszy rezultat niż pojedyncza bardzo długa generacja.

## "Bez limitów"

To oznacza brak sztucznego limitu kredytowego po stronie Nexus. Nie oznacza nieskończonej ani darmowej mocy obliczeniowej. Przy własnych workerach możesz skalować system, dodając kolejne GPU.
