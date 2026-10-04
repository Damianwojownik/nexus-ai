# Miś Engine v1 — TEST / EXPERIMENTAL

> Status: techniczny prototyp badawczy. Nie jest wyrobem medycznym, narzędziem diagnostycznym ani zwalidowaną terapią. Parametry fonetyczne PL/EN/DE wymagają przeglądu logopedy/fonetyka przed użyciem terapeutycznym.

## Cel

Z jednego lub kilku zdjęć tej samej postaci utrzymać stabilną tożsamość misia i sterować jego mową w sposób bardziej kontrolowalny niż zwykły generatywny lip-sync.

## Reużyte silniki z Nexus

- `helpers/avatarMotion.ts` — mruganie, spojrzenie, głowa, oddech, body sway.
- `helpers/selfHostedAvatarServer.ts` + `services/avatar_server/nexus_avatar_server.py` — FasterLivePortrait bridge.
- istniejący Agent Hub — bezpieczny transport render requestów.
- Vidu S2 pozostaje opcjonalnym benchmarkiem/providerem; logika fonetyczna Miś Engine nie jest od niego zależna.

## Nowe moduły Miś Engine

- `types.ts` — wspólny kontrakt fonemów, artykulacji, haptyki i identity.
- `phonemeEngine.ts` — PL/EN/DE fallback G2P + kontrakt dla prawdziwych aligned phones.
- `phonemeAligner.ts` — adapter do lokalnego alignera audio→phoneme timestamps.
- `articulationEngine.ts` — jaw/lips/tongue/teeth/voicing/airflow + koartykulacja.
- `hapticsEngine.ts` — timeline wibracji z tego samego fonemu.
- `identityLock.ts` — profil referencji postaci; warstwa pod przyszły embedding/adapter tożsamości.
- `motionAdapter.ts` — wykorzystuje Nexus avatarMotion zamiast duplikować silnik.
- `runtime.ts` — jeden zegar dla ust, motion i haptyki.
- `rendererRegistry.ts` — wymienne backendy live/quality/benchmark.
- `benchmark.ts` — latency, mouth/audio correlation, identity drift i articulation error.
- `misEngine.test.ts` — testy PL/EN/DE, koartykulacji, haptyki, identity i runtime.

## Renderery

### Live
1. FasterLivePortrait — domyślny, self-hosted.
2. Vidu S2 — opcjonalny benchmark/fallback.

### Quality
1. Nexus media pipeline, gdy jest dostępny i zweryfikowany.
2. EchoMimic — opcjonalny; nie traktować jako poprawny dla misia bez testu animal/non-human.
3. FasterLivePortrait — fallback.

## Animal mode

Testowy avatar server obsługuje `mode=human|animal|auto`. Dla misia należy używać `animal` w testach porównawczych. Wynik renderu jest kopiowany do prywatnego katalogu requestu; cleanup nie usuwa wspólnego katalogu wyników FasterLivePortrait.

## Phoneme alignment

Tryb `estimated-text` służy wyłącznie do fallbacku i testów UI. Nie jest true lip-sync.

Tryb `aligned-audio` jest docelowy. `LocalPhonemeAligner` oczekuje lokalnej usługi:

- `GET /health`
- `POST /v1/align`
- wejście: language + transcript + audioBase64
- wyjście: `phones: [{ phoneme, startMs, endMs, confidence }]`

Backend alignera (np. MFA/CTC/Whisper-derived) musi zostać osobno uruchomiony i zweryfikowany na PL/EN/DE.

## Identity Lock

Obecny IdentityLock zarządza spójnym zestawem referencji i ich wagami. To jeszcze nie jest wytrenowany neural identity embedding. Docelowo renderer powinien dostać front + 3/4 left + 3/4 right i opcjonalne expression references.

## Walidacja przed użyciem

1. Uruchomić `npm run test:mis`.
2. Uruchomić `npm run build`.
3. Sprawdzić FasterLivePortrait human vs animal na tym samym zdjęciu misia.
4. Podłączyć prawdziwy aligner i odrzucić estimated timing w testach jakości.
5. Zmierzyć audio-mouth lag, identity drift i articulation MAE na nagraniu referencyjnym.
6. Zweryfikować profile fonetyczne z logopedą/fonetykiem PL/EN/DE.

## Bezpieczeństwo wersji

Całość jest rozwijana na branchu `test/mis-engine-v1`. `main` pozostaje wersją bezpieczną i nie powinien być mergowany automatycznie.
