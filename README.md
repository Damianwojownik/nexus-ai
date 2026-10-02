# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The Vite frontend is runnable locally and has been exercised in a browser against the real Agent Hub runtime. The existing conversation UI routes prompts through `NexusAgent`, `ModelRouter` and the local Ollama provider; voice input, browser TTS and avatar selection remain in place. The UI uses real Agent Hub HTTP/SSE for presence, task submission/claim/lease, task lists and live events.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Run locally

Install dependencies with `npm install`. Configure `VITE_OLLAMA_BASE_URL` and `VITE_NEXUS_AGENT_HUB_URL` in `.env.local`; this machine's safe local defaults are `http://127.0.0.1:11435` and `http://127.0.0.1:8788`.

Recommended on Windows: run the one-click launcher:

```powershell
scripts\\start-nexus-windows.bat
```

It starts/validates Ollama, Agent Hub, the Vite frontend and then checks AI providers, web search and weather. Manual startup still works:

```powershell
npm run hub
npm run dev
```

Open `http://127.0.0.1:5173/`. The Hub stores runtime state under the user's local app data directory when started by the current Windows setup.

## Local capabilities

- Web search runs through DuckDuckGo from the local Hub and returns clickable source links/snippets.
- File import accepts one file up to 10 MB into `%LOCALAPPDATA%/NexusAI/workspace` (or `NEXUS_WORKSPACE_DIR`). Executable/installer extensions are blocked; imports are never launched.
- Windows software installs are restricted to the Hub's approved `winget` catalog and require an explicit UI confirmation for every app. The installer is disabled if `winget` is unavailable; Nexus does not install a package manager automatically.
- External applications can be discovered through the Agent Hub connector registry. GitHub works through the local authenticated `gh` CLI; additional apps can be added through MCP-over-HTTPS manifests without exposing their tokens to the browser. See `docs/CONNECTORS.md`.
- The Primary Agent remains `NOT_CONFIGURED`. No remote ChatGPT credentials or connection are enabled.

## Next task

Configure and verify the same frontend/runtime values in the hosted Floot deployment if that environment is required. The local end-to-end path is documented in `docs/AGENT-HUB.md`.


## Continue in a new AI session

Read `docs/NEXUS-HANDOFF.md` first. It records the current architecture, provider fallback, internet endpoints, connector layer, memory behavior and avatar work so a new session can resume without relying on chat history.
