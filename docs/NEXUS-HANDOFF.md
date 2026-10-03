# Nexus handoff

This file is the durable handoff for continuing Nexus work in a new ChatGPT/Codex session.

## Source of truth

- GitHub repository: `Damianwojownik/nexus-ai`
- Do not modify Ezostylia when working on Nexus unless the user explicitly asks.
- Floot project ID used by the visual prototype: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Product goal

Nexus is one embodied AI interface. The user talks to Nexus; orchestration, providers, tools, memory, GitHub, web access and installers stay behind the scenes. Ask for approval only for actions that genuinely require it.

## Provider routing

Current intended AUTO routing:

1. OpenAI Codex CLI signed in with the user's ChatGPT account
2. GitHub Copilot CLI
3. Google Gemini API if configured
4. Claude Code CLI
5. OpenAI API if configured
6. Anthropic API if configured
7. local Ollama fallback from the frontend ModelRouter

When Floot/runtime cloud quota is unavailable, the local Agent Hub should prefer Codex CLI so Nexus can use the user's ChatGPT/Codex plan allowance before trying Copilot and other providers. If the local provider stack fails, `ModelRouter` can still fall through to local Ollama. Memory and project context are assembled by `NexusAgent` before provider routing, so the same context is used regardless of provider.

Important files:
- `helpers/cloudProviders.ts`
- `helpers/modelRouter.ts`
- `helpers/ollamaClient.ts`
- `helpers/hubCloudProvider.ts`
- `helpers/nexusAgent.ts`

## Internet

The local Agent Hub already exposes:
- `GET /api/search?q=...` -> DuckDuckGo HTML search
- `GET /api/weather?q=...` -> Open-Meteo geocoding + forecast

The orchestrator recognizes web-search and weather intents and injects live results into the prompt instead of guessing.

Important files:
- `helpers/agentHubServer.ts`
- `helpers/localCapabilities.ts`
- `helpers/localCapabilitiesClient.ts`
- `helpers/nexusOrchestrator.ts`

Run `scripts/connect-ai-stack-windows.ps1` to verify cloud providers, Ollama, search and weather.

## One-click Windows startup

Use:

```powershell
scripts\start-nexus-windows.bat
```

It:
- starts Ollama if installed and not already listening,
- detects a usable installed local model,
- starts Agent Hub on 127.0.0.1:8788,
- starts the Vite frontend on 127.0.0.1:5173,
- runs cloud/internet/fallback diagnostics,
- opens Nexus in the browser.

It does not install packages or expose secrets.

## Memory

Nexus application memory is provider-independent:
- browser build: localStorage via `BrowserMemoryBackend`
- server/local workflow: `.nexus-memory.json` via `FileSystemMemoryBackend`

Important file:
- `helpers/memoryStore.ts`

## Avatar

The repo contains avatar motion, viseme and self-hosted avatar bridge work. FasterLivePortrait setup scripts are present for Windows. The user wants a realistic talking face, not a primitive mannequin.

Important files:
- `helpers/avatarMotion.ts`
- `helpers/visemeEngine.ts`
- `helpers/selfHostedAvatarServer.ts`
- `services/avatar_server/nexus_avatar_server.py`
- `scripts/setup-faster-liveportrait-windows.ps1`

## Image Engine

Nexus now has the first real self-hosted image-generation vertical slice in GitHub:

- `services/image_server/nexus_image_server.py` — authenticated FLUX.1-schnell FastAPI service with lazy model loading, warm reuse, CPU offload, seed control and 1–4 step generation.
- `helpers/selfHostedImageServer.ts` — Agent Hub server-side adapter.
- `GET /api/image/health` and `POST /api/image/generate` — binary image bridge through the local Agent Hub.
- `helpers/nexusImageIntent.ts` — natural-language image intent and square/portrait/landscape routing.
- `helpers/nexusOrchestrator.ts` — requests such as “Wygeneruj obraz kobiety siedzącej…” route to the image engine instead of only returning text.
- `pages/_index.tsx` — displays the returned generated image directly in Nexus.
- `helpers/nexusImageIntent.test.ts` and `helpers/nexusImageHub.test.ts` cover intent routing and the Agent Hub binary proxy.

Validation after implementation: image-intent tests passed 3/3, image-hub proxy test passed 1/1, and `npm run build` completed successfully against the current GitHub main branch.

Important limitation: this proves the Nexus code path and proxy, not a real FLUX GPU render. Do not mark the image engine GPU-ready until `NEXUS_IMAGE_SERVER_URL` / `NEXUS_IMAGE_SERVER_TOKEN` point at a real CUDA service and an actual PNG has been generated end-to-end.

## Resume instruction for a new session

### Portrait Studio — 2026-10-03

The user's new request is one uploaded person photo → ten separate images with
different expressions, eye states and arm poses, with high visual quality.
`services/portrait_studio/` adds a standalone Polish Gradio studio using
Qwen-Image-Edit-2511. Every variant and retry uses the original reference photos.
It supports 1–3 references, PNG/ZIP export, per-image progress, graceful stop after
the current image, partial-result recovery and individual retries. The new
`notebooks/Nexus_Portrait_Studio.ipynb` launches an authenticated Colab UI.

Validation: 8 CPU tests passed with Gradio 6.17.3, including UI callbacks, output
archives, failed renders, retries, session isolation and input validation. The
dependency resolver found a compatible package set; notebook code cells compile.
There is **no real GPU render or visual-quality validation yet**. Both full and
4bit loading need GPU smoke tests. This is a separate studio, not integrated into
the main chat UI. The screenshot's `Nexus_Colab_Kaggle.ipynb` is not in this repo;
do not claim it was modified. No paid image API or existing video pipeline was
configured. See `services/portrait_studio/README.md` for resources and run steps.

Start by reading this file, then inspect the latest commit and the exact files relevant to the requested task. Do not assume local services are running. Verify before claiming a provider, internet, Ollama or avatar backend is connected.
