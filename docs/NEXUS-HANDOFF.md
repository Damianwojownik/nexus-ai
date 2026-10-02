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

1. GitHub Copilot CLI
2. OpenAI Codex CLI
3. Google Gemini API if configured
4. Claude Code CLI
5. OpenAI API if configured
6. Anthropic API if configured
7. local Ollama fallback from the frontend ModelRouter

If cloud quota/credits fail, `ModelRouter` catches the provider failure and falls through to local Ollama. Memory and project context are assembled by `NexusAgent` before provider routing, so the same context is used regardless of provider.

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

Run `scripts/connect-ai-stack-windows.ps1` to verify cloud providers, Ollama, search, weather and connector health.

## External apps / connectors

The Agent Hub now exposes a connector registry:
- built-in GitHub connector via authenticated local `gh` CLI
- additional MCP-over-HTTPS connectors from `NEXUS_CONNECTORS_JSON`
- connector tokens are referenced by environment-variable name and stay server-side
- non-read-only MCP actions require explicit confirmation
- POST connector actions are restricted to the local Nexus frontend

Important files:
- `helpers/connectorRegistry.ts`
- `helpers/connectorClient.ts`
- `docs/CONNECTORS.md`

This is the foundation for Canva-class and other external apps. Do not invent provider endpoints or reuse ChatGPT plugin credentials; configure each service with its official MCP/OAuth/API endpoint.

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

## Resume instruction for a new session

Start by reading this file, then inspect the latest commit and the exact files relevant to the requested task. Do not assume local services are running. Verify before claiming a provider, internet, Ollama or avatar backend is connected.
