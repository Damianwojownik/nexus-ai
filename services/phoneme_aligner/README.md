# Miś Phoneme Aligner — TEST / EXPERIMENTAL

Local forced-alignment service for Miś Engine v1.

It accepts:
- audio,
- exact transcript,
- language: `pl`, `en` or `de`,

and returns phone-level timestamps used by the articulation and haptic engines.

This is a technical prototype. It is not clinically validated.

## Backend

The first backend is Montreal Forced Aligner (MFA). Miś Engine talks only to the local HTTP contract, so MFA can later be replaced without changing the rest of the application.

Current model routing:

| Language | Dictionary | Acoustic | G2P |
|---|---|---|---|
| Polish | `polish_mfa` | `polish_mfa` | `polish_mfa` |
| English (US) | `english_us_mfa` | `english_mfa` | `english_us_mfa` |
| German | `german_mfa` | `german_mfa` | `german_mfa` |

Model names can be overridden with `MIS_MFA_*_DICTIONARY`, `MIS_MFA_*_ACOUSTIC` and `MIS_MFA_*_G2P`.

## Install

Use a dedicated environment. One example with Conda/Mamba:

```bash
conda create -n mis-aligner -c conda-forge python=3.11 montreal-forced-aligner ffmpeg fastapi uvicorn pydantic
conda activate mis-aligner
```

Download the models once:

```bash
mfa model download dictionary polish_mfa
mfa model download acoustic polish_mfa
mfa model download g2p polish_mfa

mfa model download dictionary english_us_mfa
mfa model download acoustic english_mfa
mfa model download g2p english_us_mfa

mfa model download dictionary german_mfa
mfa model download acoustic german_mfa
mfa model download g2p german_mfa
```

## Run

Set an optional shared token:

```bash
export MIS_ALIGNER_TOKEN="replace-with-a-random-secret"
python services/phoneme_aligner/mis_phoneme_aligner.py
```

Default address: `http://127.0.0.1:9873`.

Configure Agent Hub:

```bash
export MIS_ALIGNER_URL="http://127.0.0.1:9873"
export MIS_ALIGNER_TOKEN="same-secret"
```

## API

### `GET /health`

Reports whether MFA and FFmpeg are available.

### `POST /v1/align`

JSON:

```json
{
  "language": "pl",
  "transcript": "Mama ma misia.",
  "audioBase64": "<base64 WAV/MP3>",
  "audioMime": "audio/wav"
}
```

Response:

```json
{
  "ok": true,
  "provider": "montreal-forced-aligner",
  "language": "pl",
  "phones": [
    {"phoneme": "m", "startMs": 0, "endMs": 82, "confidence": 1.0}
  ]
}
```

The numeric `confidence` currently means that the interval was accepted from MFA output; it is **not** a calibrated per-phone posterior probability.

## Nexus routes

Agent Hub proxies the local service:

- `GET /api/mis/aligner/health`
- `POST /api/mis/align`

The browser therefore does not need direct access to the MFA service.

## Important

The text-derived fallback in `helpers/misEngine/phonemeEngine.ts` remains useful for UI previews, but production speech-training tests should use `aligned-audio` phone timing.

Before therapeutic use, phone inventories and articulation targets must be reviewed for PL/EN/DE by qualified speech-language specialists.
