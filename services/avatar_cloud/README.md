# Nexus Avatar Cloud v0.1

This is the vendor-neutral cloud layer for the Nexus live avatar stack.

## What exists now

- authenticated FastAPI gateway,
- engine registry and health fan-out,
- talking-head route,
- dedicated lip-sync route,
- full-body route,
- stable session contract for future WebRTC,
- explicit GPU machine profiles,
- local/self-hosted fallback remains available,
- Vidu remains optional as a benchmark rather than a hard dependency.

## Target engine topology

1. FasterLivePortrait-class worker: portrait motion and talking head.
2. MuseTalk-class worker: high-fidelity mouth/lip-sync pass.
3. EchoMimic-class worker: larger face/head/body motion.
4. Shared editing worker later: style transfer, subject replacement, background replacement, try-on.
5. Nexus gateway owns routing, failover, health, auth and session identity.

The repository does not claim proprietary Vidu weights or architecture. Public/open models are used as replaceable implementations behind Nexus-owned contracts.

## Required environment

- NEXUS_CLOUD_AVATAR_TOKEN
- NEXUS_LIVEPORTRAIT_URL
- NEXUS_MUSETALK_URL
- NEXUS_ECHOMIMIC_URL

Optional:
- NEXUS_ENGINE_EDITOR=1
- NEXUS_EDITOR_URL

## Deployment

The gateway can run on a small CPU machine. GPU workers should run independently on NVIDIA GPU nodes so they can scale and restart without taking Nexus offline.

See ../../infra/avatar-cloud/machines.yaml.
