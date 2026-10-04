# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The Vite frontend is runnable locally and has been exercised in a browser against the real Agent Hub runtime. The existing conversation UI routes prompts through `NexusAgent`, `ModelRouter` and the local Ollama provider; voice input, browser TTS and avatar selection remain in place. The UI uses real Agent Hub HTTP/SSE for presence, task submission/claim/lease, task lists and live events.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Run locally

On Windows the Hub's CLI bridges invoke the installed `.cmd` launchers rather than PowerShell `.ps1` shims, so they do not require changing the system execution policy. Child stdin is closed to prevent non-interactive CLI calls waiting for additional input. CLI version health checks prove installation only; verify generation separately. `/api/chatgpt/status` reports direct ChatGPT authorization independently of Codex login. A valid sign-in URL does not mean the user has completed authorization.

Install dependencies with `npm install`. Configure `VITE_OLLAMA_BASE_URL` and `VITE_NEXUS_AGENT_HUB_URL` in `.env.local`; this machine's safe local defaults are `http://127.0.0.1:11435` and `http://127.0.0.1:8788`.

Recommended on Windows: run the one-click launcher:

```powershell
scripts\\start-nexus-windows.bat
```

It installs/updates the local dependencies when needed, starts/validates Ollama, Agent Hub and the Vite frontend, then checks ChatGPT-plan/provider status, web search and weather. Manual startup still works:

```powershell
npm run hub
npm run dev
```

Open `http://127.0.0.1:5173/`. The Hub stores runtime state under the user's local app data directory when started by the current Windows setup.

### Optional Claude development tools

See [Claude tooling setup and diagnostics](docs/CLAUDE-TOOLING.md) for Claude Code,
loopback-only OmniRoute, optional Headroom compression and Task Observer.
These development tools do not replace Nexus runtime or block startup when offline.

To use the user's eligible ChatGPT plan as the primary model, open Nexus, connect the Browser Bridge, and choose **Continue with ChatGPT**. The OAuth callback is loopback-only on `127.0.0.1:8788`; the access/refresh credentials remain local.

## Local capabilities

- Web search runs through DuckDuckGo from the local Hub and returns clickable source links/snippets.
- File import accepts one file up to 10 MB into `%LOCALAPPDATA%/NexusAI/workspace` (or `NEXUS_WORKSPACE_DIR`). Executable/installer extensions are blocked; imports are never launched.
- Windows software installs are restricted to the Hub's approved `winget` catalog and require an explicit UI confirmation for every app. The installer is disabled if `winget` is unavailable; Nexus does not install a package manager automatically.
- The local Agent Hub supports opt-in **Continue with ChatGPT**. For eligible ChatGPT plans, the plan provider is first in AUTO routing, followed by Codex/Copilot/other configured providers and Ollama.
- ChatGPT OAuth credentials are stored only in the local NexusAI app-data directory; Floot does not receive them.
- The ChatGPT plan connection starts new Nexus conversations. It does not import existing ChatGPT conversation history or native ChatGPT memory; durable continuity is owned by Nexus memory.

## Next task

Configure and verify the same frontend/runtime values in the hosted Floot deployment if that environment is required. The local end-to-end path is documented in `docs/AGENT-HUB.md`.


## Continue in a new AI session

Read `docs/NEXUS-HANDOFF.md` first. It records the current architecture, provider fallback, internet endpoints, memory behavior and avatar work so a new session can resume without relying on chat history.
