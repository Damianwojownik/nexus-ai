# Nexus Agent Hub

Nexus uses GitHub as the shared source of truth for code while agents may execute in different environments. Nexus owns durable memory and coordination state; models and agents are replaceable workers.

## Runtime API

`createAgentHubServer(hub)` in `helpers/agentHubServer.ts` creates a Node HTTP server around the existing `AgentHub`. Run the local host from the repository root with:

```powershell
node --experimental-strip-types helpers/agentHubRuntime.ts
```

The runtime binds to `127.0.0.1:8788` by default and persists state under `%LOCALAPPDATA%/NexusAI`. The imported-file workspace is `%LOCALAPPDATA%/NexusAI/workspace` by default.
Set `NEXUS_AGENT_HUB_HOST`, `NEXUS_AGENT_HUB_PORT`, `NEXUS_AGENT_HUB_STATE`, `NEXUS_WORKSPACE_DIR` or comma-separated `NEXUS_AGENT_HUB_ALLOWED_ORIGINS` to override those defaults. The browser client uses `http://127.0.0.1:8788`; set `VITE_NEXUS_AGENT_HUB_URL` in `.env.local` to use another host.

The UI registers the actual `nexus-ui` agent, heartbeats it every 15 seconds, fetches agents/tasks from the API, and consumes new events over SSE. Native reconnect is not assumed: the client retries with bounded exponential backoff. The server allows local browser origins and HTTPS `*.sandbox.floot.app` origins, including Private Network Access preflight. Keep the service on loopback unless authentication and an explicit origin policy are added.

- `GET /api/health` reports server health.
- `GET /api/speech/health` reports whether the optional Polish Piper model/runtime files are installed.
- `POST /api/speech/synthesize` accepts `{ "text": "..." }` (1-6000 characters) and returns `audio/wav` with no-store caching. Speech endpoints reject non-loopback browser origins. A single bounded CPU worker handles one utterance at a time; request disconnection cancels it, server closure stops it, and five idle minutes release its memory. Missing voice files return 503; invalid input returns 400. Runtime errors are surfaced, not replaced with another voice. Install via `scripts\install-nexus-voice.ps1`, then restart the Hub.
- `GET /api/ai/health` reports GPT/Codex, Copilot, Claude, Gemini and Ollama provider state without returning credentials.
- `POST /api/ai/generate` routes text generation through cloud CLIs/Gemini and falls back to CPU Ollama on provider limits or outages unless the JSON body specifies `allowLocalFallback: false`.
- `POST /api/ai/stream` streams response chunks as server-sent events and propagates client cancellation.
- `POST /api/image/generate` accepts `{ "prompt": "..." }` and securely proxies the generated PNG from the configured Nexus Image Engine. It is available only to loopback browser origins and requires the server-only `NEXUS_IMAGE_SERVER_URL` and `NEXUS_IMAGE_SERVER_TOKEN`. Use an HTTPS endpoint for remote engines; credentials are never sent to the browser.

Both AI POST endpoints accept the optional boolean `allowLocalFallback` (default `true`). When false, no local provider health check, generation or streaming is attempted. The desktop UI permits fallback only after health confirms CPU-only Ollama (`ollamaCpuOnly: true`) and an installed model. The default Hub sends `num_gpu: 0` for both Ollama request types. Other clients retain the existing default fallback. `/api/ai/health` returns `gemini`, `ollama`, aggregate `cloud`, `ollamaCpuOnly` and a `providers` map. Codex/Claude health checks their CLI login; Copilot health uses a short harmless generation probe, cached for 60 seconds. Successful login does not guarantee available quota.
- `GET /api/capabilities` lists capabilities and connector health; `POST /api/capabilities/:id` executes a registered capability.
- `GET` and `POST /api/agents` list and register agents; `POST /api/agents/:id/heartbeat` updates presence.
- `GET` and `POST /api/tasks` list and submit tasks; `GET /api/tasks/:id` reads a task.
- `POST /api/tasks/:id/claim` and `/lease` claim or lease work.
- `GET /api/events` returns recent events as JSON. With `Accept: text/event-stream`, it streams new events over SSE.
- `GET /api/search?q=...` performs DuckDuckGo web search and returns source URLs/snippets.
- `POST /api/workspace/import` stores one file up to 10 MB in the configured workspace; path segments and executable/installer extensions are rejected, and existing files are not overwritten.
- `GET /api/install/catalog`, `POST /api/install` and `GET /api/install/:id` expose the Windows `winget` allowlist and asynchronous operation status. Every start requires `confirmed: true`, and the endpoint rejects browser origins other than loopback. No arbitrary package IDs or shell commands are accepted.

The browser exposes search, import and install controls. Installation is disabled when `winget` is missing; the runtime will not install the package manager or another app without the individual UI confirmation. This machine currently has no `winget`, so installation execution is not verified. Search and workspace import have been exercised against the live local runtime.

The hub persists its task, agent and recent-event snapshot through its configured state file. Task leases prevent a second agent from claiming work while the current lease is active.

## AI providers and connectors

The server-side AI provider registry uses `GEMINI_API_KEY` only in the Agent Hub process. `GEMINI_MODEL` defaults to `gemini-2.5-flash`. The local Ollama adapter uses `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) and automatically selects an installed lightweight model, preferring Qwen, Gemma and Mistral before larger Llama models. Set `OLLAMA_MODEL` to force an installed model. No model is downloaded automatically.

Official global Windows CLIs `@openai/codex`, `@github/copilot` and `@anthropic-ai/claude-code` provide cloud chat through their own terminal logins. Run `codex login`, `copilot login` or `claude auth login` outside the UI. Each generation uses a temporary empty directory removed afterwards; Codex is read-only and ephemeral, Claude/Copilot disable tools. No API tokens are returned to the browser.

Quota/credits/points exhaustion places that provider in cooldown and the current request tries another cloud provider, then CPU Ollama if allowed. Rate limits use a shorter cooldown. Fallback events log provider IDs and status only, never prompts or credentials. CLI failures are classified without exposing raw diagnostic output; Nexus cannot inspect account balances.

The capability registry currently includes local web search and read-only GitHub operations. Set `NEXUS_GITHUB_TOKEN` in the Hub process to enable the GitHub connector; tokens are only sent in server-side authorization headers. The registry is designed to resolve a requested capability to an available connector rather than binding orchestration to a vendor.

## Coordination contract

Each work item has an owner, status, scope and touched paths. Statuses: TODO, WORKING, BLOCKED, DONE. Agents claim work before editing, avoid overlapping paths, and push completed stages for review.

The local Vite UI has been verified in a real browser against the running Hub: it registers `nexus-ui`, displays real presence/tasks, submits/claims/leases work, renders SSE events, and shows CONNECTED, DISCONNECTED and ERROR/recovery states. The client integration test also drops active SSE connections, verifies automatic reconnect, and receives a subsequent event. Keep the hosted Floot deployment separate until its runtime URL and local-network access are configured there; do not infer hosted deployment success from local verification.
