# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The Vite frontend routes prompts through `NexusAgent` and `ModelRouter`. The local Agent Hub hosts the Gemini adapter and the automatic free Ollama fallback; the browser never receives provider credentials. Voice input, browser TTS and avatar selection remain in place.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Run locally

Install dependencies with `npm install`. Copy `.env.example` to `.env.local` if overrides are needed. The local defaults are Ollama at `http://127.0.0.1:11434` and Agent Hub at `http://127.0.0.1:8788`; `qwen2.5:1.5b` is preferred when installed because it is a better fit for a 4 GB GPU than larger local models.

Optional Gemini access is configured only in the Agent Hub process environment with `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`). Do not put the key in any `VITE_*` variable. When a configured cloud provider reports a quota, rate limit, outage or transient failure, Nexus immediately routes the current request to an available local model; quota and rate-limit failures trigger a cooldown to avoid repeatedly retrying an exhausted provider. No Copilot model/API integration is present in this repository, so Nexus can only react to a quota error if a real provider adapter reports one.

The Agent Hub also exposes a capability registry for local web search and read-only GitHub discovery, file reading, code search, branches, commits, pull requests, issues and release assets. GitHub access is optional and uses the server-only `NEXUS_GITHUB_TOKEN`.

Start the local services in separate terminals:

```powershell
npm run hub
npm run dev
```

Open `http://127.0.0.1:5173/`. The Hub stores runtime state under the user's local app data directory when started by the current Windows setup.

## Local capabilities

- Web search runs through DuckDuckGo from the local Hub and returns clickable source links/snippets.
- File import accepts one file up to 10 MB into `%LOCALAPPDATA%/NexusAI/workspace` (or `NEXUS_WORKSPACE_DIR`). Executable/installer extensions are blocked; imports are never launched.
- Windows software installs are restricted to the Hub's approved `winget` catalog and require an explicit UI confirmation for every app. The installer is disabled if `winget` is unavailable; Nexus does not install a package manager automatically.
- The Primary Agent remains `NOT_CONFIGURED`. No remote ChatGPT or Copilot bridge is enabled.
- FasterLivePortrait is a separate ONNX renderer for audio/video-driven clip generation; its upstream WebUI is not a real-time streaming camera/avatar API.

The local runtime API and provider/capability endpoints are documented in `docs/AGENT-HUB.md`. Avatar renderer limitations are documented in `architecture/VOICE-AVATAR.md`.
