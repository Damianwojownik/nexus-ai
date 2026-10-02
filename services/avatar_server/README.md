# Nexus self-hosted avatar server

This bridge connects Nexus to FasterLivePortrait without HeyGen.

## Windows / GTX 970 path

Run:

```bat
scripts\\connect-avatar-server-windows.bat
```

The script:
- reuses `vendor/FasterLivePortrait` and the existing Python venv,
- uses `configs/onnx_infer.yaml` instead of the upstream TensorRT-only API,
- creates a random local bearer token,
- stores `NEXUS_AVATAR_SERVER_URL=http://127.0.0.1:9872` and `NEXUS_AVATAR_SERVER_TOKEN` as user environment variables,
- starts the Nexus avatar bridge,
- verifies `/health`.

Restart Nexus/Agent Hub after the first run so the new process can read the environment variables.

## API

Authenticated with either:

```
Authorization: Bearer <NEXUS_AVATAR_SERVER_TOKEN>
```

or `X-Nexus-Token`.

Endpoints:
- `GET /health` and `GET /v1/health`
- `POST /animate`, `POST /v1/animate`, `POST /v1/render`

Animation requests are multipart form data. Supply `source_image` (or `image`) plus either `audio`/`driving_audio` for a talking face or `driving_video` for motion transfer. The response is `video/mp4`.

The bridge deliberately keeps the token out of source control.
