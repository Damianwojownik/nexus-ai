# Miś Engine v1 — TEST / EXPERIMENTAL

Branch: `test/mis-engine-v1`

This branch is isolated from `main`. The original Nexus implementation remains unchanged.

## Reused engines

- FasterLivePortrait bridge from Nexus: fast audio-driven portrait renderer.
- Codex Nexus Media Engine from `nexus/media-engine-v1-20261003`:
  - FasterLivePortrait face stage,
  - LTX-Video body/image-to-video stage,
  - ffmpeg compositor,
  - Colab L4 bootstrap.
- Nexus cloud speech/video adapters.
- Existing Nexus Vidu S2 provider remains available as an external benchmark/fallback.

## New Miś-specific engines

- `helpers/misEngine/phonemeEngine.ts`
  - PL/EN/DE estimated fallback,
  - adapter boundary for true audio-aligned phonemes.
- `helpers/misEngine/articulationEngine.ts`
  - jaw/lips/tongue/teeth/voicing/airflow/nasal parameters,
  - anticipatory and carry-over coarticulation.
- `helpers/misEngine/hapticsEngine.ts`
  - phoneme-synchronised phone and physical-teddy haptic cues.
- `helpers/misEngine/identityLock.ts`
  - stable multi-reference identity contract for the teddy.
- `helpers/misEngine/rendererRegistry.ts`
  - live vs quality renderer selection.
- `helpers/misEngine/benchmark.ts`
  - audio-mouth lag, identity drift and articulation error metrics.
- `helpers/misEngine/index.ts`
  - shared-clock orchestrator.

## FasterLivePortrait bear mode

The test avatar bridge now supports `auto | human | animal`.
Miś media worker defaults to `animal` through `NEXUS_AVATAR_SUBJECT_MODE`.

The bridge also avoids deleting a shared FasterLivePortrait output directory after a request.

## Validation

- Unit test file: `helpers/misEngine/misEngine.test.ts`.
- Command: `npm run test:mis`.
- GitHub workflow: `.github/workflows/mis-engine-test.yml`.
- GPU render execution is NOT claimed as verified until run on the target GPU runtime.

## Important boundary

Estimated text-to-phoneme output is a fallback, not true phoneme alignment.
For speech-training use, production mode must consume real audio-aligned phone timings and be validated by qualified speech-language specialists for each language.

This branch is a technical prototype and is not a diagnostic or therapeutic medical device.
