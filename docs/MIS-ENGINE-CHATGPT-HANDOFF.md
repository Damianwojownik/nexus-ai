# ChatGPT Miś Engine handoff

Branch: `chatgpt/mis-engine-v1`

Status: TEST / EXPERIMENTAL.

## Isolation

- `main` is untouched.
- Codex may continue working on its own branch.
- This branch was forked from the Miś test work and is now the ChatGPT-owned integration branch.
- Do not merge automatically. Compare and cherry-pick deliberately after both branches stop moving.

## ChatGPT-owned additions

### Shared-clock control
- `helpers/misEngine/runtime.ts`
- `helpers/misEngine/motionAdapter.ts`

One timestamp drives:
- phoneme,
- articulation,
- existing Nexus blink/gaze/head/breath motion,
- haptic cue.

### Renderer coordination
- `helpers/misEngine/mediaRenderer.ts`
- `helpers/misEngine/renderCoordinator.ts`

Routing:
- live -> FasterLivePortrait with `subjectMode: animal`
- quality -> Nexus/Codex FLP + LTX + compositor
- quality falls back to animal FasterLivePortrait when the media backend is unavailable

Vidu remains an optional benchmark/fallback and is not the owner of phoneme logic.

### Real audio alignment
- `helpers/misEngine/phonemeAligner.ts`
- `helpers/misEngine/phoneNormalization.ts`
- `services/phoneme_aligner/mis_phoneme_aligner.py`
- `services/phoneme_aligner/README.md`

Agent Hub routes:
- `GET /api/mis/aligner/health`
- `POST /api/mis/align`

First aligner backend:
- Montreal Forced Aligner
- Polish: `polish_mfa`
- English: `english_us_mfa` dictionary/G2P + `english_mfa` acoustic
- German: `german_mfa`

The MFA phone set is normalized before it enters the Miś articulation controller.

### Expanded articulation/haptics
Added coverage for aligned-phone variants including:
- `tʃ`, `dʒ`
- `ts`, `dz`
- `c`, `ɟ`
- `aʊ`
- common MFA diacritic variants such as `s̪`, `t̪`, aspirated and palatalized phones.

## Validation state

Implemented:
- Node unit tests for PL/EN/DE fallback behavior,
- coarticulation,
- haptic classes,
- identity-reference contract,
- shared-clock runtime,
- renderer selection/fallback,
- MFA phone normalization.
- CI syntax check for Python avatar and phoneme-aligner services.

Not yet claimed:
- real GPU FasterLivePortrait render on target hardware,
- real LTX render on target hardware,
- live MFA alignment execution on the user's machine,
- clinical/SLP validation of PL/EN/DE articulation targets,
- production-grade identity embedding.

GitHub Actions status was not yet observable through the connected status endpoint at the time of this handoff. Do not state that CI passed until a run result is visible.

## Next integration gate

When Codex finishes its current branch:
1. compare Codex branch against `chatgpt/mis-engine-v1`,
2. keep the strongest media/render implementations,
3. retain Miś-specific phoneme/articulation/haptic/aligner contracts,
4. resolve duplicates by adapter rather than copying engines twice,
5. run `npm run test:mis` and `npm run build`,
6. run one real MFA PL sample and one real animal FasterLivePortrait sample,
7. only then consider a selective merge toward `main`.


## Unified Miś pipeline

Connected on the ChatGPT branch:

- `GET /api/mis/health` — combined aligner + live/quality renderer health.
- `POST /api/mis/align` — audio + transcript -> aligned phoneme timeline.
- `POST /api/mis/render` — `live` routes to animal FasterLivePortrait; `quality` routes to Nexus Media Engine (FLP + LTX + compositor) with live fallback.
- `helpers/misEngine/sessionClient.ts` — one application-level call starts render and alignment from the same audio, then creates articulation, Nexus motion and haptic frames from the aligned timeline.

## Direct articulation injection v1

Implemented and CI-validated on this branch:

- aligned phonemes are converted into deterministic articulation control points before render,
- the same source audio still generates natural JoyVASA motion,
- Miś Engine applies conservative corrections to FasterLivePortrait expression motion before rendering,
- corrections are limited to the upstream lip expression region and currently control:
  - jawOpen,
  - lipWide,
  - lipRound,
  - lipProtrusion,
  - lipPress,
- the controlled FLP face is preserved through the FLP + LTX quality compositor,
- live and quality render paths receive the same articulation controls.

Important boundary:
- tongueX, tongueY, tongueTip, teethGap, voicing, airflow and nasal remain deterministic Miś control/teaching/haptic channels but are NOT yet directly rendered by FasterLivePortrait.
- upstream FasterLivePortrait's learned face-retargeting UI is human-only for retargeting; Miś v1 therefore injects into the audio-generated motion/expression trajectory instead of claiming animal retarget-network support.
- the expression projection is experimental and requires visual calibration on the canonical teddy before therapeutic validation.

## CI validation

Draft PR #11 is TEST-only and must not be merged automatically.

Latest validated workflow:
- npm ci: PASS
- npm run test:mis: PASS
- Python syntax compilation for avatar server, articulation injector, phoneme aligner, media worker and media engine: PASS
- npm run build (TypeScript + Vite): PASS

GPU inference itself is still not claimed as validated by CI because GitHub Actions does not run the FasterLivePortrait/LTX GPU models.
